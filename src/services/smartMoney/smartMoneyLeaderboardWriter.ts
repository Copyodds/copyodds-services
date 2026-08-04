import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { syncCopyLeaderDisplaySnapshot } from '../../copyTrading/services/copyLeaderDisplaySnapshot';
import { syncSmartMoneyLeaderboardActiveCandidateFlags } from './smartMoneyActiveCandidate';
import { smartMoneyCachedDisplayWhere } from './smartMoneyLeaderboardSticky';
import { smartMoneyLeaderboardRankWhere } from './smartMoneyCachedQuery';
import { countBlockScanDiscoveryPendingScore } from './blockScanDiscoveryIngest';
import type { SmartMoneyScoreResult } from './smartMoneyScorer';
import { computeDisplayScore } from './smartMoneyDisplayScore';
import { tierSortRank } from './smartMoneyPoolScore';

const LEADERBOARD_ROW_TX_TIMEOUT_MS = 30_000;
const RANK_RECOMPUTE_TX_TIMEOUT_MS = 120_000;
/** 曲线/快照剪枝最小间隔：剪枝是整表扫描，不随每次重排执行 */
const PRUNE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

type LeaderboardRankCandidate = {
  wallet: string;
  score: Prisma.Decimal;
  displayScore: Prisma.Decimal | null;
  traderScore: Prisma.Decimal | null;
  tier: string | null;
  lastScoredAt: Date;
};

/** 重算排名后删除非上榜地址的快照与曲线；改为 false 可保留所有候选地址的 DB 曲线。 */
const PRUNE_TRADER_CURVE_DATA_OUTSIDE_RANKED_LEADERBOARD = true;

const DEADLOCK_RETRY_LIMIT = 3;
const DEADLOCK_RETRY_BASE_DELAY_MS = 150;

function toDecimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(8));
}

function numberFromExplain(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergePreferNonNull(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value != null || merged[key] == null) merged[key] = value;
  }
  return merged;
}

const COPYABILITY_DISPLAY_KEYS = [
  'backtestPnlUsd',
  'copyLossRate',
  'medianHoldingSec',
  'avgHoldingSec',
  'lastTradeAt',
  'sampleWindowDays',
  'sampleTradeCount',
  'slippageBpsEffective',
] as const;

/**
 * Deep-Gate 不做完整跟单仿真。复评结果缺少 copyability 明细时保留旧值，
 * 避免 enrichPending 期间前端从已有数据退化为 “—”。
 */
export function mergeScoreExplainPreservingCopyability(
  previous: unknown,
  incoming: unknown
): Record<string, unknown> {
  const prior = recordFromUnknown(previous);
  const next = recordFromUnknown(incoming);
  const priorCopyability = recordFromUnknown(prior.copyability);
  const nextCopyability = recordFromUnknown(next.copyability);
  const priorMetrics = recordFromUnknown(priorCopyability.metrics);
  const nextMetrics = recordFromUnknown(nextCopyability.metrics);
  const priorDisplay = recordFromUnknown(prior.displayProfile);
  const nextDisplay = recordFromUnknown(next.displayProfile);

  const mergedDisplay = { ...nextDisplay };
  for (const key of COPYABILITY_DISPLAY_KEYS) {
    if (mergedDisplay[key] == null && priorDisplay[key] != null) {
      mergedDisplay[key] = priorDisplay[key];
    }
  }

  return {
    ...next,
    ...(Object.keys(priorCopyability).length > 0 || Object.keys(nextCopyability).length > 0
      ? {
          copyability: {
            ...priorCopyability,
            ...nextCopyability,
            metrics: mergePreferNonNull(priorMetrics, nextMetrics),
          },
        }
      : {}),
    displayProfile: mergedDisplay,
  };
}

