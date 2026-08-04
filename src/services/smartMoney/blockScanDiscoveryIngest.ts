import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { ingestSmartMoneyRawAddresses } from './smartMoneyRawIngest';

/**
 * 扫块发现参数。晋级门槛 / 入库上限走环境变量（默认 5 笔 / $500 / 500 条），
 * 晋级（isQualified）与冷清理（pruneColdDiscoveries）共用同一套门槛，
 * 避免「晋级已放宽、清理仍按旧值」不一致。
 */
export const BLOCK_SCAN_DISCOVERY = {
  WINDOW_BLOCKS: 5000,
  get MIN_FILLS(): number {
    return CONFIG.smartMoneyBlockScanMinFills;
  },
  get MIN_NOTIONAL_USD(): number {
    return CONFIG.smartMoneyBlockScanMinNotionalUsd;
  },
  get INGEST_MAX_WALLETS(): number {
    return CONFIG.smartMoneyBlockScanIngestMax;
  },
  get FETCH_PRIORITY_SLOTS(): number {
    return CONFIG.smartMoneyBlockScanFetchPrioritySlots;
  },
  COLD_RETENTION_DAYS: 7,
} as const;

export const BLOCK_SCAN_DISCOVERY_STATUS = {
  ACCUMULATING: 'ACCUMULATING',
  PROMOTED: 'PROMOTED',
  SCORED: 'SCORED',
} as const;

export type BlockScanDiscoveryWalletInput = {
  wallet: string;
  fillCount: number;
  maxNotional: string;
  lastBlock: number;
};

export type BlockScanDiscoveryIngestInput = {
  chainId: number;
  fromBlock: number;
  toBlock: number;
  wallets: BlockScanDiscoveryWalletInput[];
};

export type BlockScanDiscoveryIngestStats = {
  received: number;
  accepted: number;
  newlyQualified: number;
  newlyPromoted: number;
  reactivated: number;
  prunedCold: number;
};

const UPSERT_BATCH_SIZE = 50;

function normalizeWallet(wallet: string): string | null {
  const normalized = wallet.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function parseNotional(value: string): Prisma.Decimal {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) {
    return new Prisma.Decimal(0);
  }
  return new Prisma.Decimal(trimmed);
}

function maxNotional(left: Prisma.Decimal, right: Prisma.Decimal): Prisma.Decimal {
  return left.gte(right) ? left : right;
}

function selectTopWalletsByNotional(
  rows: BlockScanDiscoveryWalletInput[],
  max: number
): BlockScanDiscoveryWalletInput[] {
  if (rows.length <= max) return rows;
  return [...rows]
    .sort((a, b) => {
      const cmp = parseNotional(b.maxNotional).comparedTo(parseNotional(a.maxNotional));
      if (cmp !== 0) return cmp;
      return b.fillCount - a.fillCount;
    })
    .slice(0, max);
}

function isQualified(windowFillCount: number, maxSingleNotional: Prisma.Decimal): boolean {
  if (maxSingleNotional.gte(BLOCK_SCAN_DISCOVERY.MIN_NOTIONAL_USD)) {
    return true;
  }
  if (windowFillCount < BLOCK_SCAN_DISCOVERY.MIN_FILLS) {
    return false;
  }
  const minWindow = CONFIG.smartMoneyBlockScanMinWindowNotionalUsd;
  if (minWindow > 0) {
    const windowEstimate = maxSingleNotional.mul(windowFillCount);
    return windowEstimate.gte(minWindow);
  }
  return true;
}

function applyWindow(
  existing: {
    windowStartBlock: number;
    windowFillCount: number;
    status?: string;
  } | null,
  lastBlock: number,
  incomingFillCount: number
): { windowStartBlock: number; windowFillCount: number } {
  if (!existing || existing.status === BLOCK_SCAN_DISCOVERY_STATUS.SCORED) {
    return { windowStartBlock: lastBlock, windowFillCount: incomingFillCount };
  }
  if (lastBlock - existing.windowStartBlock > BLOCK_SCAN_DISCOVERY.WINDOW_BLOCKS) {
    return { windowStartBlock: lastBlock, windowFillCount: incomingFillCount };
  }
  return {
    windowStartBlock: existing.windowStartBlock,
    windowFillCount: existing.windowFillCount + incomingFillCount,
  };
}

/**
 * SCORED 地址再活跃：刷新统计并保持 SCORED 状态。
 * raw 池唤醒由调用方批量执行（ingestSmartMoneyRawAddresses），
 * 不在此处逐钱包调用——那会导致每个钱包一次 raw 池 COUNT，整批超过上报方 HTTP 超时。
 */
