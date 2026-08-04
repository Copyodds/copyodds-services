import { CONFIG } from '../../config/env';
import type { PolymarketProfileFetchResult } from '../polymarket/polymarketProfile';
import type {
  PredictingTopPeriod,
  PredictingTopWalletMetric,
} from '../polymarket/predictingTopLeaderboard';
import type { PositionPnlStats } from './smartMoneyPositionStats';
import {
  HEDGED_PAIR_SHARE_THRESHOLD,
  SMART_MONEY_PNL_WINDOW_DAYS,
  buildClosedMarketReturnDistribution,
  computeHighReturnMarketShare,
  findMaxInvestedClosedMarket,
} from './smartMoneyPositionStats';
import type { ClosedMarketReturnDistribution } from './smartMoneyPositionStats';
import type { SmartMoneyMarketCategoryProfile } from './smartMoneyMarketCategory';
import type { SmartMoneyMarketLiquidityProfile } from './smartMoneyMarketLiquidity';
import {
  computeSmartMoneyScoreV40,
  isSmartMoneyScoreV40Active,
} from './smartMoneyScoreV40';
import {
  assembleSmartMoneyTraderProfile,
  traderProfileToExplain,
} from './smartMoneyTraderProfile';
import {
  MAX_PLAUSIBLE_PRINCIPAL_ROI_RATIO,
  computePeakEquityMaxDrawdown,
  resolveCanonicalBoardMetrics,
  sanitizeMaxDrawdownRatio,
} from './smartMoneyCanonicalBoardMetrics';
import {
  computeBoardPnlWindowMetrics,
  pickPortfolioPnlValues,
  slicePortfolioPnlWindowValues,
} from './smartMoneyBoardWindowMetrics';
import { computeTradeNotionalStats } from './smartMoneyTradeNotional';
import type { DataApiPosition } from '../polymarket/polymarketData';
import type { DataApiTrade } from '../polymarket/polymarketTrades';
import {
  detectCopyUnsuitableFlags,
  estimateAccountAgeDaysFromCurves,
  estimateAccountAgeDaysFromJoinText,
} from './smartMoneyCopyUnsuitable';

/** 展示与榜单排序统一近 30 天优先：30D → 7D → ALL */
const PRIMARY_EXTERNAL_METRIC_PERIODS: PredictingTopPeriod[] = ['30D', '7D', 'ALL'];
const LOCAL_EXTERNAL_METRIC_RANK = 0;
const LOCAL_PERIOD_CURVE_TYPE: Record<PredictingTopPeriod, string> = {
  '7D': 'PORTFOLIO_PNL_1W',
  '30D': 'PORTFOLIO_PNL_1M',
  ALL: 'PORTFOLIO_PNL_ALL',
};

type SmartMoneyExternalMetricsSource = 'PREDICTING_TOP' | 'LOCAL_FALLBACK' | 'MIXED';
type SmartMoneyExternalPeriodSource = 'PREDICTING_TOP' | 'LOCAL_FALLBACK' | null;

function unifyPeriodSourceRank(
  official: number | null,
  external: number | null,
  stored: number | null
): number | null {
  const ranks = [official, external, stored].filter(
    (value): value is number => value != null && Number.isFinite(value)
  );
  if (ranks.length === 0) return null;
  return Math.min(...ranks);
}

type SmartMoneyObservedTraderInput = {
  wallet: string;
  sourceRankWeek: number | null;
  sourceRankMonth: number | null;
  sourceRankAll: number | null;
  officialSourceRankWeek: number | null;
  officialSourceRankMonth: number | null;
  officialSourceRankAll: number | null;
  externalSourceRankWeek: number | null;
  externalSourceRankMonth: number | null;
  externalSourceRankAll: number | null;
  candidatePeriods: string[];
  candidateCategories: string[];
  blacklisted: boolean;
  noiseTags: string[];
};

type SmartMoneyExternalMetricsInput = Record<PredictingTopPeriod, PredictingTopWalletMetric | null>;

/** GET /smart-money/cached 胜率来源 */
export type LeaderboardWinRateSource = 'MARKET_CLOSED' | 'MARKET_COMPOSITE' | 'PREDICTING_TOP' | 'CURVE_PROXY';

/** v2.3 入榜门槛旗标（enforce 时参与 eligible） */
export const SMART_MONEY_V23_ELIGIBILITY_FLAGS = [
  'NEGATIVE_TOTAL_PNL',
  'EXCESSIVE_DRAWDOWN',
  'CLOSED_RETURN_DATA_MISSING',
  'CLOSED_POSITIONS_FETCH_FAILED',
  'INSUFFICIENT_CLOSED_MARKETS',
  'LOW_HIGH_RETURN_MARKET_SHARE',
  'LOW_AVG_CLOSED_RETURN_RATE',
  'LIQUIDITY_DATA_INCOMPLETE',
  'LOW_VOLUME_MARKET_EXPOSURE',
] as const;

export type SmartMoneyScoreResult = {
  wallet: string;
  score: number;
  pnlQuality: number;
  activityScore: number;
  consistencyScore: number;
  officialCandidateScore: number;
  externalQualityScore: number;
  riskPenalty: number;
  eligible: boolean;
  riskFlags: string[];
  scoreVersion: string;
  sourceFetchedAt: Date;
  lastScoredAt: Date;
  displayName: string | null;
  profileSlug: string | null;
  joinedAtText: string | null;
  profileImage: string | null;
  xUsername: string | null;
  predictionCount: number | null;
  holdingsValue: string | null;
  totalPnl: number | null;
  sourceRankWeek: number | null;
  sourceRankMonth: number | null;
  sourceRankAll: number | null;
  officialSourceRankWeek: number | null;
  officialSourceRankMonth: number | null;
  officialSourceRankAll: number | null;
  externalSourceRankWeek: number | null;
  externalSourceRankMonth: number | null;
  externalSourceRankAll: number | null;
  candidatePeriods: string[];
  candidateCategories: string[];
  /** predicting.top 或本地 fallback：与 externalMetricsPeriod 对应行上的胜率 / 总回报代理；夏普已改为本地 ALL×1Y */
  externalWinRate: number | null;
  externalSharpeRatio: number | null;
  externalTotalReturn: number | null;
  /** 权威回撤比率 0~1，与 L1 / 列表共用 */
  maxDrawdownPercent: number | null;
  externalMetricsPeriod: PredictingTopPeriod | null;
  externalMetricsSource: SmartMoneyExternalMetricsSource | null;
  /** 榜单展示：胜率数据来源 */
  winRateSource: LeaderboardWinRateSource | null;
  /** 榜单展示：外部指标来源 badge（与 externalMetricsSource 对齐） */
  metricsSourceBadge: SmartMoneyExternalMetricsSource | null;
  metrics: {
    totalPnl: number | null;
    totalVolume: number | null;
    curveSourcePeriod: string | null;
    recentCurveStrength: number | null;
    maxSpikeRatio: number | null;
    curveCount: number;
    externalCalculatedAt: string | null;
    externalTier: string | null;
  };
  scoreExplain: Record<string, unknown>;
  /** TraderScore / Edge / 分层（P0–P2） */
  traderScore: number | null;
  tier: string | null;
  edgeScore: number | null;
  edgeSampleN: number | null;
  traderType: string | null;
  activeDays: number | null;
  maxWinTradeUsd: number | null;
  maxLossTradeUsd: number | null;
  /** 仿跟单分；null=未就绪（榜前必算门控） */
  copyabilityScore: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function toNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getEligibilityV23Thresholds() {
  return {
    minHighReturnMarketShare: CONFIG.smartMoneyMinHighReturnMarketShare,
    minAvgClosedReturnRate: CONFIG.smartMoneyMinAvgClosedReturnRate,
    minMarketVolumeUsd: CONFIG.smartMoneyMinMarketVolumeUsd,
    minHighVolumeMarketShare: CONFIG.smartMoneyMinHighVolumeMarketShare,
    maxEligibleDrawdown: CONFIG.smartMoneyMaxEligibleDrawdown,
    minClosedMarketsForEligibility: CONFIG.smartMoneyMinClosedMarketsForEligibility,
    minLiquidityClassificationShare: CONFIG.smartMoneyMinLiquidityClassificationShare,
  };
}

function getEligibilityThresholds() {
  return {
    minPredictionCount: CONFIG.smartMoneyMinPredictionCount,
    minHoldingsValue: CONFIG.smartMoneyMinHoldingsValue,
    maxHoldingsValue:
      CONFIG.smartMoneyMaxHoldingsValue > 0 ? CONFIG.smartMoneyMaxHoldingsValue : null,
    minRecentCurveStrength: CONFIG.smartMoneyMinRecentCurveStrength,
    maxSingleSpikeRatio: CONFIG.smartMoneyMaxSingleSpikeRatio,
    minCurvePointCount: CONFIG.smartMoneyMinCurvePointCount,
  };
}

function logScaledScore(value: number | null, baseline: number, fullScoreAt: number): number {
  if (value == null || value <= 0) return 0;
  const safeBaseline = Math.max(1, baseline);
  const safeFullScoreAt = Math.max(safeBaseline + 1, fullScoreAt);
  const numerator = Math.log1p(value / safeBaseline);
  const denominator = Math.log1p(safeFullScoreAt / safeBaseline);
  return clamp((numerator / denominator) * 100, 0, 100);
}

function getCurveSeries(profile: PolymarketProfileFetchResult): Record<string, number[]> {
  const grouped: Record<string, Array<{ ts: number; value: number }>> = {};
  for (const point of profile.curves) {
    const value = Number(point.value);
    if (!Number.isFinite(value)) continue;
    if (!grouped[point.curveType]) {
      grouped[point.curveType] = [];
    }
    grouped[point.curveType].push({ ts: point.ts.getTime(), value });
  }

  const series: Record<string, number[]> = {};
  for (const [curveType, points] of Object.entries(grouped)) {
    points.sort((a, b) => a.ts - b.ts);
    series[curveType] = points.map((point) => point.value);
  }
  return series;
}

export function computeCurveReturnRatio(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  // The profile curve is cumulative P&L dollars, not account equity. A zero/negative
  // starting P&L has no meaningful percent-return denominator, so expose only the
  // absolute change elsewhere instead of inventing a bounded +/-100% proxy.
  if (first <= 0) return null;
  const denominator = Math.max(first, 1e-9);
  return (last - first) / denominator;
}

/** 详情页展示用：过滤累积 PnL 曲线在极小起点上产生的夸张百分比 */
export function computeDisplayCurveReturnRatio(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (first <= 0) return null;
  const change = last - first;
  const minDenominator = Math.max(100, Math.abs(change) * 0.05);
  if (first < minDenominator) return null;
  const ratio = change / Math.max(first, 1e-9);
  if (Math.abs(ratio) > 10) return null;
  return ratio;
}

function computeRecentCurveStrength(
  curveSeries: Record<string, number[]>
): { period: string | null; value: number | null } {
  const preferred = ['PORTFOLIO_PNL_1W', 'PORTFOLIO_PNL_1M', 'PORTFOLIO_PNL_ALL'] as const;
  for (const curveType of preferred) {
    const values = curveSeries[curveType] ?? [];
    const value = computeCurveReturnRatio(values);
    if (value == null) continue;
    return { period: curveType, value };
  }
  return { period: null, value: null };
}

export function getNormalizedStepReturns(values: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const previous = values[i - 1];
    const current = values[i];
    if (previous <= 0) continue;
    const denominator = Math.max(previous, 1e-9);
    returns.push((current - previous) / denominator);
  }
  return returns;
}

export function getPositiveStepRatio(values: number[]): number | null {
  if (values.length < 2) return null;
  const returns = getNormalizedStepReturns(values);
  if (returns.length === 0) return null;
  const positiveCount = returns.filter((value) => value > 0).length;
  return positiveCount / returns.length;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = average(values);
  if (mean == null) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function computeSharpeLikeRatio(values: number[]): number | null {
  const returns = getNormalizedStepReturns(values);
  if (returns.length < 2) return null;
  const mean = average(returns);
  const deviation = standardDeviation(returns);
  if (mean == null) return null;
  if (deviation == null || deviation <= 0.000001) {
    return clamp(mean >= 0 ? 4 : -4, -4, 6);
  }
  return clamp((mean / deviation) * Math.sqrt(Math.min(returns.length, 30)), -4, 6);
}

/**
 * 展示/评分统一：ALL 累计 PnL 曲线截近 365 天（不足则开户至今）的本地夏普代理。
 * 不再使用 predicting.top 等第三方夏普。
 */
export function computeLocalSharpeLikeAll1y(
  profile: PolymarketProfileFetchResult,
  nowMs = Date.now()
): number | null {
  const all = pickPortfolioPnlValues(profile, 'ALL');
  const windowValues = slicePortfolioPnlWindowValues(
    all.values,
    all.timestamps,
    365,
    nowMs
  ).values;
  return computeSharpeLikeRatio(windowValues);
}

/** 详情页等同口径：已分组的 ALL 曲线点（ts ISO / Date）→ ALL×1Y 夏普 */
export function computeLocalSharpeLikeAll1yFromPoints(
  points: Array<{ ts: string | Date; value: number }>,
  nowMs = Date.now()
): number | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => {
    const ta = a.ts instanceof Date ? a.ts.getTime() : Date.parse(String(a.ts));
    const tb = b.ts instanceof Date ? b.ts.getTime() : Date.parse(String(b.ts));
    return ta - tb;
  });
  const values: number[] = [];
  const timestamps: Date[] = [];
  for (const point of sorted) {
    const ts = point.ts instanceof Date ? point.ts : new Date(point.ts);
    if (!Number.isFinite(ts.getTime()) || !Number.isFinite(point.value)) continue;
    values.push(point.value);
    timestamps.push(ts);
  }
  const windowValues = slicePortfolioPnlWindowValues(values, timestamps, 365, nowMs).values;
  return computeSharpeLikeRatio(windowValues);
}

