/**
 * 拉式 RAW 补池独立 tick：优先队列 → 多源游标长尾 → BlockScan 配额。
 * 只读榜缓存；stale>1h 时尝试触发一次官方 sync（不持有长锁阻塞补池）。
 */
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { computeDiscoveryIngestBudget } from './smartMoneyDiscoveryBudget';
import { ingestSmartMoneyRawAddresses } from './smartMoneyRawIngest';
import {
  bumpShortfallStreak,
  consumePriorityQueue,
  cursorStepForShortfall,
  DISCOVERY_ALL_SOURCE,
  DISCOVERY_ANALYTICS_30D,
  DISCOVERY_PREDICTING_ALL,
  DISCOVERY_WEEK_SOURCE,
  getShortfallStreak,
  isOfficialLeaderboardCacheStale,
  OFFICIAL_CATEGORY_ALL_SOURCES,
  takeBoardCursorSlice,
} from './smartMoneyDiscoveryCursor';
import { BLOCK_SCAN_DISCOVERY_STATUS } from './blockScanDiscoveryIngest';
import { rawPoolActiveWhere } from './smartMoneyRawPoolActive';
import { canAttemptStrongRevive } from './smartMoneyEliminated';
import {
  finishSmartMoneyBatchRun,
  startSmartMoneyBatchRun,
} from './smartMoneyBatchObservability';
import { snapshotConsumableBacklog } from './smartMoneyConsumableBacklog';

async function countActiveRawPool(): Promise<number> {
  return prisma.smartMoneyRawAddress.count({ where: rawPoolActiveWhere });
}

async function filterIngestable(
  wallets: string[],
  options?: {
    allowEliminated?: boolean;
    breakCooldown?: boolean;
    reviveSource?: string;
    reviveSourceByWallet?: ReadonlyMap<string, string>;
  }
): Promise<string[]> {
  if (wallets.length === 0) return [];
  const cooldownMs = CONFIG.smartMoneyRawIngestCooldownDays * 24 * 60 * 60 * 1000;
  const cooldownCutoff = new Date(Date.now() - cooldownMs);
  const busyStages = new Set([
    'COPY_POOL',
    'SCORED',
    'QUALIFIED',
    'LIGHT_ANALYZING',
    'FULL_ANALYZING',
    'RAW',
    'BLOCKED',
  ]);

  const existing = await prisma.smartMoneyRawAddress.findMany({
    where: { wallet: { in: wallets } },
    select: {
      wallet: true,
      pipelineStage: true,
      dormant: true,
      lastIngestedAt: true,
      updatedAt: true,
      elimFrozenUntil: true,
      tierFailReason: true,
    },
  });
  const byWallet = new Map(existing.map((r) => [r.wallet, r]));
  const out: string[] = [];
  for (const wallet of wallets) {
    const row = byWallet.get(wallet);
    if (!row) {
      out.push(wallet);
      continue;
    }
    // 休眠由 RAW + dormant=true 表示，不是独立的 DORMANT stage。
    if (row.dormant && (row.pipelineStage === 'RAW' || row.pipelineStage === 'DORMANT')) {
      out.push(wallet);
      continue;
    }
    if (busyStages.has(row.pipelineStage)) continue;
    if (row.pipelineStage === 'ELIMINATED') {
      const source =
        options?.reviveSourceByWallet?.get(wallet) ?? options?.reviveSource ?? '';
      if (
        options?.allowEliminated &&
        canAttemptStrongRevive({
          source,
          updatedAt: row.updatedAt,
          elimFrozenUntil: row.elimFrozenUntil,
          tierFailReason: row.tierFailReason,
        })
      ) {
        out.push(wallet);
      }
      continue;
    }
    if (
      cooldownMs > 0 &&
      row.lastIngestedAt != null &&
      row.lastIngestedAt > cooldownCutoff &&
      !options?.breakCooldown
    ) {
      continue;
    }
    if (row.pipelineStage === 'DORMANT') out.push(wallet);
  }
  return out;
}