/** 从 scoreExplain.displayProfile 提取榜列派生字段 */
export function extractLeaderboardDisplayColumns(scoreExplain: Record<string, unknown> | null | undefined): {
  recentPnl7d: number | null;
  recentPnl30d: number | null;
  trades7d: number | null;
  trades30d: number | null;
  /** 展示用：近一年已平仓样本 ΣrealizedPnl（非账户曲线） */
  totalPnl1y: number | null;
  /**
   * L1/门控用：ALL 曲线近 1 年美元盈亏变化；与 maxDrawdownUsd1y 同源。
   * 禁止用 closed 样本加总冒充，否则 MDD$<PnL$ 尺子分裂。
   */
  accountPnl1y: number | null;
  pnlWindowDays: number | null;
  totalReturn1y: number | null;
  maxDrawdown1y: number | null;
  maxDrawdownUsd1y: number | null;
  backtestPnlUsd: number | null;
  copyLossRate: number | null;
  slippageBpsEffective: number | null;
} {
  const display =
    scoreExplain &&
    typeof scoreExplain.displayProfile === 'object' &&
    scoreExplain.displayProfile != null &&
    !Array.isArray(scoreExplain.displayProfile)
      ? (scoreExplain.displayProfile as Record<string, unknown>)
      : {};
  const pnl1yWindow =
    display.pnlWindowMetrics != null &&
    typeof display.pnlWindowMetrics === 'object' &&
    !Array.isArray(display.pnlWindowMetrics)
      ? ((display.pnlWindowMetrics as { pnl1y?: Record<string, unknown> }).pnl1y ?? null)
      : null;
  return {
    recentPnl7d: numberFromExplain(display.recentPnl7d),
    recentPnl30d: numberFromExplain(display.recentPnl30d),
    trades7d: numberFromExplain(display.trades7d),
    trades30d: numberFromExplain(display.trades30d),
    totalPnl1y: numberFromExplain(display.totalPnl1y),
    accountPnl1y: numberFromExplain(pnl1yWindow?.pnlUsd),
    pnlWindowDays: numberFromExplain(display.pnlWindowDays) ?? numberFromExplain(pnl1yWindow?.actualWindowDays),
    totalReturn1y: numberFromExplain(display.totalReturnRatio),
    /** 展示 MDD 优先；否则回退窗内原始比率 */
    maxDrawdown1y:
      numberFromExplain(display.maxDrawdownPercent) ??
      numberFromExplain(pnl1yWindow?.maxDrawdownRatio),
    maxDrawdownUsd1y:
      numberFromExplain(display.maxDrawdownUsd) ?? numberFromExplain(pnl1yWindow?.maxDrawdownUsd),
    backtestPnlUsd: numberFromExplain(display.backtestPnlUsd),
    copyLossRate: numberFromExplain(display.copyLossRate),
    slippageBpsEffective: numberFromExplain(display.slippageBpsEffective),
  };
}

type SmartMoneyLeaderboardObservability = {
  eligibleCount: number;
  rankedCount: number;
  displayableCount: number;
  /** 与 GET /smart-money/cached 默认 where（eligibleOnly=true）一致的 total */
  cachedApiTotal: number;
  bootstrapTargetCount: number;
  bootstrapRemainingCount: number;
  staleTopCount: number;
  refreshedTop24hCount: number;
  topFlagCounts: Record<string, number>;
  blockScanDiscoveryPendingCount: number;
};

export async function countDisplayableSmartMoneyLeaderboardRows(
  _freshSince: Date = new Date(Date.now() - CONFIG.smartMoneyScoreFreshnessMs)
): Promise<number> {
  void _freshSince;
  return prisma.smartMoneyLeaderboardRow.count({
    where: smartMoneyCachedDisplayWhere({ eligibleOnly: true }),
  });
}

