/**
 * CopyPool 双通道复评：
 * - priority：rank≤DAILY_TOP_N 且今日尚未成功复评 → 抢占复评槽
 * - background：非 TopN（含 rank 空窗）cursor 连续轮转；TopN 有待办时暂停不前进
 */
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { upsertDiscoveryCursor, getDiscoveryCursor } from './smartMoneyDiscoveryCursor';
import { recordCopyPoolRescorePickMetric } from './smartMoneyCopyPoolRescoreMetrics';
import { reconcileCopyPoolPipelineState } from './smartMoneyCopyPoolConsistency';

export const COPY_POOL_BG_CURSOR_SOURCE = 'COPY_POOL_BG_CURSOR';
export const COPY_POOL_DAILY_META_SOURCE = 'COPY_POOL_DAILY_RESCORE_META';

export type CopyPoolRescoreChannel = 'priority' | 'background' | 'legacy';

type BgCursorMeta = {
  lastRank: number | null;
  lastWallet: string | null;
  updatedAt?: string;
  wrapped?: boolean;
};

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

/** YYYY-MM-DD in configured business TZ */
export function businessDayKey(now = new Date(), timeZone = CONFIG.smartMoneyCopyPoolDailyTz): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function isScoredOnBusinessDay(
  lastScoredAt: Date | null | undefined,
  now = new Date(),
  timeZone = CONFIG.smartMoneyCopyPoolDailyTz
): boolean {
  if (lastScoredAt == null) return false;
  return businessDayKey(lastScoredAt, timeZone) === businessDayKey(now, timeZone);
}

export function isDualChannelRescoreMode(): boolean {
  return CONFIG.smartMoneyCopyPoolRescoreMode === 'dual_channel';
}

/** dual_channel 成功后写入非零冷却（F5）；TopN 用短冷却，background 用长冷却 */
export function computeDualChannelNextDeepAnalyzeAt(
  now = new Date(),
  channel: CopyPoolRescoreChannel = 'background'
): Date {
  const ms =
    channel === 'priority'
      ? CONFIG.smartMoneyCopyPoolPriorityRescoreMs
      : CONFIG.smartMoneyCopyPoolBgRescoreMs;
  return new Date(now.getTime() + ms);
}

function parseBgCursor(meta: Record<string, unknown> | null): BgCursorMeta {
  const lastRankRaw = meta?.lastRank;
  const lastRank =
    typeof lastRankRaw === 'number' && Number.isFinite(lastRankRaw) ? Math.trunc(lastRankRaw) : null;
  const lastWallet =
    typeof meta?.lastWallet === 'string' && meta.lastWallet.trim()
      ? normalizeWallet(meta.lastWallet)
      : null;
  return {
    lastRank,
    lastWallet,
    updatedAt: typeof meta?.updatedAt === 'string' ? meta.updatedAt : undefined,
    wrapped: meta?.wrapped === true,
  };
}

export async function loadBackgroundCursor(): Promise<BgCursorMeta> {
  const state = await getDiscoveryCursor(COPY_POOL_BG_CURSOR_SOURCE);
  return parseBgCursor(state.meta);
}

export async function saveBackgroundCursor(cursor: BgCursorMeta): Promise<void> {
  await upsertDiscoveryCursor({
    source: COPY_POOL_BG_CURSOR_SOURCE,
    cursor: cursor.lastWallet ?? '0',
    meta: {
      lastRank: cursor.lastRank,
      lastWallet: cursor.lastWallet,
      updatedAt: new Date().toISOString(),
      wrapped: cursor.wrapped === true,
    },
  });
}

/**
 * TopN 今日未复评（以 LeaderboardRow.lastScoredAt 的业务日为完成标记）。
 * 尊重 nextDeepAnalyzeAt 短冷却。
 */
export async function pickPriorityTopNDue(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const topN = CONFIG.smartMoneyCopyPoolDailyTopN;
  const now = new Date();

  const lbRows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: {
      inCopyPool: true,
      rank: { gte: 1, lte: topN },
    },
    orderBy: [{ rank: 'asc' }, { wallet: 'asc' }],
    select: { wallet: true, rank: true, lastScoredAt: true },
  });

  const dueWallets = lbRows
    .filter((row) => !isScoredOnBusinessDay(row.lastScoredAt, now))
    .map((row) => normalizeWallet(row.wallet));
  if (dueWallets.length === 0) return [];

  const rawRows = await prisma.smartMoneyRawAddress.findMany({
    where: {
      wallet: { in: dueWallets },
      pipelineStage: 'COPY_POOL',
      dormant: false,
      OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],
    },
    select: { wallet: true },
  });
  const eligible = new Set(rawRows.map((r) => normalizeWallet(r.wallet)));

  const ordered: string[] = [];
  for (const wallet of dueWallets) {
    if (!eligible.has(wallet)) continue;
    ordered.push(wallet);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

export async function countPriorityTopNDue(now = new Date()): Promise<number> {
  const topN = CONFIG.smartMoneyCopyPoolDailyTopN;
  const lbRows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: {
      inCopyPool: true,
      rank: { gte: 1, lte: topN },
    },
    select: { wallet: true, lastScoredAt: true },
  });
  const dueWallets = lbRows
    .filter((row) => !isScoredOnBusinessDay(row.lastScoredAt, now))
    .map((row) => normalizeWallet(row.wallet));
  // SLA/优先欠债必须按前端在榜 TopN 计算，不能因 Raw 缺行/阶段漂移而静默少算。
  // 实际选址前由 reconcileCopyPoolPipelineState 自动补建并对齐。
  return dueWallets.length;
}