export function computeSortinoLikeRatio(values: number[]): number | null {
  const returns = getNormalizedStepReturns(values);
  if (returns.length < 2) return null;
  const mean = average(returns);
  if (mean == null) return null;
  const downsideSquares = returns
    .filter((value) => value < 0)
    .map((value) => value ** 2);
  if (downsideSquares.length === 0) {
    return mean > 0 ? 6 : 0;
  }
  const downsideDeviation = Math.sqrt(
    downsideSquares.reduce((sum, value) => sum + value, 0) / downsideSquares.length
  );
  if (downsideDeviation <= 0.000001) {
    return clamp(mean >= 0 ? 6 : -4, -4, 8);
  }
  return clamp((mean / downsideDeviation) * Math.sqrt(Math.min(returns.length, 30)), -4, 8);
}

function computeRSquared(values: number[]): number | null {
  if (values.length < 3) return null;
  const xs = values.map((_, index) => index);
  const meanX = average(xs);
  const meanY = average(values);
  if (meanX == null || meanY == null) return null;
  let numerator = 0;
  let denominatorX = 0;
  let denominatorY = 0;
  for (let i = 0; i < values.length; i += 1) {
    const dx = xs[i] - meanX;
    const dy = values[i] - meanY;
    numerator += dx * dy;
    denominatorX += dx * dx;
    denominatorY += dy * dy;
  }
  if (denominatorX <= 0 || denominatorY <= 0) {
    return null;
  }
  const correlation = numerator / Math.sqrt(denominatorX * denominatorY);
  return clamp(correlation ** 2, 0, 1);
}

export function computeDrawdownStats(values: number[]): {
  maxDrawdownPercent: number | null;
  currentDrawdown: number | null;
} {
  // 与榜单权威口径一致：峰权益 MDD，忽略不可靠小峰值（防假 100%）
  const peakDd = computePeakEquityMaxDrawdown(values);
  return {
    maxDrawdownPercent: peakDd.maxDrawdownPercent,
    currentDrawdown: peakDd.currentDrawdown,
  };
}

/**
 * 远古回撤已修复：历史 MDD 显著，但当前已接近回到峰值（水下很浅）。
 * 供 TraderScore 回撤健康 unrecovered 衰减（C10 / §10.4 D）。
 */
export function inferDrawdownRecovered(input: {
  maxDrawdownPercent: number | null | undefined;
  currentDrawdownPercent: number | null | undefined;
  significantMddThreshold?: number;
  recoveredCurrentThreshold?: number;
}): boolean {
  const mdd = input.maxDrawdownPercent;
  const cur = input.currentDrawdownPercent;
  if (mdd == null || !Number.isFinite(mdd) || cur == null || !Number.isFinite(cur)) {
    return false;
  }
  const sig = input.significantMddThreshold ?? 0.4;
  const rec = input.recoveredCurrentThreshold ?? 0.08;
  return mdd >= sig && cur <= rec;
}

export function computeVolatilityLike(values: number[]): number | null {
  const returns = getNormalizedStepReturns(values);
  return standardDeviation(returns);
}

function computeMaxSpikeRatio(curveSeries: Record<string, number[]>): number | null {
  const values = curveSeries.PORTFOLIO_PNL_ALL ?? [];
  if (values.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    deltas.push(Math.abs(values[i] - values[i - 1]));
  }
  const totalMove = deltas.reduce((sum, delta) => sum + delta, 0);
  if (totalMove <= 0) return 0;
  const sorted = [...deltas].sort((a, b) => b - a);
  const singleShare = sorted[0] / totalMove;
  const topMoveCount = Math.min(5, sorted.length);
  const topMovesShare = sorted.slice(0, topMoveCount).reduce((sum, delta) => sum + delta, 0) / totalMove;
  return Math.max(singleShare, topMovesShare);
}

function computeAbsoluteCurveChange(values: number[]): number | null {
  if (values.length < 2) return null;
  return values[values.length - 1] - values[0];
}

function getPreferredCurveValues(curveSeries: Record<string, number[]>): number[] {
  return (
    curveSeries.PORTFOLIO_PNL_1M ??
    curveSeries.PORTFOLIO_PNL_1W ??
    curveSeries.PORTFOLIO_PNL_ALL ??
    []
  );
}

function normalizeWinRate(value: number | null): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;
  return value > 1 ? clamp(value / 100, 0, 1) : clamp(value, 0, 1);
}

function computeWinRateScore(value: number | null): number {
  const normalized = normalizeWinRate(value);
  if (normalized == null) return 0;
  return clamp(((normalized - 0.45) / 0.3) * 100, 0, 100);
}

function computeRoiProxy(totalPnl: number | null, totalVolume: number | null): number | null {
  if (totalPnl == null || totalVolume == null || totalVolume <= 0) return null;
  return totalPnl / totalVolume;
}

function computeProfitScore(input: {
  totalPnl: number | null;
  totalVolume: number | null;
  recentAbsoluteChange: number | null;
  recentCurveStrength: number | null;
}): number {
  const totalPnlScore = logScaledScore(input.totalPnl, 100, 1_000_000);
  const roiScore = normalizeRatioScore(computeRoiProxy(input.totalPnl, input.totalVolume), 0, 0.2);
  const recentReturnScore =
    input.recentCurveStrength == null
      ? logScaledScore(input.recentAbsoluteChange, 50, 50_000)
      : clamp(((input.recentCurveStrength + 0.1) / 0.5) * 100, 0, 100);
  const realizedProxyScore = input.totalPnl != null && input.totalPnl > 0 ? totalPnlScore : 0;
  return roundScore(
    totalPnlScore * 0.3 + roiScore * 0.3 + recentReturnScore * 0.25 + realizedProxyScore * 0.15
  );
}

function computeActivityScore(
  predictionCount: number | null,
  holdingsValue: number | null,
  officialCandidateScore: number,
  tradesPerDay1D: number | null = null
): number {
  const maxTradesPerDay = CONFIG.smartMoneyMaxTradesPerDay;
  const maxHoldingsValue =
    CONFIG.smartMoneyMaxHoldingsValue > 0 ? CONFIG.smartMoneyMaxHoldingsValue : null;
  const predictionScore =
    tradesPerDay1D != null
      ? logScaledScore(Math.max(0, maxTradesPerDay - tradesPerDay1D + 1), 1, maxTradesPerDay)
      : logScaledScore(
          predictionCount,
          Math.max(1, CONFIG.smartMoneyMinPredictionCount),
          Math.max(50, CONFIG.smartMoneyMinPredictionCount * 10)
        );
  const cappedHoldingsValue =
    holdingsValue == null
      ? null
      : maxHoldingsValue != null
        ? Math.min(holdingsValue, maxHoldingsValue)
        : holdingsValue;
  const holdingsScore = logScaledScore(
    cappedHoldingsValue,
    Math.max(1, CONFIG.smartMoneyMinHoldingsValue),
    Math.max(10_000, CONFIG.smartMoneyMinHoldingsValue * 100)
  );
  if (CONFIG.smartMoneyRemoveOfficialCandidateBoost) {
    return roundScore(predictionScore * 0.5625 + holdingsScore * 0.4375);
  }
  return roundScore(predictionScore * 0.45 + holdingsScore * 0.35 + officialCandidateScore * 0.2);
}

