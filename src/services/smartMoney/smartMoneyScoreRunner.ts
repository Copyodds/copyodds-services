import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { getLatestPredictingTopWalletMetrics } from '../polymarket/predictingTopLeaderboard';
import type { PolymarketProfileFetchResult } from '../polymarket/polymarketProfile';
import { scoreObservedTraderProfile, type SmartMoneyScoreResult } from './smartMoneyScorer';
import { buildClosedMarketReturnDistribution, fetchPositionPnlContext } from './smartMoneyPositionStats';
import type { ClosedPositionsFetchResult } from '../polymarket/polymarketData';
import { buildSmartMoneyMarketCategoryProfile } from './smartMoneyMarketCategory';
import {
  buildSmartMoneyMarketLiquidityProfile,
  extractMarketLiquidityProfileFromScoreExplain,
} from './smartMoneyMarketLiquidity';
import {
  fetchDataApiTradesInWindow,
  normalizeTradeTimestampMs,
  type DataApiTrade,
} from '../polymarket/polymarketTrades';
import {
  simulateCopyabilityMultiScenario,
} from './smartMoneyCopyabilitySim';
import { composeCopyabilityScore, recomposeCopyabilityWithClosedDist } from './smartMoneyCopyMedianScore';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 单次评分共享的成交窗口：30d/7d/1D 笔数与 copyability 全部从这一份数据派生 */
export type SmartMoneyTradesWindow = {
  trades: DataApiTrade[];
  windowStartMs: number;
  windowEndMs: number;
};

/** 统计窗口内 ts >= sinceMs 的成交笔数（上游按时间倒序，截断只丢最旧部分，近端计数安全） */
export function countTradesSince(trades: DataApiTrade[], sinceMs: number): number {
  let count = 0;
  for (const trade of trades) {
    const tsMs = normalizeTradeTimestampMs(trade.timestamp);
    if (tsMs != null && tsMs >= sinceMs) count += 1;
  }
  return count;
}

function filterTradesSince(trades: DataApiTrade[], sinceMs: number): DataApiTrade[] {
  return trades.filter((trade) => {
    const tsMs = normalizeTradeTimestampMs(trade.timestamp);
    return tsMs != null && tsMs >= sinceMs;
  });
}

async function loadObservedTraderForScoring(wallet: string) {
  const normalized = wallet.trim().toLowerCase();
  let row = await prisma.observedTrader.findUnique({
    where: { wallet: normalized },
    select: {
      wallet: true,
      sourceRankWeek: true,
      sourceRankMonth: true,
      sourceRankAll: true,
      officialSourceRankWeek: true,
      officialSourceRankMonth: true,
      officialSourceRankAll: true,
      externalSourceRankWeek: true,
      externalSourceRankMonth: true,
      externalSourceRankAll: true,
      candidatePeriods: true,
      candidateCategories: true,
      blacklisted: true,
      noiseTags: true,
    },
  });
  if (!row) {
    const now = new Date();
    row = await prisma.observedTrader.create({
      data: {
        wallet: normalized,
        candidateActive: true,
        candidatePeriods: [],
        candidateCategories: ['OVERALL'],
        candidateSourceVersion: 0,
        candidateLastSeenAt: now,
        enabled: true,
        blacklisted: false,
        noiseTags: [],
        lastSeenAt: now,
        lastFetchStatus: 'PIPELINE_SCORE_BOOTSTRAP',
      },
      select: {
        wallet: true,
        sourceRankWeek: true,
        sourceRankMonth: true,
        sourceRankAll: true,
        officialSourceRankWeek: true,
        officialSourceRankMonth: true,
        officialSourceRankAll: true,
        externalSourceRankWeek: true,
        externalSourceRankMonth: true,
        externalSourceRankAll: true,
        candidatePeriods: true,
        candidateCategories: true,
        blacklisted: true,
        noiseTags: true,
      },
    });
  }
  return row;
}

export async function fetchTradeCount30d(wallet: string): Promise<number | null> {
  const end = Date.now();
  const start = end - 30 * 24 * 60 * 60 * 1000;
  try {
    const { trades } = await fetchDataApiTradesInWindow(wallet, start, end);
    return trades.length;
  } catch {
    return null;
  }
}

/** 近 7 日成交笔数（评分池 C6 / 榜列） */
export async function fetchTradeCount7d(wallet: string): Promise<number> {
  const end = Date.now();
  const start = end - 7 * 24 * 60 * 60 * 1000;
  try {
    const { trades } = await fetchDataApiTradesInWindow(wallet, start, end);
    return trades.length;
  } catch {
    return 0;
  }
}