async function takeBlockScanQualified(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const selected: string[] = [];
  const selectedSet = new Set<string>();
  const pageSize = Math.max(100, limit * 3);
  const scanCap = Math.max(1_000, limit * 50);

  for (let skip = 0; skip < scanCap && selected.length < limit; skip += pageSize) {
    const take = Math.min(pageSize, scanCap - skip);
    const rows = await prisma.blockScanDiscoveredTrader.findMany({
      where: {
        OR: [
          { status: BLOCK_SCAN_DISCOVERY_STATUS.PROMOTED },
          {
            status: BLOCK_SCAN_DISCOVERY_STATUS.ACCUMULATING,
            qualifiedAt: { not: null },
          },
        ],
      },
      orderBy: [
        { maxSingleNotional: 'desc' },
        { fillCount: 'desc' },
        { wallet: 'asc' },
      ],
      skip,
      take,
      select: { wallet: true },
    });
    if (rows.length === 0) break;

    const filtered = await filterIngestable(
      rows.map((r) => r.wallet.trim().toLowerCase()),
      {
        allowEliminated: true,
        breakCooldown: true,
        reviveSource: 'REVIVE|BLOCKSCAN',
      }
    );
    for (const wallet of filtered) {
      if (selectedSet.has(wallet)) continue;
      selectedSet.add(wallet);
      selected.push(wallet);
      if (selected.length >= limit) break;
    }
    if (rows.length < take) break;
  }

  return selected;
}