async function reactivateScoredBlockScanDiscovery(
  wallet: string,
  now: Date,
  row: BlockScanDiscoveryWalletInput,
  existing: {
    maxSingleNotional: Prisma.Decimal;
  }
): Promise<void> {
  const incomingNotional = parseNotional(row.maxNotional);
  await prisma.blockScanDiscoveredTrader.update({
    where: { wallet },
    data: {
      lastSeenAt: now,
      lastBlockNumber: row.lastBlock,
      fillCount: { increment: row.fillCount || 1 },
      maxSingleNotional: maxNotional(existing.maxSingleNotional, incomingNotional),
      lastIngestAt: now,
      status: BLOCK_SCAN_DISCOVERY_STATUS.SCORED,
    },
  });
}

/** 冷清理为整表条件删除，无需每轮上报（约 16s 一次）都执行；限频到 10 分钟一次 */
let lastColdPruneAtMs = 0;
const COLD_PRUNE_MIN_INTERVAL_MS = 10 * 60_000;

async function pruneColdDiscoveriesThrottled(now: Date): Promise<number> {
  if (now.getTime() - lastColdPruneAtMs < COLD_PRUNE_MIN_INTERVAL_MS) {
    return 0;
  }
  lastColdPruneAtMs = now.getTime();
  return pruneColdDiscoveries(now);
}