export async function executeSmartMoneyFullScore(
  profile: PolymarketProfileFetchResult,
  options?: {
    skipHeavyFetches?: boolean;
    signal?: AbortSignal;
    /** gate：晋升判决（trades 早停、跳过 Gamma/仿真）；full：完整路径 */
    mode?: 'gate' | 'full';
    /** 注入 Closed Prefetch / Full 快照，跳过现场翻 closed */
    closedOverride?: ClosedPositionsFetchResult | null;
  }
): Promise<{
  scoreResult: SmartMoneyScoreResult;
  tradeCount30d: number | null;
  tradeCount7d: number;
  closedMarketReturnDistribution: ReturnType<typeof buildClosedMarketReturnDistribution>;
  marketLiquidityProfile: Awaited<ReturnType<typeof buildSmartMoneyMarketLiquidityProfile>> | null;
  /** 本次评分抓取的成交窗口；复用给 copyability 刷新，避免同窗重复请求 */
  tradesWindow: SmartMoneyTradesWindow | null;
  mode: 'gate' | 'full';
  /** closed-positions 是否请求成功 */
  closedFetchOk: boolean;
  /** Data API trades 窗口是否请求成功 */
  tradesFetchOk: boolean;
}> {
  const signal = options?.signal;
  const mode = options?.mode ?? 'full';
  const gateMode = mode === 'gate';
  const existingLeaderboard = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet: profile.wallet },
    select: {
      rank: true,
      inCopyPool: true,
      sourceFetchedAt: true,
      scoreExplain: true,
      copyabilityScore: true,
    },
  });
  const useFastScorePath =
    gateMode ||
    options?.skipHeavyFetches === true ||
    (existingLeaderboard?.inCopyPool === true &&
      existingLeaderboard.rank != null &&
      existingLeaderboard.sourceFetchedAt != null &&
      Date.now() - existingLeaderboard.sourceFetchedAt.getTime() < CONFIG.smartMoneyTopStaleMs);

  // 成交窗口只抓一次：覆盖 30d 硬门与 copyability lookback，7d/1D 从同一份派生。
  // Gate：够 L1-TRADES30D 门槛即停，不拉满仿真窗。
  const tradesWindowDays = Math.max(30, CONFIG.smartMoneyCopyLookbackDays);
  const tradesWindowEndMs = Date.now();
  const tradesWindowStartMs = tradesWindowEndMs - tradesWindowDays * DAY_MS;
  const countSince30d = tradesWindowEndMs - 30 * DAY_MS;

  const [observedTrader, externalMetrics, positionContext, tradesFetch] = await Promise.all([
    loadObservedTraderForScoring(profile.wallet),
    getLatestPredictingTopWalletMetrics(profile.wallet),
    fetchPositionPnlContext(profile.wallet, {
      signal,
      skipOpenPositions: gateMode && !CONFIG.smartMoneyGateFetchOpenPositions,
      closedOverride: options?.closedOverride,
    }),
    fetchDataApiTradesInWindow(profile.wallet, tradesWindowStartMs, tradesWindowEndMs, {
      signal,
      ...(gateMode
        ? {
            stopWhenCountGte: Math.max(1, CONFIG.smartMoneyScorePoolMinTrades30d),
            countSinceMs: countSince30d,
          }
        : {}),
    })
      .then(
        ({ trades }): { ok: true; window: SmartMoneyTradesWindow } => ({
          ok: true,
          window: {
            trades,
            windowStartMs: tradesWindowStartMs,
            windowEndMs: tradesWindowEndMs,
          },
        })
      )
      .catch(
        (): { ok: false; window: null } => ({
          ok: false,
          window: null,
        })
      ),
  ]);
  signal?.throwIfAborted();

  const tradesFetchOk = tradesFetch.ok;
  const tradesWindow = tradesFetch.window;

  const tradeCount30d =
    tradesWindow != null
      ? countTradesSince(tradesWindow.trades, tradesWindow.windowEndMs - 30 * DAY_MS)
      : null;
  const tradeCount7d =
    tradesWindow != null
      ? countTradesSince(tradesWindow.trades, tradesWindow.windowEndMs - 7 * DAY_MS)
      : 0;

  // 淘汰池冷清除用：把最近成交写回 registry
  if (tradesWindow != null && tradesWindow.trades.length > 0) {
    let latestMs = 0;
    for (const trade of tradesWindow.trades) {
      const tsMs = normalizeTradeTimestampMs(trade.timestamp);
      if (tsMs != null && tsMs > latestMs) latestMs = tsMs;
    }
    if (latestMs > 0) {
      await prisma.smartMoneyRawAddress
        .updateMany({
          where: { wallet: profile.wallet.trim().toLowerCase() },
          data: { lastTradeAt: new Date(latestMs) },
        })
        .catch(() => undefined);
    }
  }

  // Gate / fast path 也要算 1D 笔数：用已抓到的 trades 计数，不额外翻页。
  // 早停窗对高频钱包第一页通常已含足够近端成交，足以触发 HIGH_TRADE_FREQUENCY。
  const tradesPerDay1D =
    tradesWindow == null
      ? null
      : countTradesSince(tradesWindow.trades, tradesWindow.windowEndMs - DAY_MS);

  const marketCategoryProfile = useFastScorePath
    ? null
    : await buildSmartMoneyMarketCategoryProfile({
        openRows: positionContext.openRows,
        closedRows: positionContext.closedRows,
      }).catch(() => null);

  const closedMarketReturnDistribution = buildClosedMarketReturnDistribution(positionContext.closedRows);

  let marketLiquidityProfile = useFastScorePath
    ? extractMarketLiquidityProfileFromScoreExplain(existingLeaderboard?.scoreExplain)
    : null;
  if (!marketLiquidityProfile && !gateMode) {
    marketLiquidityProfile = await buildSmartMoneyMarketLiquidityProfile({
      openRows: positionContext.openRows,
      closedRows: positionContext.closedRows,
      minMarketVolumeUsd: CONFIG.smartMoneyMinMarketVolumeUsd,
    }).catch(() => null);
  }

  // Gate：用榜缓存或中性缺省，仿真挪到入榜 Enrich
  // 切主综合分后：Gate 用缓存 RT + 当次 closed 分布廉价重算，避免拿旧纯 RT 误淘/误判
  let copyabilityScore: number | null = null;
  if (CONFIG.smartMoneyCopyabilityEnabled) {
    if (existingLeaderboard?.copyabilityScore != null) {
      copyabilityScore = Number(existingLeaderboard.copyabilityScore);
      if (!Number.isFinite(copyabilityScore)) copyabilityScore = null;
    }
    if (!gateMode && copyabilityScore == null && tradesWindow != null) {
      try {
        const lookbackStartMs =
          tradesWindow.windowEndMs - CONFIG.smartMoneyCopyLookbackDays * DAY_MS;
        const multi = simulateCopyabilityMultiScenario(
          filterTradesSince(tradesWindow.trades, lookbackStartMs),
          undefined,
          tradesWindow.windowEndMs
        );
        const composed = composeCopyabilityScore({
          rtScore: multi.copyabilityScore,
          roundTripCount: multi.scenarios.base.sim.roundTripCount,
          closedDist: closedMarketReturnDistribution,
        });
        copyabilityScore = composed.copyabilityScore;
      } catch {
        copyabilityScore = null;
      }
    } else if (copyabilityScore != null || existingLeaderboard?.scoreExplain != null) {
      const recomposed = recomposeCopyabilityWithClosedDist({
        scoreExplain: existingLeaderboard?.scoreExplain ?? null,
        fallbackCopyabilityScore: copyabilityScore,
        closedDist: closedMarketReturnDistribution,
      });
      if (recomposed != null) {
        copyabilityScore = recomposed.copyabilityScore;
      }
    }
  }

  const scoreResult = scoreObservedTraderProfile(profile, observedTrader, externalMetrics, {
    tradesPerDay1D,
    positionPnlStats: positionContext.stats,
    marketCategoryProfile,
    closedMarketReturnDistribution,
    marketLiquidityProfile,
    trades7d: tradeCount7d,
    trades30d: tradeCount30d,
    copyabilityScore,
    tradesSample: tradesWindow?.trades ?? null,
    openPositions: positionContext.openRows,
    closedRows: positionContext.closedRows,
    closedFetchOk: positionContext.closedFetchOk,
    tradesFetchOk,
    closedFetchError: positionContext.closedFetchError ?? null,
    closedSample: positionContext.closedSample ?? null,
    medianHoldingSec: null,
  });

  return {
    scoreResult,
    tradeCount30d,
    tradeCount7d,
    closedMarketReturnDistribution,
    marketLiquidityProfile,
    tradesWindow: gateMode ? null : tradesWindow,
    mode,
    closedFetchOk: positionContext.closedFetchOk,
    tradesFetchOk,
  };
}