/** UI「榜单交易员」：active + eligible + 综合 rank≤topLimit */
export async function countCachedApiSmartMoneyLeaderboardRows(): Promise<number> {
  return prisma.smartMoneyLeaderboardRow.count({
    where: smartMoneyCachedDisplayWhere(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code;
  }
  if (typeof error === 'object' && error && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function isDeadlockError(error: unknown): boolean {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);
  return code === 'P2034' || code === '40P01' || /deadlock|死锁/i.test(message);
}

let lastPruneAtMs = 0;

/**
 * 仅保留当前有 rank 的聪明钱榜地址的曲线/快照，降低库体积。
 * 整表反连接删除较重：按 PRUNE_MIN_INTERVAL_MS 节流，不随每次重排执行。
 */
async function pruneTraderCurveDataOutsideRankedLeaderboard(): Promise<void> {
  if (!PRUNE_TRADER_CURVE_DATA_OUTSIDE_RANKED_LEADERBOARD) {
    return;
  }
  const now = Date.now();
  if (now - lastPruneAtMs < PRUNE_MIN_INTERVAL_MS) {
    return;
  }
  lastPruneAtMs = now;
  const rankedCount = await prisma.smartMoneyLeaderboardRow.count({
    where: { rank: { not: null } },
  });
  if (rankedCount === 0) {
    return;
  }
  // NOT EXISTS 反连接代替 notIn(巨列表)：不把全部排名钱包载入内存，也避免超长参数列表
  await prisma.$executeRaw`
    DELETE FROM "TraderCurvePoint" tcp
    WHERE NOT EXISTS (
      SELECT 1 FROM "SmartMoneyLeaderboardRow" sm
      WHERE sm.wallet = tcp.wallet AND sm.rank IS NOT NULL
    )
  `;
  await prisma.$executeRaw`
    DELETE FROM "TraderProfileSnapshot" tps
    WHERE NOT EXISTS (
      SELECT 1 FROM "SmartMoneyLeaderboardRow" sm
      WHERE sm.wallet = tps.wallet AND sm.rank IS NOT NULL
    )
  `;
}

async function withDeadlockRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= DEADLOCK_RETRY_LIMIT; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isDeadlockError(error) || attempt === DEADLOCK_RETRY_LIMIT) {
        throw error;
      }
      // console.warn(`[smart-money-rank] ${label} deadlock detected, retrying`, {
      //   attempt,
      //   maxAttempts: DEADLOCK_RETRY_LIMIT,
      //   error: getErrorMessage(error),
      // });
      await sleep(DEADLOCK_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  throw new Error(`[smart-money-rank] ${label} retry loop exhausted unexpectedly`);
}

function resolvePersistedEligible(input: {
  scoredEligible: boolean;
  riskFlags: string[];
}): boolean {
  if (
    input.riskFlags.includes('BLACKLISTED') ||
    input.riskFlags.includes('NOISE_TAGGED') ||
    input.riskFlags.includes('HEDGED_PAIR_EXPOSURE') ||
    input.riskFlags.includes('NEGATIVE_TOTAL_PNL') ||
    input.riskFlags.includes('LOW_AVG_CLOSED_RETURN_RATE') ||
    // HIGH_TRADE_FREQUENCY / SHORT_HORIZON_MARKET / HIGH_DUST_SHARE：软标记，不再清 eligible
    input.riskFlags.includes('TRADE_FREQUENCY_UNVERIFIED')
  ) {
    return false;
  }
  return input.scoredEligible;
}

/** 供单测：eligible 旗标解析（含硬踢） */
export function resolvePersistedEligibleForTest(
  input: Parameters<typeof resolvePersistedEligible>[0]
): boolean {
  return resolvePersistedEligible(input);
}

export async function upsertSmartMoneyLeaderboardRow(
  result: SmartMoneyScoreResult
): Promise<{ wallet: string; rank: number | null; score: number; eligible: boolean }> {
  const syncedAt = new Date();
  const eligible = resolvePersistedEligible({
    scoredEligible: result.eligible,
    riskFlags: result.riskFlags,
  });
  const displayCols = extractLeaderboardDisplayColumns(
    result.scoreExplain as Record<string, unknown>
  );
  const leaderboardData = {
    score: toDecimal(result.score),
    pnlQuality: toDecimal(result.pnlQuality),
    activityScore: toDecimal(result.activityScore),
    consistencyScore: toDecimal(result.consistencyScore),
    officialCandidateScore: toDecimal(result.officialCandidateScore),
    externalQualityScore: toDecimal(result.externalQualityScore),
    riskPenalty: toDecimal(result.riskPenalty),
    eligible,
    riskFlags: result.riskFlags,
    scoreVersion: result.scoreVersion,
    sourceFetchedAt: result.sourceFetchedAt,
    lastScoredAt: result.lastScoredAt,
    syncedAt,
    displayName: result.displayName,
    profileSlug: result.profileSlug,
    joinedAtText: result.joinedAtText,
    profileImage: result.profileImage,
    xUsername: result.xUsername,
    predictionCount: result.predictionCount,
    holdingsValue: result.holdingsValue != null ? new Prisma.Decimal(result.holdingsValue) : null,
    totalPnl: result.totalPnl != null ? new Prisma.Decimal(result.totalPnl) : null,
    sourceRankWeek: result.sourceRankWeek,
    sourceRankMonth: result.sourceRankMonth,
    sourceRankAll: result.sourceRankAll,
    officialSourceRankWeek: result.officialSourceRankWeek,
    officialSourceRankMonth: result.officialSourceRankMonth,
    officialSourceRankAll: result.officialSourceRankAll,
    externalSourceRankWeek: result.externalSourceRankWeek,
    externalSourceRankMonth: result.externalSourceRankMonth,
    externalSourceRankAll: result.externalSourceRankAll,
    candidatePeriods: result.candidatePeriods,
    candidateCategories: result.candidateCategories,
    externalWinRate: result.externalWinRate != null ? new Prisma.Decimal(result.externalWinRate) : null,
    externalSharpeRatio:
      result.externalSharpeRatio != null ? new Prisma.Decimal(result.externalSharpeRatio) : null,
    externalTotalReturn:
      result.externalTotalReturn != null ? new Prisma.Decimal(result.externalTotalReturn) : null,
    maxDrawdownPercent:
      result.maxDrawdownPercent != null ? new Prisma.Decimal(result.maxDrawdownPercent) : null,
    externalMetricsPeriod: result.externalMetricsPeriod,
    externalMetricsSource: result.externalMetricsSource,
    winRateSource: result.winRateSource,
    metricsSourceBadge: result.metricsSourceBadge,
    scoreExplain: result.scoreExplain as Prisma.InputJsonValue,
    displayScore: toDecimal(computeDisplayScore(null, result.score, result.traderScore)),
    traderScore: result.traderScore != null ? toDecimal(result.traderScore) : null,
    tier: result.tier,
    edgeScore: result.edgeScore != null ? toDecimal(result.edgeScore) : null,
    edgeSampleN: result.edgeSampleN,
    traderType: result.traderType,
    activeDays: result.activeDays != null ? Math.round(result.activeDays) : null,
    maxWinTradeUsd:
      result.maxWinTradeUsd != null ? new Prisma.Decimal(result.maxWinTradeUsd) : null,
    maxLossTradeUsd:
      result.maxLossTradeUsd != null ? new Prisma.Decimal(result.maxLossTradeUsd) : null,
    recentPnl7d:
      displayCols.recentPnl7d != null ? new Prisma.Decimal(displayCols.recentPnl7d) : null,
    recentPnl30d:
      displayCols.recentPnl30d != null ? new Prisma.Decimal(displayCols.recentPnl30d) : null,
    trades7d: displayCols.trades7d != null ? Math.round(displayCols.trades7d) : null,
    trades30d: displayCols.trades30d != null ? Math.round(displayCols.trades30d) : null,
    totalPnl1y:
      displayCols.totalPnl1y != null ? new Prisma.Decimal(displayCols.totalPnl1y) : null,
    pnlWindowDays:
      displayCols.pnlWindowDays != null ? Math.round(displayCols.pnlWindowDays) : null,
    totalReturn1y:
      displayCols.totalReturn1y != null ? new Prisma.Decimal(displayCols.totalReturn1y) : null,
    maxDrawdown1y:
      displayCols.maxDrawdown1y != null ? new Prisma.Decimal(displayCols.maxDrawdown1y) : null,
    backtestPnlUsd:
      displayCols.backtestPnlUsd != null ? new Prisma.Decimal(displayCols.backtestPnlUsd) : null,
    copyLossRate:
      displayCols.copyLossRate != null ? new Prisma.Decimal(displayCols.copyLossRate) : null,
    slippageBpsEffective:
      displayCols.slippageBpsEffective != null
        ? Math.round(displayCols.slippageBpsEffective)
        : null,
    // Deep-Core 刚评分：标记待 Enrich（null = 待补 1D/1M）
    lastCurveEnrichAt: null as Date | null,
  };

  return withDeadlockRetry('score row upsert', async () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.smartMoneyLeaderboardRow.findUnique({
        where: { wallet: result.wallet },
        select: {
          inCopyPool: true,
          scoreExplain: true,
        },
      });
      const {
        scoreExplain: _incomingExplain,
        backtestPnlUsd: _incomingBacktestPnlUsd,
        copyLossRate: _incomingCopyLossRate,
        slippageBpsEffective: _incomingSlippageBpsEffective,
        ...leaderboardUpdateData
      } = leaderboardData;

      await tx.smartMoneyLeaderboardRow.upsert({
        where: { wallet: result.wallet },
        create: {
          wallet: result.wallet,
          rank: null,
          activeCandidate: false,
          inCopyPool: false,
          ...leaderboardData,
        },
        update: {
          ...leaderboardUpdateData,
          scoreExplain: mergeScoreExplainPreservingCopyability(
            existing?.scoreExplain,
            result.scoreExplain
          ) as Prisma.InputJsonValue,
          ...(displayCols.backtestPnlUsd != null
            ? { backtestPnlUsd: new Prisma.Decimal(displayCols.backtestPnlUsd) }
            : {}),
          ...(displayCols.copyLossRate != null
            ? { copyLossRate: new Prisma.Decimal(displayCols.copyLossRate) }
            : {}),
          ...(displayCols.slippageBpsEffective != null
            ? { slippageBpsEffective: Math.round(displayCols.slippageBpsEffective) }
            : {}),
          // 不在此处改 inCopyPool；由 syncSmartMoneyCopyPool 独占
          ...(existing?.inCopyPool ? {} : { activeCandidate: false }),
        },
      });

      await tx.observedTrader.updateMany({
        where: { wallet: result.wallet },
        data: {
          lastScoredAt: result.lastScoredAt,
        },
      });

      const saved = await tx.smartMoneyLeaderboardRow.findUnique({
        where: { wallet: result.wallet },
        select: {
          wallet: true,
          score: true,
          eligible: true,
        },
      });

      return {
        wallet: saved?.wallet ?? result.wallet,
        rank: null,
        score: saved ? Number(saved.score) : result.score,
        eligible: saved?.eligible ?? eligible,
      };
    }, { timeout: LEADERBOARD_ROW_TX_TIMEOUT_MS, maxWait: 15_000 })
  ).then(async (out) => {
    await syncCopyLeaderDisplaySnapshot(result.wallet, {
      displayName: result.displayName,
      xUsername: result.xUsername,
      tier: result.tier,
    }).catch(() => undefined);
    return out;
  });
}