function computeMaxLosingStreak(values: number[]): number | null {
  const returns = getNormalizedStepReturns(values);
  if (returns.length === 0) return null;
  let current = 0;
  let max = 0;
  for (const value of returns) {
    if (value < 0) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function computeTailLoss(values: number[]): number | null {
  const returns = getNormalizedStepReturns(values);
  if (returns.length === 0) return null;
  return Math.min(...returns);
}

function computeAverageStepReturn(values: number[]): number | null {
  return average(getNormalizedStepReturns(values));
}

function computeTailLossScore(values: number[]): number {
  const tailLoss = computeTailLoss(values);
  if (tailLoss == null) return 45;
  return clamp((1 - Math.abs(Math.min(tailLoss, 0)) / 0.35) * 100, 0, 100);
}

function computeProfitFactorLike(values: number[]): number | null {
  const returns = getNormalizedStepReturns(values);
  if (returns.length === 0) return null;
  const gains = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (losses <= 0.000001) return gains > 0 ? 5 : null;
  return clamp(gains / losses, 0, 10);
}

function computeDrawdownScore(value: number | null, severeAt: number): number {
  if (value == null) return 45;
  return clamp((1 - value / severeAt) * 100, 0, 100);
}

function computeConsistencyScore(values: number[], maxSpikeRatio: number | null): number {
  const rSquaredScore = (() => {
    const value = computeRSquared(values);
    return value == null ? 0 : value * 100;
  })();
  const positiveStepScore = (() => {
    const ratio = getPositiveStepRatio(values);
    return ratio == null ? 0 : clamp(((ratio - 0.45) / 0.35) * 100, 0, 100);
  })();
  const drawdown = computeDrawdownStats(values);
  const drawdownRecoveryScore =
    drawdown.currentDrawdown == null ? 40 : clamp((1 - drawdown.currentDrawdown / 0.35) * 100, 0, 100);
  const losingStreak = computeMaxLosingStreak(values);
  const losingStreakScore = losingStreak == null ? 40 : clamp((1 - losingStreak / 8) * 100, 0, 100);
  const volatility = computeVolatilityLike(values);
  const volatilityScore = volatility == null ? 40 : clamp((1 - volatility / 0.25) * 100, 0, 100);
  const spikeScore =
    maxSpikeRatio == null
      ? 40
      : clamp((1 - maxSpikeRatio / Math.max(CONFIG.smartMoneyMaxSingleSpikeRatio, 0.0001)) * 100, 0, 100);

  return roundScore(
    rSquaredScore * 0.25 +
      positiveStepScore * 0.25 +
      drawdownRecoveryScore * 0.2 +
      losingStreakScore * 0.15 +
      volatilityScore * 0.1 +
      spikeScore * 0.05
  );
}

/**
 * 统一主胜率（列表 / 详情 / TraderScore / v40）：已平仓市场胜率 MARKET_CLOSED。
 * 时间窗见 SMART_MONEY_PNL_WINDOW_DAYS；不含未平仓浮盈亏。
 */
function resolvePositionMarketWinRate(
  positionPnlStats: PositionPnlStats | null,
  _resolvedTotalPnl: number | null = null
): number | null {
  void _resolvedTotalPnl;
  const closed = positionPnlStats?.closed?.marketWinRate;
  if (closed != null && Number.isFinite(closed)) return closed;
  return null;
}

/** @deprecated 与 resolvePositionMarketWinRate 同口径；保留别名避免旧调用分叉 */
function resolveScoreMarketWinRate(positionPnlStats: PositionPnlStats | null): number | null {
  return resolvePositionMarketWinRate(positionPnlStats);
}

function computeRiskScore(input: {
  values: number[];
  maxSpikeRatio: number | null;
  holdingsValue: number | null;
  totalPnl: number | null;
  openUnderwaterMarketShare: number | null;
}): number {
  const drawdown = computeDrawdownStats(input.values);
  const maxDrawdownScore =
    drawdown.maxDrawdownPercent == null
      ? 40
      : clamp((1 - drawdown.maxDrawdownPercent / 0.6) * 100, 0, 100);
  const currentDrawdownScore =
    drawdown.currentDrawdown == null ? 40 : clamp((1 - drawdown.currentDrawdown / 0.35) * 100, 0, 100);
  const concentrationScore =
    input.maxSpikeRatio == null
      ? 45
      : clamp((1 - input.maxSpikeRatio / Math.max(CONFIG.smartMoneyMaxSingleSpikeRatio, 0.0001)) * 100, 0, 100);
  const tailLoss = computeTailLoss(input.values);
  const tailLossScore = tailLoss == null ? 45 : clamp((1 - Math.abs(Math.min(tailLoss, 0)) / 0.35) * 100, 0, 100);
  const exposureRatio =
    input.holdingsValue != null && input.totalPnl != null && Math.abs(input.totalPnl) > 1
      ? input.holdingsValue / Math.abs(input.totalPnl)
      : null;
  const positionExposureScore = exposureRatio == null ? 55 : clamp((1 - exposureRatio / 4) * 100, 0, 100);
  const positiveStepRatio = getPositiveStepRatio(input.values);
  const stepBiasScore =
    positiveStepRatio == null ? 45 : clamp(((positiveStepRatio - 0.35) / 0.45) * 100, 0, 100);
  const losingStreak = computeMaxLosingStreak(input.values);
  const losingStreakScore = losingStreak == null ? 45 : clamp((1 - losingStreak / 10) * 100, 0, 100);
  const openExposureScore =
    input.openUnderwaterMarketShare == null
      ? 55
      : clamp((1 - input.openUnderwaterMarketShare / 0.75) * 100, 0, 100);

  return roundScore(
    maxDrawdownScore * 0.28 +
      currentDrawdownScore * 0.16 +
      concentrationScore * 0.16 +
      tailLossScore * 0.1 +
      positionExposureScore * 0.07 +
      stepBiasScore * 0.07 +
      losingStreakScore * 0.06 +
      openExposureScore * 0.1
  );
}

function computeTradeQualityScore(input: {
  primaryExternal: PredictingTopWalletMetric | null;
  predictionCount: number | null;
  values: number[];
  positionPnlStats?: PositionPnlStats | null;
}): number {
  const localWinRate = getPositiveStepRatio(input.values);
  const positionWinRate = resolvePositionMarketWinRate(input.positionPnlStats ?? null);
  const winRate =
    normalizeWinRate(input.primaryExternal?.winRate ?? null) ?? positionWinRate ?? localWinRate;
  const winRateScore = computeWinRateScore(winRate);
  const sharpeScore = normalizeRatioScore(input.primaryExternal?.sharpeRatio ?? computeSharpeLikeRatio(input.values), -0.5, 2.5);
  const sortinoScore = normalizeRatioScore(input.primaryExternal?.sortinoRatio ?? computeSortinoLikeRatio(input.values), -0.5, 3.5);
  const profitFactorScore = normalizeRatioScore(input.primaryExternal?.profitFactor ?? null, 1, 2.5);
  const externalDrawdown = input.primaryExternal?.maxDrawdownPercent ?? null;
  const drawdownScore =
    externalDrawdown == null
      ? computeTailLossScore(input.values)
      : computeDrawdownScore(externalDrawdown, 0.5);
  const averageReturnScore = normalizeRatioScore(
    computeAverageStepReturn(input.values),
    -0.01,
    0.05
  );
  const sampleSizeScore = logScaledScore(
    input.predictionCount,
    Math.max(1, CONFIG.smartMoneyMinPredictionCount),
    Math.max(200, CONFIG.smartMoneyMinPredictionCount * 8)
  );
  return roundScore(
    winRateScore * 0.15 +
      sharpeScore * 0.22 +
      sortinoScore * 0.18 +
      profitFactorScore * 0.12 +
      drawdownScore * 0.15 +
      averageReturnScore * 0.08 +
      sampleSizeScore * 0.1
  );
}

/** Predicting.top / 外部源：超过该绝对值的 totalReturn 视为量纲错误（常见为美元 PnL 误标）。 */
const MAX_PLAUSIBLE_PREDICTING_TOP_TOTAL_RETURN = 50;
/** 本地/榜单回报：与本金 ROI 上限对齐。 */
const MAX_PLAUSIBLE_LOCAL_TOTAL_RETURN = MAX_PLAUSIBLE_PRINCIPAL_ROI_RATIO;

function isPlausibleExternalTotalReturn(
  value: number | null,
  externalMetricsSource: SmartMoneyExternalMetricsSource | null
): boolean {
  if (value == null) return false;
  if (externalMetricsSource === 'PREDICTING_TOP') {
    return Math.abs(value) <= MAX_PLAUSIBLE_PREDICTING_TOP_TOTAL_RETURN;
  }
  return Math.abs(value) <= MAX_PLAUSIBLE_LOCAL_TOTAL_RETURN;
}

/**
 * 清洗外部 totalReturn：荒谬值优先回退到本地曲线代理，否则置 null。
 * 避免 predicting.top 把绝对美元 PnL 写入展示列（如 409504 → 页面 +409504%）。
 */
function sanitizeExternalMetricTotalReturn(
  metric: PredictingTopWalletMetric,
  source: Exclude<SmartMoneyExternalPeriodSource, null>,
  localFallback: PredictingTopWalletMetric | null
): PredictingTopWalletMetric {
  if (isPlausibleExternalTotalReturn(metric.totalReturn, source)) {
    return metric;
  }
  const fallbackReturn =
    localFallback != null &&
    isPlausibleExternalTotalReturn(localFallback.totalReturn, 'LOCAL_FALLBACK')
      ? localFallback.totalReturn
      : null;
  if (metric.totalReturn === fallbackReturn) return metric;
  return { ...metric, totalReturn: fallbackReturn };
}

/**
 * 榜单展示用回报：合并清洗后的值一律按「比率」理解，再写成百分数存库
 * （0.35 → 35，对应前端 +35.0%）。|比率|超本金 ROI 上限视为脏数据。
 */
function toLeaderboardDisplayTotalReturnPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (Math.abs(value) > MAX_PLAUSIBLE_LOCAL_TOTAL_RETURN) return null;
  return roundScore(value * 100);
}

function computeDataReconciliation(input: {
  sourceTotalPnl: number | null;
  computedTotalPnl: number | null;
  externalTotalReturn: number | null;
  curveCount: number;
  predictionCount: number | null;
  externalMetricsSource: SmartMoneyExternalMetricsSource | null;
}): {
  dataConfidenceScore: number;
  warnings: string[];
  mismatchRatio: number | null;
  resolvedTotalPnl: number | null;
  resolvedTotalPnlSource: 'profile' | 'curve' | 'external' | null;
} {
  const warnings: string[] = [];
  let confidence = 100;
  const plausibleExternalReturn = isPlausibleExternalTotalReturn(
    input.externalTotalReturn,
    input.externalMetricsSource
  );
  if (input.externalTotalReturn != null && !plausibleExternalReturn) {
    warnings.push('absurd_external_return');
    confidence -= 20;
  }
  const candidates = [
    { source: 'profile' as const, value: input.sourceTotalPnl },
    { source: 'curve' as const, value: input.computedTotalPnl },
    {
      source: 'external' as const,
      value: plausibleExternalReturn ? input.externalTotalReturn : null,
    },
  ].filter((item): item is { source: 'profile' | 'curve' | 'external'; value: number } => item.value != null);

  if (input.sourceTotalPnl == null) {
    warnings.push('missing_profile_total_pnl');
    confidence -= 20;
  }
  if (input.computedTotalPnl == null) {
    warnings.push('missing_curve_total_pnl');
    confidence -= 20;
  }
  if (input.externalMetricsSource == null) {
    warnings.push('missing_external_metrics');
    confidence -= 10;
  }
  if (input.curveCount < getEligibilityThresholds().minCurvePointCount) {
    warnings.push('insufficient_curve_data');
    confidence -= 15;
  }
  if ((input.predictionCount ?? 0) < getEligibilityThresholds().minPredictionCount) {
    warnings.push('low_sample_size');
    confidence -= 15;
  }

  let mismatchRatio: number | null = null;
  if (input.sourceTotalPnl != null && input.computedTotalPnl != null) {
    const denominator = Math.max(Math.abs(input.sourceTotalPnl), Math.abs(input.computedTotalPnl), 1);
    mismatchRatio = Math.abs(input.sourceTotalPnl - input.computedTotalPnl) / denominator;
    if (mismatchRatio > 0.2) {
      warnings.push('pnl_mismatch_major');
      confidence -= 35;
    } else if (mismatchRatio > 0.05) {
      warnings.push('pnl_mismatch_minor');
      confidence -= 15;
    }
  }

  const preferred =
    candidates.find((item) => item.source === 'curve') ??
    candidates.find((item) => item.source === 'profile') ??
    candidates.find((item) => item.source === 'external') ??
    null;

  return {
    dataConfidenceScore: roundScore(clamp(confidence, 0, 100)),
    warnings,
    mismatchRatio: mismatchRatio == null ? null : roundScore(mismatchRatio),
    resolvedTotalPnl: preferred?.value ?? null,
    resolvedTotalPnlSource: preferred?.source ?? null,
  };
}

export type SmartMoneyScoreOptions = {
  /** 近 24h Data API 成交笔数；超阈值会打 HIGH_TRADE_FREQUENCY */
  tradesPerDay1D?: number | null;
  /** 近 7 日成交笔数（榜列 + C6 + §6.2 频率） */
  trades7d?: number | null;
  /** 近 30 日成交笔数（评分池活跃硬门） */
  trades30d?: number | null;
  /** 跟单仿真分；Deep 路径应在打分前算好，禁止默认静默 45 冒充 */
  copyabilityScore?: number | null;
  /** Data API positions 汇总：已平仓 + 未平仓市场胜率 */
  positionPnlStats?: PositionPnlStats | null;
  /** 预计算的钱包市场分类，供 cached/profile-risk 直出，避免列表请求阶段现算 */
  marketCategoryProfile?: SmartMoneyMarketCategoryProfile | null;
  /** 已平仓市场收益分布：在抓取/评分时预计算并缓存，详情页可直接读 DB。 */
  closedMarketReturnDistribution?: ClosedMarketReturnDistribution | null;
  /** Gamma 市场成交量画像：用于 v2.3 大盘口入榜门槛 */
  marketLiquidityProfile?: SmartMoneyMarketLiquidityProfile | null;
  /** 已抓取成交样本：小仓/窄边/30d 日均等跟单不适配特征 */
  tradesSample?: DataApiTrade[] | null;
  /** 未平仓持仓：品类集中 / 碎仓喷洒 */
  openPositions?: DataApiPosition[] | null;
  /** 已平仓原始行：Edge / 最大盈亏单派生（Deep-Gate 已抓，无新增 HTTP） */
  closedRows?: DataApiPosition[] | null;
  /** closed-positions HTTP 是否成功；false 时勿把样本当成真 0 */
  closedFetchOk?: boolean;
  /**
   * Data API trades 窗口是否抓取成功。
   * false 时不打 TRADE_FREQUENCY_UNVERIFIED（缺数 ≠ 无法核实的高频）。
   */
  tradesFetchOk?: boolean;
  /** closed 拉取失败原因（写入 scoreExplain） */
  closedFetchError?: string | null;
  /** 近一年 closed 采集元信息 */
  closedSample?: {
    rowCount: number;
    pageCount: number;
    capped: boolean;
    timedOut: boolean;
    windowDays: number;
    fetchOk: boolean;
  } | null;
  /** 跟单仿真中位持仓秒数（Enrich 后可有） */
  medianHoldingSec?: number | null;
};

function buildEligibilityV23Flags(input: {
  resolvedTotalPnl: number | null;
  preferredCurveValues: number[];
  primaryExternal: PredictingTopWalletMetric | null;
  closedMarketReturnDistribution: ClosedMarketReturnDistribution | null;
  marketLiquidityProfile: SmartMoneyMarketLiquidityProfile | null;
}): string[] {
  const flags: string[] = [];
  const thresholds = getEligibilityV23Thresholds();
  const localDrawdown = computeDrawdownStats(input.preferredCurveValues);
  const effectiveMaxDrawdown =
    input.primaryExternal?.maxDrawdownPercent ?? localDrawdown.maxDrawdownPercent;

  if (input.resolvedTotalPnl == null || input.resolvedTotalPnl <= 0) {
    flags.push('NEGATIVE_TOTAL_PNL');
  }
  if (
    effectiveMaxDrawdown != null &&
    effectiveMaxDrawdown >= thresholds.maxEligibleDrawdown
  ) {
    flags.push('EXCESSIVE_DRAWDOWN');
  }

  const distribution = input.closedMarketReturnDistribution;
  const hasClosedReturnSample =
    distribution != null &&
    distribution.sampledMarketCount >= thresholds.minClosedMarketsForEligibility;
  if (!hasClosedReturnSample) {
    if (distribution == null || distribution.sampledMarketCount === 0) {
      flags.push('CLOSED_RETURN_DATA_MISSING');
    } else {
      flags.push('INSUFFICIENT_CLOSED_MARKETS');
    }
  } else {
    const highReturnShare = computeHighReturnMarketShare(distribution);
    if (
      highReturnShare == null ||
      highReturnShare < thresholds.minHighReturnMarketShare
    ) {
      flags.push('LOW_HIGH_RETURN_MARKET_SHARE');
    }
    const meanReturn = distribution.meanReturn;
    if (
      meanReturn == null ||
      !Number.isFinite(meanReturn) ||
      meanReturn < thresholds.minAvgClosedReturnRate
    ) {
      flags.push('LOW_AVG_CLOSED_RETURN_RATE');
    }
  }

  const liquidityProfile = input.marketLiquidityProfile;
  const hasLiquiditySample =
    liquidityProfile != null &&
    liquidityProfile.classificationShare != null &&
    liquidityProfile.classificationShare >= thresholds.minLiquidityClassificationShare;
  if (!hasLiquiditySample) {
    flags.push('LIQUIDITY_DATA_INCOMPLETE');
  } else if (
    liquidityProfile.highVolumeMarketShare == null ||
    liquidityProfile.highVolumeMarketShare < thresholds.minHighVolumeMarketShare
  ) {
    flags.push('LOW_VOLUME_MARKET_EXPOSURE');
  }

  return flags;
}

function buildRiskFlags(
  profile: PolymarketProfileFetchResult,
  observedTrader: SmartMoneyObservedTraderInput,
  recentCurveStrength: number | null,
  maxSpikeRatio: number | null,
  preferredCurveValues: number[],
  primaryExternal: PredictingTopWalletMetric | null,
  dataWarnings: string[],
  dataConfidenceScore: number,
  tradesPerDay1D: number | null = null,
  positionPnlStats: PositionPnlStats | null = null,
  tradesFetchOk: boolean | undefined = undefined
): string[] {
  const flags: string[] = [];
  const holdingsValue = toNumber(profile.holdingsValue);
  const thresholds = getEligibilityThresholds();

  if (observedTrader.blacklisted) flags.push('BLACKLISTED');
  if (observedTrader.noiseTags.length > 0) flags.push('NOISE_TAGGED');
  if ((profile.predictionCount ?? 0) < thresholds.minPredictionCount) {
    flags.push('LOW_PREDICTION_COUNT');
  }
  if ((holdingsValue ?? 0) < thresholds.minHoldingsValue) {
    flags.push('LOW_HOLDINGS');
  }
  if (recentCurveStrength != null && recentCurveStrength < thresholds.minRecentCurveStrength) {
    flags.push('WEAK_RECENT_PERFORMANCE');
  }
  if (maxSpikeRatio != null && maxSpikeRatio > thresholds.maxSingleSpikeRatio) {
    flags.push('SPIKY_CURVE');
  }
  if (profile.curves.length < thresholds.minCurvePointCount) {
    flags.push('INSUFFICIENT_CURVE_DATA');
  }
  const localWinRate = getPositiveStepRatio(preferredCurveValues);
  const closedPositionStats = positionPnlStats?.closed ?? null;
  const openPositionStats = positionPnlStats?.open ?? null;
  const closedWinRate = closedPositionStats?.marketWinRate ?? null;
  const openWinRate = openPositionStats?.marketWinRate ?? null;
  const compositeWinRate = positionPnlStats?.compositeMarketWinRate ?? null;
  const effectiveWinRate =
    normalizeWinRate(primaryExternal?.winRate ?? null) ??
    compositeWinRate ??
    closedWinRate ??
    localWinRate;
  const profitFactor =
    primaryExternal?.profitFactor ?? computeProfitFactorLike(preferredCurveValues);
  const sampleOk =
    (closedPositionStats?.marketCount ?? 0) >= 10 || (profile.predictionCount ?? 0) >= 200;
  const localDrawdown = computeDrawdownStats(preferredCurveValues);
  const effectiveMaxDrawdown = primaryExternal?.maxDrawdownPercent ?? localDrawdown.maxDrawdownPercent;
  const localTailLoss = computeTailLoss(preferredCurveValues);
  if (
    effectiveWinRate != null &&
    effectiveWinRate >= 0.75 &&
    ((effectiveMaxDrawdown != null && effectiveMaxDrawdown >= 0.3) ||
      (localTailLoss != null && localTailLoss <= -0.25))
  ) {
    flags.push('HIGH_WIN_RATE_TAIL_RISK');
  }
  if (effectiveMaxDrawdown != null && effectiveMaxDrawdown >= 0.45) {
    flags.push('HIGH_DRAWDOWN');
  }
  if (primaryExternal?.currentDrawdown != null && primaryExternal.currentDrawdown >= 0.25) {
    flags.push('CURRENT_DRAWDOWN');
  }
  if (primaryExternal?.profitFactor != null && primaryExternal.profitFactor < 1.05) {
    flags.push('LOW_PROFIT_FACTOR');
  }
  if (primaryExternal?.totalReturn != null && primaryExternal.totalReturn < 0) {
    flags.push('NEGATIVE_TOTAL_RETURN');
  }
  if (dataWarnings.includes('pnl_mismatch_major')) {
    flags.push('DATA_MISMATCH');
  }
  if (dataConfidenceScore < 60) {
    flags.push('LOW_DATA_CONFIDENCE');
  }
  // C2/C10.4：24h 尖峰不硬淘；仅 >硬阈值时打软旗（活动日误杀防护）
  if (
    tradesPerDay1D != null &&
    tradesPerDay1D > CONFIG.smartMoneyMaxTradesPerDayHard
  ) {
    flags.push('ELEVATED_TRADE_FREQUENCY');
  }
  // 仅在「未声明 trades 抓取失败」时保留 UNVERIFIED；上游超时/5xx 不得硬杀进 COLD
  if (
    tradesFetchOk !== false &&
    tradesPerDay1D == null &&
    (profile.predictionCount ?? 0) >= 500
  ) {
    flags.push('TRADE_FREQUENCY_UNVERIFIED');
  }
  if (
    effectiveWinRate != null &&
    effectiveWinRate < 0.35 &&
    sampleOk &&
    (profitFactor ?? 0) > 2.5
  ) {
    flags.push('LOW_WIN_RATE_CONCENTRATED');
  }
  if (
    closedPositionStats?.topMarketPnlShare != null &&
    closedPositionStats.topMarketPnlShare >= 0.55 &&
    (closedWinRate ?? effectiveWinRate ?? 1) < 0.45 &&
    (closedPositionStats.marketCount ?? 0) >= 8
  ) {
    flags.push('SINGLE_HIT_DEPENDENCY');
  } else if (
    closedPositionStats == null &&
    effectiveWinRate != null &&
    effectiveWinRate < 0.35 &&
    (profile.predictionCount ?? 0) >= 500 &&
    (profitFactor ?? 0) >= 5 &&
    (maxSpikeRatio ?? 0) >= 0.25
  ) {
    flags.push('SINGLE_HIT_DEPENDENCY');
  }
  if (
    openPositionStats?.marketWinRate != null &&
    openPositionStats.marketWinRate < 0.35 &&
    (openPositionStats.decisiveMarkets ?? 0) >= 8
  ) {
    flags.push('OPEN_EXPOSURE_UNDERWATER');
  }
  if (
    closedWinRate != null &&
    closedWinRate >= 0.7 &&
    openWinRate != null &&
    openWinRate < 0.4 &&
    (closedPositionStats?.decisiveMarkets ?? 0) >= 8 &&
    (openPositionStats?.decisiveMarkets ?? 0) >= 8 &&
    closedWinRate - openWinRate >= 0.35
  ) {
    flags.push('REALIZED_OPEN_WIN_RATE_GAP');
  }
  const hedgedShare = positionPnlStats?.hedgedPairExposure?.hedgedPairShare ?? null;
  if (hedgedShare != null && hedgedShare >= HEDGED_PAIR_SHARE_THRESHOLD) {
    flags.push('HEDGED_PAIR_EXPOSURE');
  }

  return flags;
}

function computeRiskPenalty(flags: string[]): number {
  let penalty = 0;
  for (const flag of flags) {
    if (flag === 'BLACKLISTED') penalty += 100;
    else if (flag === 'SPIKY_CURVE') penalty += 20;
    else if (flag === 'WEAK_RECENT_PERFORMANCE') penalty += 18;
    else if (flag === 'LOW_PREDICTION_COUNT') penalty += 12;
    else if (flag === 'LOW_HOLDINGS') penalty += 10;
    else if (flag === 'NOISE_TAGGED') penalty += 12;
    else if (flag === 'INSUFFICIENT_CURVE_DATA') penalty += 8;
    else if (flag === 'DATA_MISMATCH') penalty += 25;
    else if (flag === 'LOW_DATA_CONFIDENCE') penalty += 18;
    else if (flag === 'HIGH_WIN_RATE_TAIL_RISK') penalty += 24;
    else if (flag === 'HIGH_DRAWDOWN') penalty += 20;
    else if (flag === 'CURRENT_DRAWDOWN') penalty += 14;
    else if (flag === 'LOW_PROFIT_FACTOR') penalty += 16;
    else if (flag === 'NEGATIVE_TOTAL_RETURN') penalty += 18;
    else if (flag === 'HIGH_TRADE_FREQUENCY') penalty += 22;
    else if (flag === 'TRADE_FREQUENCY_UNVERIFIED') penalty += 18;
    else if (flag === 'MICRO_CLIP_TRADING') penalty += 14;
    else if (flag === 'NARROW_EDGE_ENTRY') penalty += 16;
    else if (flag === 'DUST_POSITION_SPRAY') penalty += 12;
    else if (flag === 'HIGH_DUST_SHARE') penalty += 18;
    else if (flag === 'CATEGORY_MONOCULTURE') penalty += 14;
    else if (flag === 'LIKELY_BOT') penalty += 28;
    else if (flag === 'LOW_COPYABILITY') penalty += 24;
    else if (flag === 'SHORT_HORIZON_MARKET') penalty += 30;
    else if (flag === 'LOW_WIN_RATE_CONCENTRATED') penalty += 22;
    else if (flag === 'SINGLE_HIT_DEPENDENCY') penalty += 26;
    else if (flag === 'OPEN_EXPOSURE_UNDERWATER') penalty += 20;
    else if (flag === 'REALIZED_OPEN_WIN_RATE_GAP') penalty += 18;
    else if (flag === 'HEDGED_PAIR_EXPOSURE') penalty += 40;
  }
  return roundScore(clamp(penalty, 0, 100));
}

/** v2.3 入榜偏好标记：仅展示/挡 eligible，不参与 v2.2 riskPenalty。 */
const V23_DISPLAY_ONLY_RISK_FLAGS = new Set([
  'NEGATIVE_TOTAL_PNL',
  'EXCESSIVE_DRAWDOWN',
  'LOW_HIGH_RETURN_MARKET_SHARE',
  'LOW_AVG_CLOSED_RETURN_RATE',
  'INSUFFICIENT_CLOSED_MARKETS',
  'LOW_VOLUME_MARKET_EXPOSURE',
  'LIQUIDITY_DATA_INCOMPLETE',
]);

export function computeV22RiskPenalty(flags: string[]): number {
  return computeRiskPenalty(flags.filter((flag) => !V23_DISPLAY_ONLY_RISK_FLAGS.has(flag)));
}

export function computeV22ScoreFromComponents(input: {
  profit: number;
  consistency: number;
  risk: number;
  tradeQuality: number;
  activity: number;
  dataConfidence: number;
  riskPenalty: number;
}): number {
  return roundScore(
    clamp(
      input.profit * 0.25 +
        input.consistency * 0.2 +
        input.risk * 0.2 +
        input.tradeQuality * 0.15 +
        input.activity * 0.1 +
        input.dataConfidence * 0.1 -
        input.riskPenalty * 0.35,
      0,
      100
    )
  );
}

function shrinkSubscore(score: number, sampleSize: number, minFullSample: number, median = 50): number {
  const ratio = Math.min(1, sampleSize / Math.max(minFullSample, 1));
  return median + (score - median) * ratio;
}

export function computeBlendedCurveReturn(curveSeries: Record<string, number[]>): number | null {
  const weightedReturns = [
    { curveType: 'PORTFOLIO_PNL_1M', weight: 0.6 },
    { curveType: 'PORTFOLIO_PNL_1W', weight: 0.25 },
    { curveType: 'PORTFOLIO_PNL_ALL', weight: 0.15 },
  ];
  let totalWeight = 0;
  let blended = 0;
  for (const entry of weightedReturns) {
    const values = curveSeries[entry.curveType] ?? [];
    const periodReturn = computeCurveReturnRatio(values);
    if (periodReturn == null) continue;
    blended += periodReturn * entry.weight;
    totalWeight += entry.weight;
  }
  if (totalWeight <= 0) return null;
  return blended / totalWeight;
}

type V31ScoreBreakdown = {
  blendedReturn: number | null;
  performance: number;
  riskAdjusted: number;
  tradeQuality: number;
  shrink: {
    performance: { raw: number; shrunk: number };
    riskAdjusted: { raw: number; shrunk: number };
    tradeQuality: { raw: number; shrunk: number };
    sampleSize: number;
    minFullSample: number;
    populationMedian: number;
  };
  rawScore: number;
  dataConfidenceMultiplier: number;
};

function computeV31SmartMoneyScore(input: {
  pnlQuality: number;
  consistencyScore: number;
  externalQualityScore: number;
  riskPenalty: number;
  dataConfidence: number;
  preferredCurveValues: number[];
  primaryExternal: PredictingTopWalletMetric | null;
  sampleSize: number;
  minFullSample: number;
  blendedReturn: number | null;
}): { score: number; breakdown: V31ScoreBreakdown } {
  const decayReturnScore =
    input.blendedReturn == null ? null : normalizeRatioScore(input.blendedReturn, -0.25, 0.6);
  const basePerformance = input.pnlQuality * 0.55 + input.consistencyScore * 0.45;
  const performance =
    decayReturnScore == null ? basePerformance : basePerformance * 0.7 + decayReturnScore * 0.3;
  const drawdown = computeDrawdownStats(input.preferredCurveValues);
  const sharpe = input.primaryExternal?.sharpeRatio ?? computeSharpeLikeRatio(input.preferredCurveValues);
  const sortino = input.primaryExternal?.sortinoRatio ?? computeSortinoLikeRatio(input.preferredCurveValues);
  const maxDd = input.primaryExternal?.maxDrawdownPercent ?? drawdown.maxDrawdownPercent;
  const sharpeScore = sharpe == null ? 40 : clamp(((sharpe + 0.5) / 3) * 100, 0, 100);
  const sortinoScore = sortino == null ? 40 : clamp(((sortino + 0.5) / 4) * 100, 0, 100);
  const ddScore = maxDd == null ? 40 : clamp((1 - maxDd / 0.6) * 100, 0, 100);
  const riskAdjusted = sharpeScore * 0.4 + sortinoScore * 0.35 + ddScore * 0.25;
  const median = CONFIG.smartMoneyShrinkPopulationMedian ?? 50;
  const sPerformance = shrinkSubscore(performance, input.sampleSize, input.minFullSample, median);
  const sRiskAdjusted = shrinkSubscore(riskAdjusted, input.sampleSize, input.minFullSample, median);
  const sTradeQuality = shrinkSubscore(
    input.externalQualityScore,
    input.sampleSize,
    input.minFullSample,
    median
  );
  const rawScore = clamp(
    sPerformance * 0.35 + sRiskAdjusted * 0.3 + sTradeQuality * 0.2 - input.riskPenalty * 0.3,
    0,
    100
  );
  const dataConfidenceMultiplier = input.dataConfidence / 100;
  return {
    score: roundScore(rawScore * dataConfidenceMultiplier),
    breakdown: {
      blendedReturn: input.blendedReturn,
      performance,
      riskAdjusted,
      tradeQuality: input.externalQualityScore,
      shrink: {
        performance: { raw: performance, shrunk: sPerformance },
        riskAdjusted: { raw: riskAdjusted, shrunk: sRiskAdjusted },
        tradeQuality: { raw: input.externalQualityScore, shrunk: sTradeQuality },
        sampleSize: input.sampleSize,
        minFullSample: input.minFullSample,
        populationMedian: median,
      },
      rawScore,
      dataConfidenceMultiplier,
    },
  };
}

function computeEligibility(flags: string[]): boolean {
  // LOW_HOLDINGS / DATA_MISMATCH：仅软惩罚（riskPenalty），不再挡 eligible。
  const baseEligible =
    !flags.includes('BLACKLISTED') &&
    !flags.includes('NOISE_TAGGED') &&
    !flags.includes('NEGATIVE_TOTAL_PNL') &&
    !flags.includes('LOW_AVG_CLOSED_RETURN_RATE') &&
    !flags.includes('LOW_PREDICTION_COUNT') &&
    !flags.includes('WEAK_RECENT_PERFORMANCE') &&
    !flags.includes('SPIKY_CURVE') &&
    !flags.includes('INSUFFICIENT_CURVE_DATA') &&
    !flags.includes('LOW_DATA_CONFIDENCE') &&
    // HIGH_TRADE_FREQUENCY：软标记，不挡 eligible；质量靠平均盈利率等
    !flags.includes('TRADE_FREQUENCY_UNVERIFIED') &&
    !flags.includes('LIKELY_BOT') &&
    !flags.includes('LOW_COPYABILITY') &&
    // SHORT_HORIZON_MARKET / HIGH_DUST_SHARE：软扣分，不挡 eligible
    !flags.includes('LOW_WIN_RATE_CONCENTRATED') &&
    !flags.includes('SINGLE_HIT_DEPENDENCY') &&
    !flags.includes('OPEN_EXPOSURE_UNDERWATER') &&
    !flags.includes('REALIZED_OPEN_WIN_RATE_GAP') &&
    !flags.includes('HEDGED_PAIR_EXPOSURE');

  if (!baseEligible) return false;
  if (!CONFIG.smartMoneyEnforceV23Gates) return true;
  return !SMART_MONEY_V23_ELIGIBILITY_FLAGS.some((flag) => flags.includes(flag));
}

/** 按当前 riskFlags 判断是否满足 v2.4 / v2.2 入榜门槛（不含粘性）。 */
export function isSmartMoneyEligibleFromFlags(flags: string[]): boolean {
  return computeEligibility(flags);
}

function getBestOfficialSourceRank(observedTrader: SmartMoneyObservedTraderInput): number {
  return Math.min(
    observedTrader.officialSourceRankWeek ?? Number.MAX_SAFE_INTEGER,
    observedTrader.officialSourceRankMonth ?? Number.MAX_SAFE_INTEGER,
    observedTrader.officialSourceRankAll ?? Number.MAX_SAFE_INTEGER
  );
}

function computeOfficialCandidateScore(observedTrader: SmartMoneyObservedTraderInput): number {
  const sourceRank = getBestOfficialSourceRank(observedTrader);
  if (sourceRank === Number.MAX_SAFE_INTEGER) {
    return 0;
  }
  return roundScore(
    clamp(
      ((CONFIG.smartMoneyCandidateLimit - sourceRank + 1) / CONFIG.smartMoneyCandidateLimit) * 100,
      0,
      100
    )
  );
}

function normalizeRatioScore(value: number | null, baseline: number, fullScoreAt: number): number {
  if (value == null) return 0;
  return clamp(((value - baseline) / Math.max(fullScoreAt - baseline, 0.0001)) * 100, 0, 100);
}

function getLocalExternalTier(score: number | null): string | null {
  if (score == null) return null;
  if (score >= 85) return 'Elite';
  if (score >= 70) return 'Great';
  if (score >= 55) return 'Good';
  if (score >= 40) return 'Average';
  return 'Risky';
}

function computeLocalExternalSmartScore(input: {
  winRate: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  rSquared: number | null;
  maxDrawdownPercent: number | null;
  periodReturnRatio: number | null;
}): number {
  const winRateScore = input.winRate == null ? 0 : clamp(input.winRate * 100, 0, 100);
  const sharpeScore = normalizeRatioScore(input.sharpeRatio, -0.5, 2.5);
  const sortinoScore = normalizeRatioScore(input.sortinoRatio, -0.5, 3.5);
  const rSquaredScore = input.rSquared == null ? 0 : clamp(input.rSquared * 100, 0, 100);
  const drawdownScore =
    input.maxDrawdownPercent == null ? 40 : clamp((1 - input.maxDrawdownPercent / 0.6) * 100, 0, 100);
  const returnScore =
    input.periodReturnRatio == null ? 0 : clamp(((input.periodReturnRatio + 0.2) / 0.8) * 100, 0, 100);
  return roundScore(
    winRateScore * 0.25 +
      sharpeScore * 0.2 +
      sortinoScore * 0.15 +
      drawdownScore * 0.15 +
      rSquaredScore * 0.1 +
      returnScore * 0.15
  );
}

function resolveDisplayExternalWinRate(
  externalMetrics: SmartMoneyExternalMetricsInput,
  sourceByPeriod: Record<PredictingTopPeriod, SmartMoneyExternalPeriodSource>,
  positionPnlStats: PositionPnlStats | null,
  resolvedTotalPnl: number | null = null,
  preferredCurveValues: number[] = []
): number | null {
  return resolveLeaderboardWinRateMeta({
    externalMetrics,
    sourceByPeriod,
    positionPnlStats,
    resolvedTotalPnl,
    preferredCurveValues,
  }).winRate;
}

export function resolveLeaderboardWinRateMeta(input: {
  externalMetrics: SmartMoneyExternalMetricsInput;
  sourceByPeriod: Record<PredictingTopPeriod, SmartMoneyExternalPeriodSource>;
  positionPnlStats: PositionPnlStats | null;
  resolvedTotalPnl: number | null;
  preferredCurveValues: number[];
}): {
  winRate: number | null;
  winRateSource: LeaderboardWinRateSource | null;
  /** 仅内部/explain；不得写入 externalWinRate 主展示 */
  curveWinRateProxy: number | null;
} {
  const curveWinRate = getPositiveStepRatio(input.preferredCurveValues);
  const curveWinRateProxy =
    curveWinRate == null ? null : roundScore(curveWinRate);

  // 展示 = 评分：已平仓 MARKET_CLOSED（365 天窗内）；禁止 CURVE_PROXY / composite 冒充主值
  void input.externalMetrics;
  void input.sourceByPeriod;
  void input.resolvedTotalPnl;
  void input.preferredCurveValues;
  const closed = resolvePositionMarketWinRate(input.positionPnlStats, input.resolvedTotalPnl);
  if (closed != null) {
    return {
      winRate: roundScore(closed),
      winRateSource: 'MARKET_CLOSED',
      curveWinRateProxy,
    };
  }
  return {
    winRate: null,
    winRateSource: null,
    curveWinRateProxy,
  };
}

function buildLocalExternalMetric(
  period: PredictingTopPeriod,
  values: number[],
  calculatedAt: Date,
  totalReturnFallback?: number | null,
  positionPnlStats?: PositionPnlStats | null
): PredictingTopWalletMetric | null {
  if (values.length < 2) return null;
  // 优先用成交量本金回报；禁止再回退到激进曲线 (last-first)/first（小起点会通胀成数百%）。
  const displayCurveRatio = computeDisplayCurveReturnRatio(values);
  let totalReturn = totalReturnFallback ?? displayCurveRatio ?? null;
  if (totalReturn != null && Math.abs(totalReturn) > MAX_PLAUSIBLE_LOCAL_TOTAL_RETURN) {
    totalReturn = null;
  }
  const curveWinRate = getPositiveStepRatio(values);
  const displayWinRate = resolvePositionMarketWinRate(positionPnlStats ?? null);
  const sharpeRatio = computeSharpeLikeRatio(values);
  const sortinoRatio = computeSortinoLikeRatio(values);
  const rSquared = computeRSquared(values);
  const { maxDrawdownPercent, currentDrawdown } = computeDrawdownStats(values);
  const profitFactor = computeProfitFactorLike(values);
  const periodReturnRatio = displayCurveRatio ?? totalReturnFallback ?? null;
  const smartScore = computeLocalExternalSmartScore({
    winRate: curveWinRate,
    sharpeRatio,
    sortinoRatio,
    rSquared,
    maxDrawdownPercent,
    periodReturnRatio,
  });
  return {
    period,
    rank: LOCAL_EXTERNAL_METRIC_RANK,
    smartScore,
    sharpeRatio: sharpeRatio == null ? null : roundScore(sharpeRatio),
    sortinoRatio: sortinoRatio == null ? null : roundScore(sortinoRatio),
    winRate: displayWinRate == null ? null : roundScore(displayWinRate),
    profitFactor: profitFactor == null ? null : roundScore(profitFactor),
    totalReturn: totalReturn == null ? null : roundScore(totalReturn),
    maxDrawdownPercent: maxDrawdownPercent == null ? null : roundScore(maxDrawdownPercent),
    currentDrawdown: currentDrawdown == null ? null : roundScore(currentDrawdown),
    rSquared: rSquared == null ? null : roundScore(rSquared),
    calculatedAt,
    tier: getLocalExternalTier(smartScore),
  };
}

function buildLocalExternalMetrics(
  curveSeries: Record<string, number[]>,
  totalPnl: number | null,
  totalVolume: number | null,
  calculatedAt: Date,
  positionPnlStats?: PositionPnlStats | null
): SmartMoneyExternalMetricsInput {
  void totalPnl;
  void totalVolume;
  return {
    '7D': buildLocalExternalMetric(
      '7D',
      curveSeries[LOCAL_PERIOD_CURVE_TYPE['7D']] ?? [],
      calculatedAt,
      undefined,
      positionPnlStats
    ),
    '30D': buildLocalExternalMetric(
      '30D',
      curveSeries[LOCAL_PERIOD_CURVE_TYPE['30D']] ?? [],
      calculatedAt,
      undefined,
      positionPnlStats
    ),
    ALL: buildLocalExternalMetric(
      'ALL',
      curveSeries[LOCAL_PERIOD_CURVE_TYPE.ALL] ?? [],
      calculatedAt,
      undefined,
      positionPnlStats
    ),
  };
}

function computeExternalPeriodQuality(metric: PredictingTopWalletMetric | null): number {
  if (!metric) return 0;
  const smartScore = clamp(metric.smartScore ?? 0, 0, 100);
  const sharpeScore = normalizeRatioScore(metric.sharpeRatio, -0.5, 2.5);
  const sortinoScore = normalizeRatioScore(metric.sortinoRatio, -0.5, 3.5);
  const winRateScore =
    metric.winRate == null ? 0 : clamp((metric.winRate > 1 ? metric.winRate : metric.winRate * 100), 0, 100);
  const drawdownScore =
    metric.maxDrawdownPercent == null
      ? 40
      : clamp((1 - metric.maxDrawdownPercent / 0.5) * 100, 0, 100);
  const rSquaredScore =
    metric.rSquared == null ? 0 : clamp((metric.rSquared > 1 ? metric.rSquared / 100 : metric.rSquared) * 100, 0, 100);
  return roundScore(
    smartScore * 0.35 +
      sharpeScore * 0.15 +
      sortinoScore * 0.15 +
      winRateScore * 0.15 +
      drawdownScore * 0.1 +
      rSquaredScore * 0.1
  );
}

function computeExternalQualityScore(externalMetrics: SmartMoneyExternalMetricsInput): number {
  const weightedPeriods: Array<{ period: PredictingTopPeriod; weight: number }> = [
    { period: 'ALL', weight: 0.5 },
    { period: '30D', weight: 0.3 },
    { period: '7D', weight: 0.2 },
  ];
  let totalWeight = 0;
  let totalScore = 0;
  for (const { period, weight } of weightedPeriods) {
    const metric = externalMetrics[period];
    if (!metric) continue;
    totalWeight += weight;
    totalScore += computeExternalPeriodQuality(metric) * weight;
  }
  if (totalWeight === 0) return 0;
  return roundScore(totalScore / totalWeight);
}

function getLatestExternalCalculatedAt(
  externalMetrics: SmartMoneyExternalMetricsInput
): { calculatedAt: string | null; tier: string | null } {
  const preferred: PredictingTopPeriod[] = ['ALL', '30D', '7D'];
  for (const period of preferred) {
    const metric = externalMetrics[period];
    if (!metric) continue;
    return {
      calculatedAt: metric.calculatedAt?.toISOString() ?? null,
      tier: metric.tier ?? null,
    };
  }
  return { calculatedAt: null, tier: null };
}

function pickPrimaryExternalMetric(
  externalMetrics: SmartMoneyExternalMetricsInput
): PredictingTopWalletMetric | null {
  for (const period of PRIMARY_EXTERNAL_METRIC_PERIODS) {
    const m = externalMetrics[period];
    if (m != null) return m;
  }
  return null;
}

function mergeExternalMetrics(
  externalMetrics: SmartMoneyExternalMetricsInput,
  localExternalMetrics: SmartMoneyExternalMetricsInput
): {
  merged: SmartMoneyExternalMetricsInput;
  sourceByPeriod: Record<PredictingTopPeriod, SmartMoneyExternalPeriodSource>;
  source: SmartMoneyExternalMetricsSource | null;
} {
  const periods: PredictingTopPeriod[] = ['7D', '30D', 'ALL'];
  const merged: SmartMoneyExternalMetricsInput = {
    '7D': null,
    '30D': null,
    ALL: null,
  };
  const sourceByPeriod: Record<PredictingTopPeriod, SmartMoneyExternalPeriodSource> = {
    '7D': null,
    '30D': null,
    ALL: null,
  };
  for (const period of periods) {
    if (externalMetrics[period] != null) {
      merged[period] = sanitizeExternalMetricTotalReturn(
        externalMetrics[period]!,
        'PREDICTING_TOP',
        localExternalMetrics[period]
      );
      sourceByPeriod[period] = 'PREDICTING_TOP';
      continue;
    }
    if (localExternalMetrics[period] != null) {
      merged[period] = sanitizeExternalMetricTotalReturn(
        localExternalMetrics[period]!,
        'LOCAL_FALLBACK',
        null
      );
      sourceByPeriod[period] = 'LOCAL_FALLBACK';
    }
  }
  const usedSources = periods
    .map((period) => sourceByPeriod[period])
    .filter((source): source is Exclude<SmartMoneyExternalPeriodSource, null> => source != null);
  const source =
    usedSources.length === 0
      ? null
      : usedSources.every((value) => value === 'PREDICTING_TOP')
        ? 'PREDICTING_TOP'
        : usedSources.every((value) => value === 'LOCAL_FALLBACK')
          ? 'LOCAL_FALLBACK'
          : 'MIXED';
  return { merged, sourceByPeriod, source };
}

function explainExternalMetric(metric: PredictingTopWalletMetric | null) {
  if (!metric) return null;
  return {
    period: metric.period,
    rank: metric.rank,
    smartScore: metric.smartScore,
    sharpeRatio: metric.sharpeRatio,
    sortinoRatio: metric.sortinoRatio,
    winRate: metric.winRate,
    profitFactor: metric.profitFactor,
    totalReturn: metric.totalReturn,
    maxDrawdownPercent: metric.maxDrawdownPercent,
    currentDrawdown: metric.currentDrawdown,
    rSquared: metric.rSquared,
    calculatedAt: metric.calculatedAt?.toISOString() ?? null,
    tier: metric.tier,
  };
}

export function scoreObservedTraderProfile(
  profile: PolymarketProfileFetchResult,
  observedTrader: SmartMoneyObservedTraderInput,
  externalMetrics: SmartMoneyExternalMetricsInput,
  options?: SmartMoneyScoreOptions
): SmartMoneyScoreResult {
  const tradesPerDay1D = options?.tradesPerDay1D ?? null;
  const trades7d = options?.trades7d ?? null;
  const trades30d = options?.trades30d ?? null;
  const copyabilityScoreOpt = options?.copyabilityScore ?? null;
  const positionPnlStats = options?.positionPnlStats ?? null;
  const marketCategoryProfile = options?.marketCategoryProfile ?? null;
  const closedRowsSample = options?.closedRows ?? null;
  const closedMarketReturnDistribution =
    options?.closedMarketReturnDistribution ??
    (closedRowsSample != null && closedRowsSample.length > 0
      ? buildClosedMarketReturnDistribution(closedRowsSample)
      : null);
  const marketLiquidityProfile = options?.marketLiquidityProfile ?? null;
  const tradesSample = options?.tradesSample ?? null;
  const openPositionsSample = options?.openPositions ?? null;
  const medianHoldingSecOpt = options?.medianHoldingSec ?? null;
  const totalPnl = toNumber(profile.totalPnl);
  const totalVolume = toNumber(profile.totalVolume);
  const holdingsValue = toNumber(profile.holdingsValue);
  const costBasis = positionPnlStats?.open?.totalCostBasis ?? null;
  const deployedPrincipalCandidates = [holdingsValue, costBasis].filter(
    (value): value is number => value != null && Number.isFinite(value) && value > 0
  );
  const deployedPrincipal =
    deployedPrincipalCandidates.length > 0 ? Math.max(...deployedPrincipalCandidates) : null;
  const curveSeries = getCurveSeries(profile);
  const preferredCurveValues = getPreferredCurveValues(curveSeries);
  // profile.totalPnl 是累计口径，只能与 ALL 曲线对账；短窗回退会制造 DATA_MISMATCH。
  const computedTotalPnl = curveSeries.PORTFOLIO_PNL_ALL
    ? computeAbsoluteCurveChange(curveSeries.PORTFOLIO_PNL_ALL)
    : null;
  const snapshotAt =
    profile.snapshotAt instanceof Date && Number.isFinite(profile.snapshotAt.getTime())
      ? profile.snapshotAt
      : new Date();
  const pnlWindows = computeBoardPnlWindowMetrics(
    profile,
    deployedPrincipal,
    snapshotAt.getTime()
  );
  const recentPnl7d = pnlWindows.pnl7d.pnlUsd;
  const recentPnl30d = pnlWindows.pnl30d.pnlUsd;
  const pnl1y = pnlWindows.pnl1y;
  /** 展示夏普：仅本地 ALL×1Y，不读第三方 */
  const localSharpeAll1y = computeLocalSharpeLikeAll1y(profile, snapshotAt.getTime());
  const recentAbsoluteChange = computeAbsoluteCurveChange(
    curveSeries.PORTFOLIO_PNL_1M ?? curveSeries.PORTFOLIO_PNL_1W ?? preferredCurveValues
  );
  const recentCurveStrengthResult = computeRecentCurveStrength(curveSeries);
  const recentCurveStrength = recentCurveStrengthResult.value;
  const maxSpikeRatio = computeMaxSpikeRatio(curveSeries);
  const officialCandidateScore = CONFIG.smartMoneyRemoveOfficialCandidateBoost
    ? 0
    : computeOfficialCandidateScore(observedTrader);
  const localExternalMetrics = buildLocalExternalMetrics(
    curveSeries,
    totalPnl,
    totalVolume,
    snapshotAt,
    positionPnlStats
  );
  const rawExternalPrimary = pickPrimaryExternalMetric(externalMetrics);
  const mergedExternalMetrics = mergeExternalMetrics(externalMetrics, localExternalMetrics);
  const primaryExternal = pickPrimaryExternalMetric(mergedExternalMetrics.merged);
  const reconciliation = computeDataReconciliation({
    sourceTotalPnl: totalPnl,
    computedTotalPnl,
    /** 用清洗前的外部回报触发 absurd 警告；展示值已在 merge 中清洗 */
    externalTotalReturn: rawExternalPrimary?.totalReturn ?? null,
    curveCount: profile.curves.length,
    predictionCount: profile.predictionCount,
    externalMetricsSource: mergedExternalMetrics.source,
  });
  const resolvedTotalPnl = reconciliation.resolvedTotalPnl ?? totalPnl;
  const pnlQuality = computeProfitScore({
    totalPnl: resolvedTotalPnl,
    totalVolume,
    recentAbsoluteChange,
    recentCurveStrength,
  });
  const activityScore = computeActivityScore(
    profile.predictionCount,
    holdingsValue,
    officialCandidateScore,
    tradesPerDay1D
  );
  const consistencyScore = computeConsistencyScore(preferredCurveValues, maxSpikeRatio);
  const riskScore = computeRiskScore({
    values: preferredCurveValues,
    maxSpikeRatio,
    holdingsValue,
    totalPnl: resolvedTotalPnl,
    openUnderwaterMarketShare: positionPnlStats?.open?.underwaterMarketShare ?? null,
  });
  const externalQualityScore = computeTradeQualityScore({
    primaryExternal,
    predictionCount: profile.predictionCount,
    values: preferredCurveValues,
    positionPnlStats,
  });
  const riskFlags = buildRiskFlags(
    profile,
    observedTrader,
    recentCurveStrength,
    maxSpikeRatio,
    preferredCurveValues,
    primaryExternal,
    reconciliation.warnings,
    reconciliation.dataConfidenceScore,
    tradesPerDay1D,
    positionPnlStats,
    options?.tradesFetchOk
  );
  const accountAgeDays =
    estimateAccountAgeDaysFromJoinText(profile.joinedAtText) ??
    estimateAccountAgeDaysFromCurves(profile.curves);
  const copyUnsuitable = detectCopyUnsuitableFlags({
    trades: tradesSample,
    openPositions: openPositionsSample,
    predictionCount: profile.predictionCount,
    accountAgeDays,
    tradesPerDay1D,
    trades30d,
  });
  for (const flag of copyUnsuitable.flags) {
    if (!riskFlags.includes(flag)) riskFlags.push(flag);
  }
  const tradeNotionalStats = computeTradeNotionalStats(
    (tradesSample ?? []).map((trade) => {
      const size = Number((trade as { size?: unknown }).size);
      const price = Number((trade as { price?: unknown }).price);
      if (!Number.isFinite(size) || !Number.isFinite(price)) return null;
      return size * price;
    }),
    CONFIG.smartMoneyDustNotionalUsd
  );
  // 粉尘占比过高：软扣分（原 L1-DUST 硬门），不挡入榜
  if (
    tradeNotionalStats.sampleCount >= CONFIG.smartMoneyL1DustMinSampleCount &&
    CONFIG.smartMoneyL1MaxDustShare > 0 &&
    tradeNotionalStats.dustShare != null &&
    tradeNotionalStats.dustShare >= CONFIG.smartMoneyL1MaxDustShare
  ) {
    if (!riskFlags.includes('HIGH_DUST_SHARE')) riskFlags.push('HIGH_DUST_SHARE');
  }
  if (
    CONFIG.smartMoneyL1MinMedianNotionalUsd > 0 &&
    tradeNotionalStats.sampleCount >= CONFIG.smartMoneyL1DustMinSampleCount &&
    tradeNotionalStats.medianNotionalUsd != null &&
    tradeNotionalStats.medianNotionalUsd < CONFIG.smartMoneyL1MinMedianNotionalUsd
  ) {
    if (!riskFlags.includes('HIGH_DUST_SHARE')) riskFlags.push('HIGH_DUST_SHARE');
  }
  const eligibilityV23Flags = buildEligibilityV23Flags({
    resolvedTotalPnl,
    preferredCurveValues,
    primaryExternal,
    closedMarketReturnDistribution,
    marketLiquidityProfile,
  });
  const riskFlagsForStorage = [...riskFlags];
  for (const flag of eligibilityV23Flags) {
    if (!riskFlagsForStorage.includes(flag)) {
      riskFlagsForStorage.push(flag);
    }
  }
  // closed-positions 请求失败：显式标记，禁止下游把样本当成「真的 0」硬淘汰
  if (options?.closedFetchOk === false) {
    if (!riskFlagsForStorage.includes('CLOSED_POSITIONS_FETCH_FAILED')) {
      riskFlagsForStorage.push('CLOSED_POSITIONS_FETCH_FAILED');
    }
    if (!riskFlagsForStorage.includes('CLOSED_RETURN_DATA_MISSING')) {
      riskFlagsForStorage.push('CLOSED_RETURN_DATA_MISSING');
    }
  }
  const riskPenalty = computeRiskPenalty(riskFlags);
  const eligible = computeEligibility(riskFlagsForStorage);
  const eligibilityV23Thresholds = getEligibilityV23Thresholds();
  const highReturnMarketShare = computeHighReturnMarketShare(closedMarketReturnDistribution);
  const closedMarketSampleCount = closedMarketReturnDistribution?.sampledMarketCount ?? 0;
  const liquidityClassificationShare = marketLiquidityProfile?.classificationShare ?? null;
  const highReturnGateApplied =
    closedMarketReturnDistribution != null &&
    closedMarketSampleCount >= eligibilityV23Thresholds.minClosedMarketsForEligibility;
  const liquidityGateApplied =
    marketLiquidityProfile != null &&
    liquidityClassificationShare != null &&
    liquidityClassificationShare >= eligibilityV23Thresholds.minLiquidityClassificationShare;
  const lastScoredAt = new Date();
  const latestExternal = getLatestExternalCalculatedAt(mergedExternalMetrics.merged);
  const displayExternalWinRate = resolveDisplayExternalWinRate(
    externalMetrics,
    mergedExternalMetrics.sourceByPeriod,
    positionPnlStats,
    resolvedTotalPnl,
    preferredCurveValues
  );
  const winRateMeta = resolveLeaderboardWinRateMeta({
    externalMetrics,
    sourceByPeriod: mergedExternalMetrics.sourceByPeriod,
    positionPnlStats,
    resolvedTotalPnl,
    preferredCurveValues,
  });
  const primaryExternalSource =
    primaryExternal == null ? null : mergedExternalMetrics.sourceByPeriod[primaryExternal.period];

  const v31SampleSize =
    closedMarketSampleCount >= CONFIG.smartMoneyMinClosedMarketsForEligibility
      ? closedMarketSampleCount
      : profile.curves.length;
  const v31MinFullSample =
    closedMarketSampleCount >= CONFIG.smartMoneyMinClosedMarketsForEligibility
      ? CONFIG.smartMoneyMinClosedMarketsForEligibility
      : CONFIG.smartMoneyMinCurvePointCount;
  const blendedCurveReturn = computeBlendedCurveReturn(curveSeries);
  const v31Result =
    CONFIG.smartMoneyScoreVersion === 'v3.1'
      ? computeV31SmartMoneyScore({
          pnlQuality,
          consistencyScore,
          externalQualityScore,
          riskPenalty,
          dataConfidence: reconciliation.dataConfidenceScore,
          preferredCurveValues,
          primaryExternal,
          sampleSize: v31SampleSize,
          minFullSample: v31MinFullSample,
          blendedReturn: blendedCurveReturn,
        })
      : null;

  /** 总盈利率权威口径：近 1 年已平仓事件 Σpnl/Σcost；无样本则为 null（禁止 volume/开仓现货回退） */
  const boardTotalReturn = closedMarketReturnDistribution?.totalReturnRatio ?? null;
  const canonicalBoardMetrics = resolveCanonicalBoardMetrics({
    totalPnl: resolvedTotalPnl,
    totalVolume,
    costBasis,
    holdingsValue,
    closedWindowReturn: closedMarketReturnDistribution
      ? {
          totalReturnRatio: closedMarketReturnDistribution.totalReturnRatio,
          returnPrincipalUsd: closedMarketReturnDistribution.totalCostBasisUsd,
        }
      : null,
    pnlCurveValues: preferredCurveValues,
    metricsSource: mergedExternalMetrics.source,
  });
  /**
   * 展示回撤：仅 ALL 曲线 × 近 1 年（不足则开户至今）同源峰权益 MDD。
   * 禁止回退 preferred(1W/1M) / canonical 短窗曲线，避免「标签 1Y、数字像 7D」。
   */
  const boardMddSanitized = sanitizeMaxDrawdownRatio(
    pnl1y.maxDrawdownRatio,
    CONFIG.smartMoneyMddSaturation,
    {
      peakEquityUsd: null,
      maxDrawdownUsd: pnl1y.maxDrawdownUsd,
      totalPnlUsd: pnl1y.pnlUsd,
    }
  );
  const boardMaxDrawdown = boardMddSanitized.value;
  const boardMaxDrawdownUsd = pnl1y.maxDrawdownUsd;
  const allCurveDd = computeDrawdownStats(curveSeries.PORTFOLIO_PNL_ALL ?? preferredCurveValues);
  const drawdownRecovered = inferDrawdownRecovered({
    maxDrawdownPercent: boardMaxDrawdown ?? allCurveDd.maxDrawdownPercent,
    currentDrawdownPercent: allCurveDd.currentDrawdown,
  });
  // 展示 = 评分：已平仓胜率（SMART_MONEY_PNL_WINDOW_DAYS）
  const scoreWinRateRaw = resolveScoreMarketWinRate(positionPnlStats);
  const scoreWinRate = scoreWinRateRaw == null ? null : roundScore(scoreWinRateRaw);
  const closedMarketCountForScore =
    positionPnlStats?.closed?.decisiveMarkets ??
    positionPnlStats?.closed?.marketCount ??
    null;
  /** 胜率样本数：已平仓 decisive（与主胜率同口径） */
  const winRateSampleN = closedMarketCountForScore;
  /** 展示/门控盈亏比：仅已平仓；禁止曲线/外部回退（无亏损由 profitFactorNoLoss 表达） */
  const pf = positionPnlStats?.closed?.profitFactor ?? null;
  const profitFactorNoLoss = positionPnlStats?.closed?.profitFactorNoLoss === true;
  const closedSampleMeta = options?.closedSample ?? null;
  const sharpeForV40 = localSharpeAll1y;
  const top1Share = positionPnlStats?.closed?.topMarketPnlShare ?? null;
  const volumeFreshRatio =
    totalVolume != null && totalVolume > 0 && tradesPerDay1D != null
      ? clamp((tradesPerDay1D * 30 * 100) / totalVolume, 0, 1)
      : null;

  const v40Result = isSmartMoneyScoreV40Active()
    ? computeSmartMoneyScoreV40({
        dataConfidence: reconciliation.dataConfidenceScore,
        sampleSize: v31SampleSize,
        totalReturn: boardTotalReturn,
        sharpeRatio: sharpeForV40,
        maxDrawdownPercent: boardMaxDrawdown,
        winRate: scoreWinRate,
        profitFactor: pf,
        maxSpikeRatio,
        copyabilityScore: copyabilityScoreOpt,
        recentPnl7d,
        recentPnl30d,
        recentReturn7d: pnlWindows.pnl7d.returnRatio,
        recentReturn30d: pnlWindows.pnl30d.returnRatio,
        recentCoverage7d: pnlWindows.pnl7d.coverageRatio,
        recentCoverage30d: pnlWindows.pnl30d.coverageRatio,
        totalPnl1y: pnl1y.pnlUsd,
        trades7d,
        activityScore,
        consistencyScore,
        highReturnMarketShare,
        top1MarketPnlShare: top1Share,
        volumeFreshRatio,
        tradesPerDay1D,
        hasHighTradeFrequencyFlag: riskFlagsForStorage.includes('HIGH_TRADE_FREQUENCY'),
      })
    : null;

  const score =
    v40Result?.score ??
    v31Result?.score ??
    roundScore(
      clamp(
        pnlQuality * 0.25 +
          consistencyScore * 0.2 +
          riskScore * 0.2 +
          externalQualityScore * 0.15 +
          activityScore * 0.1 +
          reconciliation.dataConfidenceScore * 0.1 -
          riskPenalty * 0.35,
        0,
        100
      )
    );

  const maxInvestedClosed = findMaxInvestedClosedMarket(closedRowsSample ?? []);

  const traderProfile = assembleSmartMoneyTraderProfile({
    closedRows: closedRowsSample,
    totalReturn: boardTotalReturn,
    profitFactor: pf,
    winRate: scoreWinRate,
    closedWinRate: positionPnlStats?.closed?.marketWinRate ?? null,
    closedMarketCount: closedMarketCountForScore,
    copyabilityScore: copyabilityScoreOpt,
    activeDays: accountAgeDays,
    maxDrawdownPercent: boardMaxDrawdown,
    consistencyScore,
    top1MarketPnlShare: top1Share,
    tradesPerDay1D,
    trades7d,
    medianHoldingSec: medianHoldingSecOpt,
    riskFlags: riskFlagsForStorage,
    dominantCategory: marketCategoryProfile?.dominantCategory ?? null,
    totalVolumeUsd: totalVolume,
    pnl1yUsd: pnl1y.pnlUsd,
    pnl30dUsd: pnlWindows.pnl30d.pnlUsd,
    pnl7dUsd: pnlWindows.pnl7d.pnlUsd,
    medianNotionalUsd: tradeNotionalStats.medianNotionalUsd,
    mddUnmeasurable: boardMddSanitized.unmeasurable,
    maxDrawdownUsd: boardMaxDrawdownUsd ?? pnl1y.maxDrawdownUsd,
    totalPnlUsd: pnl1y.pnlUsd,
    mdd7dPercent: pnlWindows.pnl7d.maxDrawdownRatio,
    mdd30dPercent: pnlWindows.pnl30d.maxDrawdownRatio,
    mddAllPercent: boardMaxDrawdown,
    drawdownRecovered,
  });

  const effectiveMaxDrawdown = boardMaxDrawdown;
  const scoreExplain = {
    version: CONFIG.smartMoneyScoreVersion,
    canonicalBoardMetrics,
    eligibilityV23: {
      thresholds: eligibilityV23Thresholds,
      highReturnMarketShare,
      closedMarketSampleCount,
      highReturnGateApplied,
      liquidityGateApplied,
      highVolumeMarketShare: marketLiquidityProfile?.highVolumeMarketShare ?? null,
      liquidityClassificationShare,
      preferenceBonus: CONFIG.smartMoneyRemoveOfficialCandidateBoost
        ? 0
        : officialCandidateScore,
      effectiveMaxDrawdown,
      flags: eligibilityV23Flags,
      passed: eligible,
    },
    formula: v40Result
      ? {
          model: CONFIG.smartMoneyScoreVersion,
          weights: v40Result.weights,
          copyabilityInScore: true,
          displayScoreNoDoubleCount: true,
        }
      : CONFIG.smartMoneyScoreVersion === 'v3.1'
        ? {
            performanceWeight: 0.35,
            riskAdjustedWeight: 0.3,
            tradeQualityWeight: 0.2,
            riskPenaltyWeight: -0.3,
            dataConfidenceMultiplier: true,
          }
        : {
            profitWeight: 0.25,
            consistencyWeight: 0.2,
            riskWeight: 0.2,
            tradeQualityWeight: 0.15,
            activityWeight: 0.1,
            dataConfidenceWeight: 0.1,
            riskPenaltyWeight: -0.35,
          },
    ...(v40Result
      ? {
          v40: {
            factors: v40Result.factors,
            penalties: v40Result.penalties,
            raw: v40Result.raw,
            copyabilityMissing: v40Result.copyabilityMissing,
          },
        }
      : {}),
    winRateMeta: {
      /** 展示 = 评分：MARKET_CLOSED（365 天已平仓） */
      source: winRateMeta.winRateSource,
      curveWinRateProxy: winRateMeta.curveWinRateProxy,
      scoreWinRate,
      scoreWinRateSource: scoreWinRate != null ? ('MARKET_CLOSED' as const) : null,
      pnlWindowDays: SMART_MONEY_PNL_WINDOW_DAYS,
      closedFetchOk: options?.closedFetchOk !== false,
      closedFetchError: options?.closedFetchError ?? null,
    },
    ...(v31Result
      ? {
          v31: v31Result.breakdown,
        }
      : {}),
    components: {
      profit: pnlQuality,
      consistency: consistencyScore,
      risk: riskScore,
      tradeQuality: externalQualityScore,
      activity: activityScore,
      dataConfidence: reconciliation.dataConfidenceScore,
      riskPenalty,
    },
    warnings: reconciliation.warnings,
    resolvedMetrics: {
      totalPnl: reconciliation.resolvedTotalPnl,
      totalPnlSource: reconciliation.resolvedTotalPnlSource,
      pnlMismatchRatio: reconciliation.mismatchRatio,
      totalVolume,
      predictionCount: profile.predictionCount,
      holdingsValue,
      maxHoldingsValue:
        CONFIG.smartMoneyMaxHoldingsValue > 0 ? CONFIG.smartMoneyMaxHoldingsValue : null,
      recentAbsoluteChange,
      recentCurveStrength,
      tradesPerDay1D,
      maxTradesPerDay: CONFIG.smartMoneyMaxTradesPerDay,
    },
    officialSourceRanks: {
      week: observedTrader.officialSourceRankWeek,
      month: observedTrader.officialSourceRankMonth,
      all: observedTrader.officialSourceRankAll,
    },
    externalSourceRanks: {
      week: observedTrader.externalSourceRankWeek,
      month: observedTrader.externalSourceRankMonth,
      all: observedTrader.externalSourceRankAll,
    },
    candidateCategories: observedTrader.candidateCategories,
    candidatePeriods: observedTrader.candidatePeriods,
    externalSources: {
      week: mergedExternalMetrics.sourceByPeriod['7D'],
      month: mergedExternalMetrics.sourceByPeriod['30D'],
      all: mergedExternalMetrics.sourceByPeriod.ALL,
      overall: mergedExternalMetrics.source,
    },
    curve: {
      sourcePeriod: recentCurveStrengthResult.period,
      recentCurveStrength,
      maxSpikeRatio,
      curveCount: profile.curves.length,
    },
    externalPredictingTop: {
      week: explainExternalMetric(externalMetrics['7D']),
      month: explainExternalMetric(externalMetrics['30D']),
      all: explainExternalMetric(externalMetrics.ALL),
    },
    externalLocalFallback: {
      week: explainExternalMetric(localExternalMetrics['7D']),
      month: explainExternalMetric(localExternalMetrics['30D']),
      all: explainExternalMetric(localExternalMetrics.ALL),
    },
    externalMerged: {
      week: explainExternalMetric(mergedExternalMetrics.merged['7D']),
      month: explainExternalMetric(mergedExternalMetrics.merged['30D']),
      all: explainExternalMetric(mergedExternalMetrics.merged.ALL),
    },
    rawMetrics: {
      totalPnl,
      totalVolume,
      computedTotalPnl,
      /** 外部原始 totalReturn（清洗前）；展示列见顶层 externalTotalReturn */
      externalTotalReturnRaw: pickPrimaryExternalMetric(externalMetrics)?.totalReturn ?? null,
      externalTotalReturn: primaryExternal?.totalReturn ?? null,
      predictionCount: profile.predictionCount,
      holdingsValue,
    },
    externalPrimary: primaryExternal
      ? {
          period: primaryExternal.period,
          source: primaryExternalSource,
          winRate: primaryExternal.winRate,
          profitFactor: primaryExternal.profitFactor,
          sharpeRatio: primaryExternal.sharpeRatio,
          totalReturn: primaryExternal.totalReturn,
          maxDrawdownPercent: primaryExternal.maxDrawdownPercent,
          currentDrawdown: primaryExternal.currentDrawdown,
        }
      : null,
    closedPositions: positionPnlStats?.closed
      ? {
          sampleSize: positionPnlStats.closed.sampleSize,
          marketCount: positionPnlStats.closed.marketCount,
          decisiveMarkets: positionPnlStats.closed.decisiveMarkets,
          winningMarkets: positionPnlStats.closed.winningMarkets,
          losingMarkets: positionPnlStats.closed.losingMarkets,
          marketWinRate: positionPnlStats.closed.marketWinRate,
          topMarketPnlShare: positionPnlStats.closed.topMarketPnlShare,
          totalRealizedPnl: positionPnlStats.closed.totalRealizedPnl,
          profitFactor: positionPnlStats.closed.profitFactor,
          profitFactorNoLoss: positionPnlStats.closed.profitFactorNoLoss,
        }
      : null,
    closedSample: closedSampleMeta,
    closedMarketReturnDistribution,
    openPositions: positionPnlStats?.open
      ? {
          sampleSize: positionPnlStats.open.sampleSize,
          marketCount: positionPnlStats.open.marketCount,
          decisiveMarkets: positionPnlStats.open.decisiveMarkets,
          winningMarkets: positionPnlStats.open.winningMarkets,
          marketWinRate: positionPnlStats.open.marketWinRate,
          underwaterMarketShare: positionPnlStats.open.underwaterMarketShare,
          totalUnrealizedPnl: positionPnlStats.open.totalUnrealizedPnl,
          totalCostBasis: positionPnlStats.open.totalCostBasis,
        }
      : null,
    compositeMarketWinRate: positionPnlStats?.compositeMarketWinRate ?? null,
    hedgedPairExposure: positionPnlStats?.hedgedPairExposure
      ? {
          hedgedPairShare: positionPnlStats.hedgedPairExposure.hedgedPairShare,
          hedgedMarketCount: positionPnlStats.hedgedPairExposure.hedgedMarketCount,
          hedgedNotional: positionPnlStats.hedgedPairExposure.hedgedNotional,
          totalOpenNotional: positionPnlStats.hedgedPairExposure.totalOpenNotional,
        }
      : null,
    marketCategoryProfile,
    marketLiquidityProfile,
    copyUnsuitable: copyUnsuitable.metrics,
    /** PolyCop 对齐展示派生（先落 scoreExplain，稳定后再提列） */
    displayProfile: {
      marketsTraded: positionPnlStats?.closed?.marketCount ?? null,
      hedgedMarkets: positionPnlStats?.hedgedPairExposure?.hedgedMarketCount ?? null,
      winRate: positionPnlStats?.closed?.marketWinRate ?? null,
      winRateSampleN,
      closedWinRate: positionPnlStats?.closed?.marketWinRate ?? null,
      openWinRate: positionPnlStats?.open?.marketWinRate ?? null,
      /** 与 winRate 同口径（已平仓）；保留字段便于旧读取方 */
      scoreWinRate,
      profitFactor: pf == null ? null : roundScore(pf),
      /** 有盈利且无亏损市场；前端展示 ∞，勿回退曲线 PF */
      profitFactorNoLoss,
      /** 近窗已平仓市场：盈利/亏损次数（与 PF、胜率 decisive 口径一致） */
      winMarketCount: positionPnlStats?.closed?.winningMarkets ?? null,
      lossMarketCount: positionPnlStats?.closed?.losingMarkets ?? null,
      /** 近窗已平仓事件收益率等权平均；详情「平均盈利率」 */
      avgClosedReturnRate: closedMarketReturnDistribution?.meanReturn ?? null,
      avgClosedReturnSampleN: closedMarketReturnDistribution?.sampledMarketCount ?? null,
      winningMktRoi: closedMarketReturnDistribution?.meanReturn ?? null,
      /** 近 1 年已平仓中投入最大的事件：投入额 + 该事件已实现盈亏 */
      maxInvestedCostUsd: maxInvestedClosed?.costBasisUsd ?? null,
      maxInvestedRealizedPnl: maxInvestedClosed?.realizedPnl ?? null,
      maxInvestedTitle: maxInvestedClosed?.title ?? null,
      maxInvestedConditionId: maxInvestedClosed?.conditionId ?? null,
      maxInvestedSampleN: maxInvestedClosed?.sampleSize ?? null,
      avgPnlPerMarket:
        positionPnlStats?.closed?.totalRealizedPnl != null &&
        (positionPnlStats.closed.marketCount ?? 0) > 0
          ? positionPnlStats.closed.totalRealizedPnl / positionPnlStats.closed.marketCount
          : null,
      avgInvPerMarket: null as number | null,
      recentPnl7d,
      recentPnl30d,
      trades7d,
      trades30d,
      /**
       * 已平仓盈亏（近一年样本 ΣrealizedPnl）。
       * 勿与账户总盈亏（曲线）混淆；禁止回退 pnl1y 曲线美元变化。
       */
      totalPnl1y: closedMarketReturnDistribution?.totalRealizedPnl ?? null,
      closedRealizedPnl1y: closedMarketReturnDistribution?.totalRealizedPnl ?? null,
      pnlWindowDays: pnl1y.actualWindowDays,
      pnlWindowMetrics: pnlWindows,
      /** 近一年 closed 采集工程元信息（产品文案仍写「近一年」，勿写 4000 行） */
      closedSample: closedSampleMeta,
      medianNotionalUsd: tradeNotionalStats.medianNotionalUsd,
      dustShare: tradeNotionalStats.dustShare,
      tradeNotionalSampleCount: tradeNotionalStats.sampleCount,
      capitalTier:
        holdingsValue == null
          ? 'UNKNOWN'
          : holdingsValue > 100_000
            ? 'GT_100K'
            : holdingsValue > 20_000
              ? 'GT_20K'
              : holdingsValue >= 5_000
                ? '5K_20K'
                : 'LT_5K',
      sampleWindowDays: CONFIG.smartMoneyCopyLookbackDays,
      sampleTradeCount: null as number | null,
      lastTradeAt: null as string | null,
      medianHoldingSec: medianHoldingSecOpt,
      avgHoldingSec: null as number | null,
      backtestPnlUsd: null as number | null,
      copyLossRate: null as number | null,
      slippageBpsEffective: null as number | null,
      /** 成交利润率（PnL/volume），勿与总回报混淆 */
      turnoverReturnRatio: canonicalBoardMetrics.turnoverReturnRatio,
      returnPrincipalUsd: canonicalBoardMetrics.returnPrincipalUsd,
      returnPrincipalSource: canonicalBoardMetrics.returnPrincipalSource,
      /** 近 1 年已平仓 Σpnl/Σcost；不可用为 null（展示「—」） */
      totalReturnRatio: canonicalBoardMetrics.totalReturnRatio,
      /** 展示回撤：仅 ALL×1Y；比率 sanitize 后可为 null，金额仍同源窗 */
      maxDrawdownPercent: boardMddSanitized.value,
      maxDrawdownUsd: boardMaxDrawdownUsd,
      mddUnmeasurable: boardMddSanitized.unmeasurable,
      mddWindowDays: pnl1y.actualWindowDays,
      drawdownRecovered,
      currentDrawdownPercent: allCurveDd.currentDrawdown,
      note: 'derived_at_score;closed_event_cost_roi;avg_equal_weight_by_market;mdd_all_curve_1y;sharpe_all_curve_1y;pf_closed_only;backtest_filled_by_copyability_refresh',
      metricsSource: {
        pnl: 'CLOSED_POSITIONS_1Y',
        winRate:
          positionPnlStats?.closed?.marketWinRate != null ? 'CLOSED_POSITIONS' : null,
        return: 'CLOSED_EVENT_COST_ROI',
        avgReturn: 'CLOSED_EVENT_EQUAL_WEIGHT',
        maxDrawdown: 'PORTFOLIO_PNL_ALL_1Y',
        sharpe: 'PORTFOLIO_PNL_ALL_1Y',
        profitFactor: 'CLOSED_POSITIONS',
        copyMetrics: 'SIMULATION',
      },
    },
    traderProfile: traderProfileToExplain(traderProfile),
  } satisfies Record<string, unknown>;

  return {
    wallet: observedTrader.wallet,
    score,
    pnlQuality,
    activityScore,
    consistencyScore,
    officialCandidateScore,
    externalQualityScore,
    riskPenalty,
    eligible,
    riskFlags: riskFlagsForStorage,
    scoreVersion: CONFIG.smartMoneyScoreVersion,
    sourceFetchedAt: snapshotAt,
    lastScoredAt,
    displayName: profile.displayName,
    profileSlug: profile.profileSlug,
    joinedAtText: profile.joinedAtText,
    profileImage: profile.profileImage,
    xUsername: profile.xUsername,
    predictionCount: profile.predictionCount,
    holdingsValue: profile.holdingsValue,
    totalPnl: resolvedTotalPnl,
    sourceRankWeek: unifyPeriodSourceRank(
      observedTrader.officialSourceRankWeek,
      observedTrader.externalSourceRankWeek,
      observedTrader.sourceRankWeek
    ),
    sourceRankMonth: unifyPeriodSourceRank(
      observedTrader.officialSourceRankMonth,
      observedTrader.externalSourceRankMonth,
      observedTrader.sourceRankMonth
    ),
    sourceRankAll: unifyPeriodSourceRank(
      observedTrader.officialSourceRankAll,
      observedTrader.externalSourceRankAll,
      observedTrader.sourceRankAll
    ),
    officialSourceRankWeek: observedTrader.officialSourceRankWeek,
    officialSourceRankMonth: observedTrader.officialSourceRankMonth,
    officialSourceRankAll: observedTrader.officialSourceRankAll,
    externalSourceRankWeek: observedTrader.externalSourceRankWeek,
    externalSourceRankMonth: observedTrader.externalSourceRankMonth,
    externalSourceRankAll: observedTrader.externalSourceRankAll,
    candidatePeriods: observedTrader.candidatePeriods,
    candidateCategories: observedTrader.candidateCategories,
    externalWinRate: displayExternalWinRate,
    externalSharpeRatio: localSharpeAll1y == null ? null : roundScore(localSharpeAll1y),
    externalTotalReturn: toLeaderboardDisplayTotalReturnPercent(
      canonicalBoardMetrics.totalReturnRatio
    ),
    maxDrawdownPercent: boardMaxDrawdown,
    externalMetricsPeriod: primaryExternal?.period ?? null,
    externalMetricsSource: mergedExternalMetrics.source,
    winRateSource: winRateMeta.winRateSource,
    metricsSourceBadge: mergedExternalMetrics.source,
    metrics: {
      totalPnl: resolvedTotalPnl,
      totalVolume,
      curveSourcePeriod: recentCurveStrengthResult.period,
      recentCurveStrength,
      maxSpikeRatio,
      curveCount: profile.curves.length,
      externalCalculatedAt: latestExternal.calculatedAt,
      externalTier: latestExternal.tier,
    },
    scoreExplain,
    traderScore: traderProfile.traderScore.traderScore,
    tier: traderProfile.tier.tier,
    edgeScore: traderProfile.edge.edgeScore,
    edgeSampleN: traderProfile.edge.edgeSampleN,
    traderType: traderProfile.traderType.traderType,
    activeDays: traderProfile.activeDays,
    maxWinTradeUsd: traderProfile.maxWinTradeUsd,
    maxLossTradeUsd: traderProfile.maxLossTradeUsd,
    copyabilityScore: copyabilityScoreOpt,
  };
}