type BgRow = {
  wallet: string;
  rank: number | null;
};

/**
 * 非 TopN（含 rank 空窗）按 (rank ASC NULLS FIRST, wallet) 从 cursor 后续取。
 * 无 rank 优先于已排名尾部，便于尽快进入正式 flush。
 * 无更多行时回到头部并再取一轮。
 */
export async function pickBackgroundFromCursor(limit: number): Promise<{
  wallets: string[];
  advanced: boolean;
  wrapped: boolean;
}> {
  if (limit <= 0) return { wallets: [], advanced: false, wrapped: false };
  const topN = CONFIG.smartMoneyCopyPoolDailyTopN;
  const now = new Date();
  const cursor = await loadBackgroundCursor();

  const fetchAfter = async (after: BgCursorMeta, take: number): Promise<BgRow[]> => {
    if (after.lastWallet == null && after.lastRank == null) {
      return prisma.$queryRaw<BgRow[]>`
        SELECT ra.wallet, lb.rank
        FROM "SmartMoneyRawAddress" ra
        INNER JOIN "SmartMoneyLeaderboardRow" lb ON lb.wallet = ra.wallet
        WHERE ra."pipelineStage" = 'COPY_POOL'
          AND ra.dormant = false
          AND lb."inCopyPool" = true
          AND (lb.rank IS NULL OR lb.rank > ${topN})
          AND (ra."nextDeepAnalyzeAt" IS NULL OR ra."nextDeepAnalyzeAt" <= ${now})
        ORDER BY lb.rank ASC NULLS FIRST, ra.wallet ASC
        LIMIT ${take}
      `;
    }

    const lastRank = after.lastRank;
    const lastWallet = after.lastWallet ?? '';
    if (lastRank == null) {
      // cursor 在 NULL rank 段：继续同段更后的 wallet，然后进入 rank > topN
      return prisma.$queryRaw<BgRow[]>`
        SELECT ra.wallet, lb.rank
        FROM "SmartMoneyRawAddress" ra
        INNER JOIN "SmartMoneyLeaderboardRow" lb ON lb.wallet = ra.wallet
        WHERE ra."pipelineStage" = 'COPY_POOL'
          AND ra.dormant = false
          AND lb."inCopyPool" = true
          AND (lb.rank IS NULL OR lb.rank > ${topN})
          AND (ra."nextDeepAnalyzeAt" IS NULL OR ra."nextDeepAnalyzeAt" <= ${now})
          AND (
            (lb.rank IS NULL AND ra.wallet > ${lastWallet})
            OR (lb.rank IS NOT NULL AND lb.rank > ${topN})
          )
        ORDER BY lb.rank ASC NULLS FIRST, ra.wallet ASC
        LIMIT ${take}
      `;
    }

    return prisma.$queryRaw<BgRow[]>`
      SELECT ra.wallet, lb.rank
      FROM "SmartMoneyRawAddress" ra
      INNER JOIN "SmartMoneyLeaderboardRow" lb ON lb.wallet = ra.wallet
      WHERE ra."pipelineStage" = 'COPY_POOL'
        AND ra.dormant = false
        AND lb."inCopyPool" = true
        AND lb.rank IS NOT NULL
        AND lb.rank > ${topN}
        AND (ra."nextDeepAnalyzeAt" IS NULL OR ra."nextDeepAnalyzeAt" <= ${now})
        AND (
          lb.rank > ${lastRank}
          OR (lb.rank = ${lastRank} AND ra.wallet > ${lastWallet})
        )
      ORDER BY lb.rank ASC, ra.wallet ASC
      LIMIT ${take}
    `;
  };

  let rows = await fetchAfter(cursor, limit);
  let wrapped = false;
  if (rows.length === 0 && (cursor.lastWallet != null || cursor.lastRank != null)) {
    wrapped = true;
    rows = await fetchAfter({ lastRank: null, lastWallet: null }, limit);
  }

  if (rows.length === 0) {
    if (wrapped) {
      await saveBackgroundCursor({ lastRank: null, lastWallet: null, wrapped: true });
    }
    return { wallets: [], advanced: false, wrapped };
  }

  const last = rows[rows.length - 1]!;
  await saveBackgroundCursor({
    lastRank: last.rank,
    lastWallet: normalizeWallet(last.wallet),
    wrapped,
  });

  return {
    wallets: rows.map((r) => normalizeWallet(r.wallet)),
    advanced: true,
    wrapped,
  };
}