/**
 * ScoreCache 已更新且榜行仍存在时，同步展示列（档位/TraderScore/explain/lastScoredAt 等）。
 * 不重置 lastCurveEnrichAt，不改动 inCopyPool。
 */
export async function patchLeaderboardRowFromScoreResultIfPresent(
  result: SmartMoneyScoreResult
): Promise<boolean> {
  const existing = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet: result.wallet },
    select: { wallet: true, lastScoredAt: true },
  });
  if (!existing) return false;
  // 榜行已更新或更新：跳过，避免无意义写放大
  if (existing.lastScoredAt.getTime() >= result.lastScoredAt.getTime()) return false;

  const eligible = resolvePersistedEligible({
    scoredEligible: result.eligible,
    riskFlags: result.riskFlags,
  });
  const displayCols = extractLeaderboardDisplayColumns(
    result.scoreExplain as Record<string, unknown>
  );
  const syncedAt = new Date();

  await prisma.smartMoneyLeaderboardRow.update({
    where: { wallet: result.wallet },
    data: {
      score: toDecimal(result.score),
      pnlQuality: toDecimal(result.pnlQuality),
      activityScore: toDecimal(result.activityScore),
      consistencyScore: toDecimal(result.consistencyScore),
      officialCandidateScore: toDecimal(result.officialCandidateScore),
      externalQualityScore: toDecimal(result.externalQualityScore),
      riskPenalty: toDecimal(result.riskPenalty),
      eligible,
      riskFlags: result.riskFlags,
      scoreVersion: result.scoreVersion,
      sourceFetchedAt: result.sourceFetchedAt,
      lastScoredAt: result.lastScoredAt,
      syncedAt,
      displayName: result.displayName,
      profileSlug: result.profileSlug,
      joinedAtText: result.joinedAtText,
      profileImage: result.profileImage,
      xUsername: result.xUsername,
      predictionCount: result.predictionCount,
      holdingsValue: result.holdingsValue != null ? new Prisma.Decimal(result.holdingsValue) : null,
      totalPnl: result.totalPnl != null ? new Prisma.Decimal(result.totalPnl) : null,
      externalWinRate:
        result.externalWinRate != null ? new Prisma.Decimal(result.externalWinRate) : null,
      externalSharpeRatio:
        result.externalSharpeRatio != null ? new Prisma.Decimal(result.externalSharpeRatio) : null,
      externalTotalReturn:
        result.externalTotalReturn != null ? new Prisma.Decimal(result.externalTotalReturn) : null,
      maxDrawdownPercent:
        result.maxDrawdownPercent != null ? new Prisma.Decimal(result.maxDrawdownPercent) : null,
      externalMetricsPeriod: result.externalMetricsPeriod,
      externalMetricsSource: result.externalMetricsSource,
      winRateSource: result.winRateSource,
      metricsSourceBadge: result.metricsSourceBadge,
      scoreExplain: result.scoreExplain as Prisma.InputJsonValue,
      displayScore: toDecimal(computeDisplayScore(null, result.score, result.traderScore)),
      traderScore: result.traderScore != null ? toDecimal(result.traderScore) : null,
      tier: result.tier,
      edgeScore: result.edgeScore != null ? toDecimal(result.edgeScore) : null,
      edgeSampleN: result.edgeSampleN,
      traderType: result.traderType,
      activeDays: result.activeDays != null ? Math.round(result.activeDays) : null,
      maxWinTradeUsd:
        result.maxWinTradeUsd != null ? new Prisma.Decimal(result.maxWinTradeUsd) : null,
      maxLossTradeUsd:
        result.maxLossTradeUsd != null ? new Prisma.Decimal(result.maxLossTradeUsd) : null,
      recentPnl7d:
        displayCols.recentPnl7d != null ? new Prisma.Decimal(displayCols.recentPnl7d) : null,
      recentPnl30d:
        displayCols.recentPnl30d != null ? new Prisma.Decimal(displayCols.recentPnl30d) : null,
      trades7d: displayCols.trades7d != null ? Math.round(displayCols.trades7d) : null,
      trades30d: displayCols.trades30d != null ? Math.round(displayCols.trades30d) : null,
      totalPnl1y:
        displayCols.totalPnl1y != null ? new Prisma.Decimal(displayCols.totalPnl1y) : null,
      pnlWindowDays:
        displayCols.pnlWindowDays != null ? Math.round(displayCols.pnlWindowDays) : null,
      totalReturn1y:
        displayCols.totalReturn1y != null ? new Prisma.Decimal(displayCols.totalReturn1y) : null,
      maxDrawdown1y:
        displayCols.maxDrawdown1y != null ? new Prisma.Decimal(displayCols.maxDrawdown1y) : null,
      // 故意不改 lastCurveEnrichAt / inCopyPool
    },
  });
  const { clearSmartMoneyReadCaches } = await import('./smartMoneyScoreCache.js');
  await clearSmartMoneyReadCaches();
  await syncCopyLeaderDisplaySnapshot(result.wallet, {
    displayName: result.displayName,
    xUsername: result.xUsername,
    tier: result.tier,
  }).catch(() => undefined);
  return true;
}