async function pruneColdDiscoveries(now: Date): Promise<number> {
  const cutoff = new Date(
    now.getTime() - BLOCK_SCAN_DISCOVERY.COLD_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  const result = await prisma.blockScanDiscoveredTrader.deleteMany({
    where: {
      status: BLOCK_SCAN_DISCOVERY_STATUS.ACCUMULATING,
      qualifiedAt: null,
      lastSeenAt: { lt: cutoff },
      fillCount: { lt: BLOCK_SCAN_DISCOVERY.MIN_FILLS },
      maxSingleNotional: { lt: BLOCK_SCAN_DISCOVERY.MIN_NOTIONAL_USD },
    },
  });
  return result.count;
}

/** 评分成功写入后标记为已评分，保留记录便于再次活跃时直接开启 */
export async function markBlockScanDiscoveryScored(wallet: string): Promise<boolean> {
  const normalized = normalizeWallet(wallet);
  if (!normalized) return false;
  const now = new Date();
  const result = await prisma.blockScanDiscoveredTrader.updateMany({
    where: { wallet: normalized },
    data: {
      status: BLOCK_SCAN_DISCOVERY_STATUS.SCORED,
      scoredAt: now,
    },
  });
  return result.count > 0;
}

export async function ingestBlockScanDiscoveries(
  input: BlockScanDiscoveryIngestInput
): Promise<BlockScanDiscoveryIngestStats> {
  const now = new Date();
  const aggregated = new Map<string, BlockScanDiscoveryWalletInput>();

  for (const row of input.wallets) {
    const wallet = normalizeWallet(row.wallet);
    if (!wallet) continue;
    if (CONFIG.smartMoneyBlacklistWallets.includes(wallet)) continue;

    const fillCount = Math.max(0, Math.floor(row.fillCount));
    const lastBlock = Math.max(0, Math.floor(row.lastBlock));
    const maxNotionalValue = parseNotional(row.maxNotional);
    const existing = aggregated.get(wallet);
    if (!existing) {
      aggregated.set(wallet, {
        wallet,
        fillCount: fillCount || 1,
        maxNotional: maxNotionalValue.toFixed(6),
        lastBlock,
      });
      continue;
    }
    const existingNotional = parseNotional(existing.maxNotional);
    aggregated.set(wallet, {
      wallet,
      fillCount: existing.fillCount + (fillCount || 1),
      maxNotional: maxNotionalValue.gte(existingNotional) ? maxNotionalValue.toFixed(6) : existing.maxNotional,
      lastBlock: Math.max(existing.lastBlock, lastBlock),
    });
  }

  // 超上限时按名义金额降序取 TopN（同额按笔数），而不是按 Map 插入序无差别截断，避免大额地址被丢
  const wallets = selectTopWalletsByNotional(
    [...aggregated.values()],
    BLOCK_SCAN_DISCOVERY.INGEST_MAX_WALLETS
  );
  if (wallets.length === 0) {
    const prunedCold = await pruneColdDiscoveriesThrottled(now);
    return {
      received: input.wallets.length,
      accepted: 0,
      newlyQualified: 0,
      newlyPromoted: 0,
      reactivated: 0,
      prunedCold,
    };
  }

  const existingRows = await prisma.blockScanDiscoveredTrader.findMany({
    where: { wallet: { in: wallets.map((row) => row.wallet) } },
  });
  const existingByWallet = new Map(existingRows.map((row) => [row.wallet, row]));

  let newlyQualified = 0;
  let newlyPromoted = 0;
  let reactivated = 0;
  /** 待批量进 raw 池的地址：结束时一次 ingestSmartMoneyRawAddresses，容量 COUNT/淘汰只跑一次 */
  const rawPromotions: string[] = [];

  for (let i = 0; i < wallets.length; i += UPSERT_BATCH_SIZE) {
    const batch = wallets.slice(i, i + UPSERT_BATCH_SIZE);
    // 批内并发：不同 wallet 互不冲突，实际并发受连接池上限约束；串行 500 个在 2C2G 上会超上报方超时
    await Promise.all(
      batch.map(async (row) => {
        const existing = existingByWallet.get(row.wallet) ?? null;

        if (existing?.status === BLOCK_SCAN_DISCOVERY_STATUS.SCORED) {
          await reactivateScoredBlockScanDiscovery(row.wallet, now, row, existing);
          rawPromotions.push(row.wallet);
          reactivated += 1;
          return;
        }

        const incomingNotional = parseNotional(row.maxNotional);
        const window = applyWindow(existing, row.lastBlock, row.fillCount || 1);
        const maxSingleNotional = maxNotional(existing?.maxSingleNotional ?? new Prisma.Decimal(0), incomingNotional);
        const wasQualified = existing?.qualifiedAt != null;
        const nowQualified = isQualified(window.windowFillCount, maxSingleNotional);

        const upserted = await prisma.blockScanDiscoveredTrader.upsert({
          where: { wallet: row.wallet },
          create: {
            wallet: row.wallet,
            firstSeenAt: now,
            lastSeenAt: now,
            lastBlockNumber: row.lastBlock,
            fillCount: row.fillCount || 1,
            windowStartBlock: window.windowStartBlock,
            windowFillCount: window.windowFillCount,
            maxSingleNotional,
            qualifiedAt: nowQualified ? now : null,
            promotedAt: null,
            scoredAt: null,
            status: nowQualified
              ? BLOCK_SCAN_DISCOVERY_STATUS.PROMOTED
              : BLOCK_SCAN_DISCOVERY_STATUS.ACCUMULATING,
            lastIngestAt: now,
          },
          update: {
            lastSeenAt: now,
            lastBlockNumber: row.lastBlock,
            fillCount: { increment: row.fillCount || 1 },
            windowStartBlock: window.windowStartBlock,
            windowFillCount: window.windowFillCount,
            maxSingleNotional,
            lastIngestAt: now,
            ...(wasQualified
              ? {}
              : nowQualified
                ? {
                    qualifiedAt: now,
                    status: BLOCK_SCAN_DISCOVERY_STATUS.PROMOTED,
                  }
                : {}),
          },
        });

        if (!wasQualified && upserted.qualifiedAt != null) {
          newlyQualified += 1;
          rawPromotions.push(row.wallet);
          newlyPromoted += 1;
        } else if (
          upserted.qualifiedAt != null &&
          upserted.promotedAt == null &&
          upserted.status !== BLOCK_SCAN_DISCOVERY_STATUS.SCORED
        ) {
          rawPromotions.push(row.wallet);
          newlyPromoted += 1;
        }
      })
    );
  }

  if (rawPromotions.length > 0) {
    await ingestSmartMoneyRawAddresses(
      rawPromotions.map((wallet) => ({ wallet, source: 'BLOCK_SCAN' }))
    );
  }

  const prunedCold = await pruneColdDiscoveriesThrottled(now);

  return {
    received: input.wallets.length,
    accepted: wallets.length,
    newlyQualified,
    newlyPromoted,
    reactivated,
    prunedCold,
  };
}

export async function countBlockScanDiscoveryPendingScore(): Promise<number> {
  // JOIN 避免 pending 过多时 wallet IN (...) 超过 PG bind 参数上限 (P2029)
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "ObservedTrader" ot
    INNER JOIN "BlockScanDiscoveredTrader" bsd ON bsd."wallet" = ot."wallet"
    WHERE bsd."status" = ${BLOCK_SCAN_DISCOVERY_STATUS.PROMOTED}
      AND bsd."promotedAt" IS NOT NULL
      AND bsd."qualifiedAt" IS NOT NULL
      AND ot."candidateOrigin" = 'BLOCK_SCAN'
      AND ot."candidateActive" = true
      AND ot."lastFetchedAt" IS NULL
  `;
  return Number(rows[0]?.count ?? 0);
}

/** 供单元测试使用的纯函数出口 */
export const blockScanDiscoveryLogic = {
  normalizeWallet,
  parseNotional,
  isQualified,
  applyWindow,
  selectTopWalletsByNotional,
};