async function maybeSyncStaleLeaderboardCache(): Promise<boolean> {
  const stale = await isOfficialLeaderboardCacheStale();
  if (!stale) return false;
  try {
    const { runLeaderboardSync } = await import('../cron/leaderboardCron.js');
    // fire-and-forget 风格：await 一次；内部有 syncRunning 防重入
    await runLeaderboardSync();
    return true;
  } catch (err) {
    console.warn('[smart-money-raw-refill] stale cache sync failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export type RawRefillTickResult = {
  activeRaw: number;
  slots: number;
  paused: boolean;
  fromPriority: number;
  fromBoard: number;
  fromBlockScan: number;
  ingested: number;
  created: number;
  refreshed: number;
  reactivated: number;
  skippedEliminated: number;
  shortfall: number;
  shortfallStreak: number;
  staleSyncTriggered: boolean;
};

/**
 * 独立补池 tick（默认每 2 分钟）。榜路径只读缓存；stale 时尝试 syncOnce。
 */
export async function runSmartMoneyRawRefillTick(): Promise<RawRefillTickResult | null> {
  if (!CONFIG.smartMoneyRawRefillCronEnabled) return null;

  const run = startSmartMoneyBatchRun('raw_refill', 'interval:raw-refill');
  const backlogBefore = await snapshotConsumableBacklog().catch(() => ({}));
  const staleSyncTriggered = await maybeSyncStaleLeaderboardCache();

  const activeRaw = await countActiveRawPool();
  const budget = computeDiscoveryIngestBudget({
    activeCount: activeRaw,
    maxActive: CONFIG.smartMoneyRawPoolMaxActive,
    perRun: CONFIG.smartMoneyDiscoveryIngestPerRun,
    refillLow: CONFIG.smartMoneyRawRefillLow,
    refillTarget: CONFIG.smartMoneyRawRefillTarget,
  });

  if (budget.paused || budget.slots <= 0) {
    await bumpShortfallStreak(0);
    const backlogAfter = await snapshotConsumableBacklog().catch(() => backlogBefore);
    finishSmartMoneyBatchRun(run, {
      picked: 0,
      succeeded: 0,
      backlogBefore,
      backlogAfter,
      extras: {
        activeRaw,
        slots: 0,
        paused: true,
        targetCap: budget.targetCap,
        staleSyncTriggered,
      },
    });
    return {
      activeRaw,
      slots: 0,
      paused: true,
      fromPriority: 0,
      fromBoard: 0,
      fromBlockScan: 0,
      ingested: 0,
      created: 0,
      refreshed: 0,
      reactivated: 0,
      skippedEliminated: 0,
      shortfall: 0,
      shortfallStreak: 0,
      staleSyncTriggered,
    };
  }

  const streak = await getShortfallStreak();
  const baseStep = Math.max(20, Math.floor(budget.slots * 2));
  const step = cursorStepForShortfall(streak, baseStep);

  const boardQuota = Math.max(0, Math.floor(budget.slots * CONFIG.smartMoneyRawRefillBoardShare));
  const blockQuota = Math.max(0, budget.slots - boardQuota);

  const priorityRaw = await consumePriorityQueue(boardQuota);
  const priorityStrong = priorityRaw.filter(
    (e) => e.reason.startsWith('REVIVE|') || e.reason === 'NEW'
  );
  // 带 reason 的 ingest source，既用于强唤醒，也用于选址阶段判断 3d/7d 冷却。
  const prioritySourceByWallet = new Map(
    priorityStrong.map((e) => [
      e.wallet,
      e.reason.startsWith('REVIVE|') ? e.reason : 'LEADERBOARD_REFILL',
    ])
  );
  const priorityWallets = await filterIngestable(
    priorityStrong.map((e) => e.wallet),
    {
      allowEliminated: true,
      breakCooldown: true,
      reviveSourceByWallet: prioritySourceByWallet,
    }
  );

  let boardNeed = Math.max(0, boardQuota - priorityWallets.length);
  const boardSources = [
    DISCOVERY_WEEK_SOURCE,
    DISCOVERY_ALL_SOURCE,
    ...OFFICIAL_CATEGORY_ALL_SOURCES,
    DISCOVERY_PREDICTING_ALL,
    DISCOVERY_ANALYTICS_30D,
  ];
  const fromBoardList: string[] = [];
  for (const source of boardSources) {
    if (boardNeed <= 0) break;
    const slice = await filterIngestable(await takeBoardCursorSlice({ source, step }));
    for (const w of slice) {
      if (boardNeed <= 0) break;
      if (priorityWallets.includes(w) || fromBoardList.includes(w)) continue;
      fromBoardList.push(w);
      boardNeed -= 1;
    }
  }

  const boardWallets = [...priorityWallets, ...fromBoardList].slice(0, boardQuota);
  const blockWallets = await takeBlockScanQualified(blockQuota);

  const toIngest = [...new Set([...boardWallets, ...blockWallets])].slice(0, budget.slots);
  let ingested = 0;
  let created = 0;
  let refreshed = 0;
  let reactivated = 0;
  let skippedEliminated = 0;
  if (toIngest.length > 0) {
    const boardSet = new Set(boardWallets);
    const boardIngest = toIngest.filter((w) => boardSet.has(w));
    const blockIngest = toIngest.filter((w) => !boardSet.has(w));
    if (boardIngest.length > 0) {
      const r = await ingestSmartMoneyRawAddresses(
        boardIngest.map((wallet) => ({
          wallet,
          source: prioritySourceByWallet.get(wallet) ?? 'LEADERBOARD_REFILL',
        }))
      );
      ingested += r.ingested;
      created += r.created;
      refreshed += r.refreshed;
      reactivated += r.reactivated;
      skippedEliminated += r.skippedEliminated;
    }
    if (blockIngest.length > 0) {
      const r = await ingestSmartMoneyRawAddresses(
        blockIngest.map((wallet) => ({ wallet, source: 'REVIVE|BLOCKSCAN' }))
      );
      ingested += r.ingested;
      created += r.created;
      refreshed += r.refreshed;
      reactivated += r.reactivated;
      skippedEliminated += r.skippedEliminated;
    }
  }

  const activeAfter = await countActiveRawPool();
  const shortfall = Math.max(0, budget.targetCap - activeAfter);
  const shortfallStreak = await bumpShortfallStreak(shortfall);
  if (shortfall > 0) {
    console.warn('[smart-money-raw-refill] shortfall', {
      activeRaw: activeAfter,
      target: budget.targetCap,
      shortfall,
      shortfallStreak,
      step,
      slots: budget.slots,
      ingested,
    });
  } else if (ingested > 0) {
    console.log('[smart-money-raw-refill] filled', {
      activeRaw: activeAfter,
      ingested,
      created,
      refreshed,
      reactivated,
      skippedEliminated,
      fromPriority: priorityWallets.length,
      fromBoard: boardWallets.length - priorityWallets.length,
      fromBlockScan: blockWallets.length,
      staleSyncTriggered,
    });
  }

  const backlogAfter = await snapshotConsumableBacklog().catch(() => backlogBefore);
  finishSmartMoneyBatchRun(run, {
    picked: toIngest.length,
    succeeded: ingested + reactivated,
    deferred: shortfall,
    backlogBefore,
    backlogAfter,
    backpressure: shortfall > 0,
    bottleneck: shortfall > 0 ? 'raw_shortfall' : budget.paused ? 'raw_paused' : null,
    extras: {
      activeRaw: activeAfter,
      slots: budget.slots,
      paused: false,
      targetCap: budget.targetCap,
      fromPriority: priorityWallets.length,
      fromBoard: Math.max(0, boardWallets.length - priorityWallets.length),
      fromBlockScan: blockWallets.length,
      ingested,
      created,
      refreshed,
      reactivated,
      skippedEliminated,
      shortfall,
      shortfallStreak,
      staleSyncTriggered,
    },
  });

  return {
    activeRaw: activeAfter,
    slots: budget.slots,
    paused: false,
    fromPriority: priorityWallets.length,
    fromBoard: Math.max(0, boardWallets.length - priorityWallets.length),
    fromBlockScan: blockWallets.length,
    ingested,
    created,
    refreshed,
    reactivated,
    skippedEliminated,
    shortfall,
    shortfallStreak,
    staleSyncTriggered,
  };
}