export async function getSmartMoneyLeaderboardObservability(): Promise<SmartMoneyLeaderboardObservability> {
  const freshSince = new Date(Date.now() - CONFIG.smartMoneyScoreFreshnessMs);
  const staleSince = new Date(Date.now() - CONFIG.smartMoneyTopStaleMs);
  const refreshedSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const where = {
    inCopyPool: true,
  };

  const [eligibleCount, rankedCount, displayableCount, cachedApiTotal, topRows, blockScanDiscoveryPendingCount] =
    await Promise.all([
    prisma.smartMoneyLeaderboardRow.count({ where }),
    prisma.smartMoneyLeaderboardRow.count({
      where: {
        ...where,
        rank: { not: null },
      },
    }),
    countDisplayableSmartMoneyLeaderboardRows(freshSince),
    countCachedApiSmartMoneyLeaderboardRows(),
    prisma.smartMoneyLeaderboardRow.findMany({
      where: {
        ...where,
        rank: { not: null },
      },
      orderBy: [{ rank: 'asc' }, { score: 'desc' }, { lastScoredAt: 'desc' }, { wallet: 'asc' }],
      take: Math.min(200, CONFIG.smartMoneyTopLimit),
      select: {
        wallet: true,
        rank: true,
        riskFlags: true,
        sourceFetchedAt: true,
        lastScoredAt: true,
      },
    }),
    countBlockScanDiscoveryPendingScore(),
  ]);

  const topFlagCounts: Record<string, number> = {};
  for (const row of topRows) {
    for (const flag of row.riskFlags) {
      topFlagCounts[flag] = (topFlagCounts[flag] ?? 0) + 1;
    }
  }

  return {
    eligibleCount,
    rankedCount,
    displayableCount,
    cachedApiTotal,
    bootstrapTargetCount: CONFIG.smartMoneyBootstrapTargetCount,
    bootstrapRemainingCount: Math.max(0, CONFIG.smartMoneyBootstrapTargetCount - cachedApiTotal),
    staleTopCount: topRows.filter(
      (row) => row.sourceFetchedAt == null || row.sourceFetchedAt < staleSince
    ).length,
    refreshedTop24hCount: topRows.filter((row) => row.lastScoredAt >= refreshedSince).length,
    topFlagCounts,
    blockScanDiscoveryPendingCount,
  };
}