/**
 * 复评份额内选址：有 TopN 日待办则 100% priority（暂停 background cursor）。
 */
export async function pickCopyPoolRescoreSlots(limit: number): Promise<{
  wallets: string[];
  channel: CopyPoolRescoreChannel;
  priorityDue: number;
}> {
  if (limit <= 0) {
    return { wallets: [], channel: 'background', priorityDue: 0 };
  }

  if (!isDualChannelRescoreMode()) {
    return { wallets: [], channel: 'legacy', priorityDue: 0 };
  }

  // 前端在榜集合是复评入口权威；修复历史缺行/阶段漂移后再选 TopN。
  await reconcileCopyPoolPipelineState().catch((error) => {
    console.warn('[smart-money-copy-pool-consistency] reconcile before pick failed', {
      error,
    });
  });

  const priorityDue = await countPriorityTopNDue();
  if (priorityDue > 0) {
    const wallets = await pickPriorityTopNDue(limit);
    // 有欠债但部分/全部处于短冷却时，用 background 填满剩余槽，避免 Deep 空转。
    if (wallets.length > 0) {
      recordCopyPoolRescorePickMetric('priority');
      if (wallets.length >= limit) {
        return { wallets, channel: 'priority', priorityDue };
      }
      const bg = await pickBackgroundFromCursor(limit - wallets.length);
      if (bg.wallets.length > 0) recordCopyPoolRescorePickMetric('background');
      return {
        wallets: [...wallets, ...bg.wallets],
        channel: 'priority',
        priorityDue,
      };
    }
  }

  const bg = await pickBackgroundFromCursor(limit);
  if (bg.wallets.length > 0) recordCopyPoolRescorePickMetric('background');
  return { wallets: bg.wallets, channel: 'background', priorityDue };
}

export async function countBackgroundEligible(): Promise<number> {
  const topN = CONFIG.smartMoneyCopyPoolDailyTopN;
  const now = new Date();
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "SmartMoneyRawAddress" ra
    INNER JOIN "SmartMoneyLeaderboardRow" lb ON lb.wallet = ra.wallet
    WHERE ra."pipelineStage" = 'COPY_POOL'
      AND ra.dormant = false
      AND lb."inCopyPool" = true
      AND (lb.rank IS NULL OR lb.rank > ${topN})
      AND (ra."nextDeepAnalyzeAt" IS NULL OR ra."nextDeepAnalyzeAt" <= ${now})
  `;
  const raw = rows[0]?.count ?? 0;
  return typeof raw === 'bigint' ? Number(raw) : Number(raw);
}

export async function getCopyPoolDualChannelStats(): Promise<{
  mode: string;
  dailyTopN: number;
  dayKey: string;
  priorityDue: number;
  backgroundEligible: number;
  bgCursor: BgCursorMeta;
}> {
  const [priorityDue, backgroundEligible, bgCursor] = await Promise.all([
    countPriorityTopNDue(),
    countBackgroundEligible(),
    loadBackgroundCursor(),
  ]);
  return {
    mode: CONFIG.smartMoneyCopyPoolRescoreMode,
    dailyTopN: CONFIG.smartMoneyCopyPoolDailyTopN,
    dayKey: businessDayKey(),
    priorityDue,
    backgroundEligible,
    bgCursor,
  };
}

/** 运维旁路：记录日终 SLA 快照（不阻塞调度） */
export async function recordDailyRescoreMeta(input: {
  priorityDue: number;
  priorityCompletedHint?: number;
}): Promise<void> {
  await upsertDiscoveryCursor({
    source: COPY_POOL_DAILY_META_SOURCE,
    cursor: businessDayKey(),
    meta: {
      dayKey: businessDayKey(),
      priorityDue: input.priorityDue,
      priorityCompletedHint: input.priorityCompletedHint ?? null,
      dailyTopN: CONFIG.smartMoneyCopyPoolDailyTopN,
      updatedAt: new Date().toISOString(),
    },
  }).catch(() => undefined);
}

/** 供测试：纯函数比较 cursor 顺序（NULL rank 优先） */
export function compareBgOrder(
  a: { rank: number | null; wallet: string },
  b: { rank: number | null; wallet: string }
): number {
  if (a.rank == null && b.rank != null) return -1;
  if (a.rank != null && b.rank == null) return 1;
  if (a.rank != null && b.rank != null && a.rank !== b.rank) return a.rank - b.rank;
  return a.wallet.localeCompare(b.wallet);
}