/**
 * 按 hard riskFlags 强制出 CopyPool：清 inCopyPool / eligible / rank。
 */
export async function purgeIneligibleSmartMoneyLeaderboardRows(): Promise<{
  demotedRows: number;
}> {
  const demotedRows = await prisma.$executeRaw`
    UPDATE "SmartMoneyLeaderboardRow" sm
    SET
      "inCopyPool" = false,
      eligible = false,
      "activeCandidate" = false,
      rank = NULL,
      "copyPoolExitedAt" = COALESCE(sm."copyPoolExitedAt", NOW())
    WHERE (sm."inCopyPool" = true OR sm.eligible = true OR sm.rank IS NOT NULL)
      AND (
        'BLACKLISTED' = ANY(sm."riskFlags")
        OR 'NOISE_TAGGED' = ANY(sm."riskFlags")
        OR 'NEGATIVE_TOTAL_PNL' = ANY(sm."riskFlags")
        OR 'LOW_AVG_CLOSED_RETURN_RATE' = ANY(sm."riskFlags")
        OR 'TRADE_FREQUENCY_UNVERIFIED' = ANY(sm."riskFlags")
        OR 'HEDGED_PAIR_EXPOSURE' = ANY(sm."riskFlags")
      )
  `;
  return { demotedRows: Number(demotedRows) };
}

/**
 * 当前池分 ≤ 出榜线的 CopyPool 成员立即摘池。
 * 与 syncSmartMoneyCopyPool 同权威（E1：≤EXIT 无 miss 迟滞；灰区仍由 Deep 复评）。
 * §15：池分优先 TraderScore；无值回落 v4 score。
 * 同步把 Raw stage 从 COPY_POOL → SCORED，避免「榜已出池、管道仍占 COPY_POOL」分叉。
 */
export async function purgeBelowExitScoreLeaderboardRows(): Promise<{
  demotedRows: number;
}> {
  const exitScore = CONFIG.smartMoneyCopyPoolExitScore;
  const demotedRows = CONFIG.smartMoneyTraderScoreAsPrimary
    ? await prisma.$executeRaw`
        UPDATE "SmartMoneyLeaderboardRow" sm
        SET
          "inCopyPool" = false,
          eligible = false,
          "activeCandidate" = false,
          rank = NULL,
          "enrichPending" = false,
          "copyPoolExitedAt" = COALESCE(sm."copyPoolExitedAt", NOW())
        WHERE sm."inCopyPool" = true
          AND COALESCE(sm."traderScore", sm.score) <= ${exitScore}
      `
    : await prisma.$executeRaw`
        UPDATE "SmartMoneyLeaderboardRow" sm
        SET
          "inCopyPool" = false,
          eligible = false,
          "activeCandidate" = false,
          rank = NULL,
          "enrichPending" = false,
          "copyPoolExitedAt" = COALESCE(sm."copyPoolExitedAt", NOW())
        WHERE sm."inCopyPool" = true
          AND sm.score <= ${exitScore}
      `;

  if (Number(demotedRows) > 0) {
    const retryMs = CONFIG.smartMoneyScoredRecheckMs;
    await prisma.$executeRaw`
      UPDATE "SmartMoneyRawAddress" ra
      SET
        "pipelineStage" = 'SCORED',
        "nextDeepAnalyzeAt" = NOW() + (${retryMs} * INTERVAL '1 millisecond'),
        "updatedAt" = NOW()
      FROM "SmartMoneyLeaderboardRow" sm
      WHERE sm.wallet = ra.wallet
        AND sm."inCopyPool" = false
        AND COALESCE(sm."traderScore", sm.score) <= ${exitScore}
        AND ra."pipelineStage" = 'COPY_POOL'
    `;
  }

  return { demotedRows: Number(demotedRows) };
}

/**
 * @deprecated 运维脚本兼容；仅把兼容字段镜像回 CopyPool 语义，不恢复 sticky 旧榜。
 */
export async function restoreSmartMoneyLeaderboardEligibility(): Promise<{
  restoredRows: number;
}> {
  const restoredRows = await prisma.$executeRaw`
    UPDATE "SmartMoneyLeaderboardRow" sm
    SET
      eligible = sm."inCopyPool",
      "activeCandidate" = sm."inCopyPool"
    WHERE sm.eligible IS DISTINCT FROM sm."inCopyPool"
       OR sm."activeCandidate" IS DISTINCT FROM sm."inCopyPool"
  `;
  return {
    restoredRows: Number(restoredRows),
  };
}

/** 将 scoreExplain 中已确认总盈利为负的地址完整出 CopyPool（与硬旗清洗对齐）。 */
async function demoteNegativePnlLeaderboardRows(
  db: Prisma.TransactionClient | typeof prisma
): Promise<number> {
  return db.$executeRaw`
    UPDATE "SmartMoneyLeaderboardRow" sm
    SET
      "inCopyPool" = false,
      eligible = false,
      "activeCandidate" = false,
      rank = NULL,
      "enrichPending" = false,
      "copyPoolExitedAt" = COALESCE(sm."copyPoolExitedAt", NOW()),
      "riskFlags" = CASE
        WHEN (
          NULLIF(sm."scoreExplain"->'resolvedMetrics'->>'totalPnl', '')::numeric < 0
          OR NULLIF(sm."scoreExplain"->'rawMetrics'->>'totalPnl', '')::numeric < 0
        )
        AND NOT ('NEGATIVE_TOTAL_PNL' = ANY(sm."riskFlags"))
          THEN array_append(sm."riskFlags", 'NEGATIVE_TOTAL_PNL')
        ELSE sm."riskFlags"
      END
    WHERE (
      NULLIF(sm."scoreExplain"->'resolvedMetrics'->>'totalPnl', '')::numeric < 0
      OR NULLIF(sm."scoreExplain"->'rawMetrics'->>'totalPnl', '')::numeric < 0
    )
    AND (
      sm."inCopyPool" = true
      OR sm.eligible = true
      OR sm.rank IS NOT NULL
    )
  `;
}

function sortLeaderboardRankCandidates(
  rows: LeaderboardRankCandidate[],
  topLimit: number
): LeaderboardRankCandidate[] {
  // §15：档位优先（S→D），档内 TraderScore；回落 v4 score。
  const useTrader = CONFIG.smartMoneyTraderScoreAsPrimary;
  return [...rows]
    .sort((left, right) => {
      const tierDiff = tierSortRank(left.tier) - tierSortRank(right.tier);
      if (tierDiff !== 0) return tierDiff;
      if (useTrader) {
        const leftTs = left.traderScore != null ? Number(left.traderScore) : Number(left.score);
        const rightTs = right.traderScore != null ? Number(right.traderScore) : Number(right.score);
        const traderDiff = rightTs - leftTs;
        if (traderDiff !== 0) return traderDiff;
      }
      const scoreDiff = Number(right.score) - Number(left.score);
      if (scoreDiff !== 0) return scoreDiff;
      const scoredDiff = right.lastScoredAt.getTime() - left.lastScoredAt.getTime();
      if (scoredDiff !== 0) return scoredDiff;
      return left.wallet.localeCompare(right.wallet);
    })
    .slice(0, topLimit);
}

async function applyLeaderboardRanks(
  tx: Prisma.TransactionClient,
  topRows: LeaderboardRankCandidate[]
): Promise<{ clearedCount: number }> {
  const topWallets = topRows.map((row) => row.wallet);
  const cleared = await tx.smartMoneyLeaderboardRow.updateMany({
    where: {
      rank: { not: null },
      wallet: { notIn: topWallets.length > 0 ? topWallets : ['__no_wallet__'] },
    },
    data: { rank: null },
  });

  const chunkSize = 250;
  for (let offset = 0; offset < topRows.length; offset += chunkSize) {
    const chunk = topRows.slice(offset, offset + chunkSize);
    const wallets = chunk.map((row) => row.wallet);
    const ranks = chunk.map((_, index) => offset + index + 1);
    await tx.$executeRaw`
      UPDATE "SmartMoneyLeaderboardRow" sm
      SET rank = v.rank
      FROM (
        SELECT *
        FROM UNNEST(${wallets}::text[], ${ranks}::int[]) AS t(wallet, rank)
      ) v
      WHERE sm.wallet = v.wallet
    `;
  }

  return { clearedCount: cleared.count };
}

/** 排名重排脏标记：写入方只标脏，由低频 flush 合并执行，避免每个 Deep/Gamma 批次全榜重排 */
let ranksDirty = false;
let ranksDirtySinceMs: number | null = null;
let rankRecomputeInFlight: Promise<{
  topCount: number;
  clearedCount: number;
  observability: SmartMoneyLeaderboardObservability;
}> | null = null;

/**
 * 标记榜单排名需要重算。代替调用方直接 await recomputeSmartMoneyLeaderboardRanks()，
 * 由 smart-money-rank-recompute cron（flushSmartMoneyRankRecomputeIfDirty）低频合并执行。
 */
export function markSmartMoneyRanksDirty(): void {
  if (!ranksDirty) {
    ranksDirtySinceMs = Date.now();
  }
  ranksDirty = true;
}

/** 供观测：当前是否有待执行的重排 */
export function isSmartMoneyRanksDirty(): boolean {
  return ranksDirty;
}

export function getSmartMoneyRankFlushLagSec(nowMs = Date.now()): number {
  if (!ranksDirty || ranksDirtySinceMs == null) return 0;
  return Math.max(0, Math.floor((nowMs - ranksDirtySinceMs) / 1000));
}

/** 脏标记 flush：仅在有待处理写入时执行一次全榜重排（进程内合并）。 */
export async function flushSmartMoneyRankRecomputeIfDirty(): Promise<{
  ran: boolean;
  topCount?: number;
  clearedCount?: number;
}> {
  if (!ranksDirty) {
    return { ran: false };
  }
  ranksDirty = false;
  try {
    const result = await recomputeSmartMoneyLeaderboardRanks();
    const flushLagSec = ranksDirtySinceMs == null ? 0 : Math.max(0, Math.floor((Date.now() - ranksDirtySinceMs) / 1000));
    console.log('[smart-money-rank] dirty flush finished', {
      flushLagSec,
      topCount: result.topCount,
      clearedCount: result.clearedCount,
    });
    ranksDirtySinceMs = null;
    return { ran: true, topCount: result.topCount, clearedCount: result.clearedCount };
  } catch (error) {
    // 失败保留脏标记，下个 tick 重试
    ranksDirty = true;
    throw error;
  }
}

export async function recomputeSmartMoneyLeaderboardRanks(): Promise<{
  topCount: number;
  clearedCount: number;
  observability: SmartMoneyLeaderboardObservability;
}> {
  // 单飞：并发调用共享同一次重排，避免多个来源同时全榜扫描互相死锁
  if (rankRecomputeInFlight) {
    return rankRecomputeInFlight;
  }
  rankRecomputeInFlight = doRecomputeSmartMoneyLeaderboardRanks().finally(() => {
    rankRecomputeInFlight = null;
  });
  return rankRecomputeInFlight;
}

async function doRecomputeSmartMoneyLeaderboardRanks(): Promise<{
  topCount: number;
  clearedCount: number;
  observability: SmartMoneyLeaderboardObservability;
}> {
  await demoteNegativePnlLeaderboardRows(prisma);
  // 负 PnL 完整出池后，把仍停在 COPY_POOL 的 Raw 收口到 ELIMINATED（与硬旗一致）
  await prisma.$executeRaw`
    UPDATE "SmartMoneyRawAddress" ra
    SET
      "pipelineStage" = 'ELIMINATED',
      "tierFailReason" = 'COPY_HARD|NEGATIVE_TOTAL_PNL',
      "elimBucket" = 'COLD',
      "nextDeepAnalyzeAt" = NULL,
      "updatedAt" = NOW()
    FROM "SmartMoneyLeaderboardRow" sm
    WHERE sm.wallet = ra.wallet
      AND sm."inCopyPool" = false
      AND 'NEGATIVE_TOTAL_PNL' = ANY(sm."riskFlags")
      AND ra."pipelineStage" = 'COPY_POOL'
  `;
  await purgeBelowExitScoreLeaderboardRows();
  // rank 只服务展示 Top N；额外 buffer 容纳边界波动，禁止把整表载入内存排序
  const topLimit = Math.max(CONFIG.smartMoneyTopLimit, 100) + 500;
  const rankWhere = smartMoneyLeaderboardRankWhere();

  const [currentlyRanked, qualifying] = await Promise.all([
    prisma.smartMoneyLeaderboardRow.findMany({
      where: {
        rank: { not: null },
        ...rankWhere,
      },
      select: {
        wallet: true,
        score: true,
        displayScore: true,
        traderScore: true,
        tier: true,
        lastScoredAt: true,
      },
    }),
    prisma.smartMoneyLeaderboardRow.findMany({
      where: rankWhere,
      orderBy: CONFIG.smartMoneyTraderScoreAsPrimary
        ? [{ traderScore: 'desc' }, { score: 'desc' }, { lastScoredAt: 'desc' }]
        : [{ score: 'desc' }, { lastScoredAt: 'desc' }],
      take: Math.max(topLimit * 3, topLimit + 500),
      select: {
        wallet: true,
        score: true,
        displayScore: true,
        traderScore: true,
        tier: true,
        lastScoredAt: true,
      },
    }),
  ]);

  const byWallet = new Map<string, LeaderboardRankCandidate>();
  for (const row of [...currentlyRanked, ...qualifying]) {
    if (!byWallet.has(row.wallet)) {
      byWallet.set(row.wallet, row);
    }
  }
  const topRows = sortLeaderboardRankCandidates([...byWallet.values()], topLimit);

  const rankStats = await withDeadlockRetry('rank recompute', async () =>
    prisma.$transaction(
      async (tx) => {
        const { clearedCount } = await applyLeaderboardRanks(tx, topRows);
        return {
          topCount: topRows.length,
          clearedCount,
        };
      },
      { timeout: RANK_RECOMPUTE_TX_TIMEOUT_MS, maxWait: 15_000 }
    )
  );
  await pruneTraderCurveDataOutsideRankedLeaderboard();
  await syncSmartMoneyLeaderboardActiveCandidateFlags();
  const observability = await getSmartMoneyLeaderboardObservability();
  return {
    ...rankStats,
    observability,
  };
}
