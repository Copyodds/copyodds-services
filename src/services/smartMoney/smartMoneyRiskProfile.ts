import { prisma } from '../../db';
import {
  computeDisplayCurveReturnRatio,
  computeLocalSharpeLikeAll1yFromPoints,
  computeSharpeLikeRatio,
  computeSortinoLikeRatio,
  computeVolatilityLike,
  getPositiveStepRatio,
} from './smartMoneyScorer';
import {
  getLatestPredictingTopWalletMetrics,
  type PredictingTopPeriod,
  type PredictingTopWalletMetric,
} from '../polymarket/predictingTopLeaderboard';
import {
  fetchPolymarketProfile,
  type PolymarketProfileCurvePoint,
  PolymarketProfileFetchError,
} from '../polymarket/polymarketProfile';
import { buildSmartMoneyTradeActivity, isHighTradeFrequency, resolveTradeActivityWindow, type SmartMoneyTradeActivity } from './smartMoneyTradeActivity';
import { CONFIG } from '../../config/env';
import { isCurveFresh } from './smartMoneyCurveTtl';
import { fetchAndPersistUserPnlCurves } from './smartMoneyUserPnlCurves';
import { getSmartMoneyScoreCache } from './smartMoneyScoreCache';
import { extractLeaderboardDisplayColumns } from './smartMoneyLeaderboardWriter';
import {
  alignScoreExplainTraderProfileToBoard,
  resolveSmartMoneyDisplayAuthority,
} from './smartMoneyDisplayAuthority';
import { extractProfileTotalsFromRawSummary } from './smartMoneyProfilePersist';
import {
  buildBoardEligibilityExplain,
  mergeBoardEligibilityIntoExplain,
  readBoardEligibilityFromExplain,
} from './smartMoneyBoardEligibility';
import { isTraderScoreDisplayComplete } from './smartMoneyScoreCompleteness';
import { isCopyabilityComputed } from './smartMoneyCopyReady';
const SMART_MONEY_RISK_PERIODS = ['1D', '1W', '1M', 'ALL'] as const;
/** 前端图表无需全量小时点；ALL 周期常 1 万+ 点，降采样可显著缩短序列化与传输 */
const MAX_RESPONSE_CURVE_POINTS = 800;

const PERIOD_TO_CURVE_TYPE: Record<SmartMoneyRiskPeriod, string> = {
  '1D': 'PORTFOLIO_PNL_1D',
  '1W': 'PORTFOLIO_PNL_1W',
  '1M': 'PORTFOLIO_PNL_1M',
  ALL: 'PORTFOLIO_PNL_ALL',
};
const PERIOD_TO_EXTERNAL: Partial<Record<SmartMoneyRiskPeriod, PredictingTopPeriod>> = {
  '1W': '7D',
  '1M': '30D',
  ALL: 'ALL',
};

/** 请求周期无点时，向更短窗口回退（上游常只脱水 1D，避免 ALL/1M 整页空图） */
const CURVE_PERIOD_FALLBACK: Record<SmartMoneyRiskPeriod, SmartMoneyRiskPeriod[]> = {
  ALL: ['1M', '1W', '1D'],
  '1M': ['1W', '1D'],
  '1W': ['1D'],
  '1D': [],
};

export type SmartMoneyRiskPeriod = (typeof SMART_MONEY_RISK_PERIODS)[number];

/** profile-risk：live=true 时直连 polymarket.com，并对缺失周期调用 user-pnl-api（与官网切换 1D/1W/1M/ALL 时一致） */
export type GetSmartMoneyRiskProfileOptions = {
  live?: boolean;
  /**
   * 是否拉取 Polymarket Data API 成交活动（tradingActivity）。
   * 默认 false：详情首屏走 DB 快照，避免与管道争用时被上游成交拖到 10s+。
   * 需要成交日序列时由调用方显式传 true（或走 profile-trades 懒加载）。
   */
  includeTradeActivity?: boolean;
};

type JsonObject = Record<string, unknown>;

type SmartMoneyRiskMetricSource = 'LOCAL_CURVE' | 'PREDICTING_TOP' | null;
type SmartMoneyRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' | 'UNKNOWN';

type LatestProfileSnapshot = Awaited<ReturnType<typeof prisma.traderProfileSnapshot.findFirst>>;
type CurvePointRow = Awaited<ReturnType<typeof prisma.traderCurvePoint.findMany>>[number];
type CurvePoint = { ts: string; value: number };
type DailyBacktestBucket = {
  date: string;
  startTs: string;
  endTs: string;
  openValue: number;
  closeValue: number;
  highValue: number;
  lowValue: number;
  pointCount: number;
  intradayPeakValue: number;
  intradayPeakTs: string;
  intradayTroughValue: number;
  intradayTroughTs: string;
  intradayMaxDrawdownValue: number;
  intradayMaxDrawdownRatio: number | null;
  changeValue: number | null;
  changeRatio: number | null;
};

type SmartMoneyScoreExplainV2 = {
  components?: {
    dataConfidence?: unknown;
    risk?: unknown;
    profit?: unknown;
    tradeQuality?: unknown;
    consistency?: unknown;
    activity?: unknown;
  };
  warnings?: unknown;
  resolvedMetrics?: {
    totalPnl?: unknown;
    totalPnlSource?: unknown;
    pnlMismatchRatio?: unknown;
    totalVolume?: unknown;
    predictionCount?: unknown;
    holdingsValue?: unknown;
    tradesPerDay1D?: unknown;
  };
  rawMetrics?: {
    totalPnl?: unknown;
    totalVolume?: unknown;
    computedTotalPnl?: unknown;
    externalTotalReturn?: unknown;
  };
  closedPositions?: {
    totalRealizedPnl?: unknown;
  };
  openPositions?: {
    totalUnrealizedPnl?: unknown;
  };
  closedMarketReturnDistribution?: unknown;
  marketCategoryProfile?: unknown;
  displayProfile?: Record<string, unknown>;
  copyability?: {
    metrics?: Record<string, unknown>;
    options?: Record<string, unknown>;
  };
};

type DistributionBucket = {
  id?: unknown;
  label?: unknown;
  count?: unknown;
  ratio?: unknown;
};

type ReturnDistribution = {
  sampledMarketCount?: unknown;
  sampledDayCount?: unknown;
  meanReturn?: unknown;
  medianReturn?: unknown;
  buckets?: unknown;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getNeededCurveTypes(period: SmartMoneyRiskPeriod): string[] {
  // 只拉当前周期；缺点时再按需补 fallback，避免 ALL 一次扫 1D/1W/1M/ALL 四条曲线打爆 DB
  return [PERIOD_TO_CURVE_TYPE[period]];
}

function getFallbackCurveTypes(period: SmartMoneyRiskPeriod): string[] {
  return CURVE_PERIOD_FALLBACK[period].map((p) => PERIOD_TO_CURVE_TYPE[p]);
}

function downsampleCurvePoints(points: CurvePoint[], maxPoints: number): CurvePoint[] {
  if (points.length <= maxPoints) {
    return points;
  }
  const lastIndex = points.length - 1;
  const sampled: CurvePoint[] = [points[0]!];
  const stride = lastIndex / (maxPoints - 1);
  for (let index = 1; index < maxPoints - 1; index += 1) {
    sampled.push(points[Math.round(index * stride)]!);
  }
  sampled.push(points[lastIndex]!);
  return sampled;
}

function roundMetric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function computeDeltaRatio(startValue: number, endValue: number): number | null {
  if (startValue <= 0) return null;
  const denominator = Math.max(startValue, 1e-9);
  return roundMetric((endValue - startValue) / denominator);
}

function computeDrawdownRatioFromPeak(peakValue: number, troughValue: number): number | null {
  if (peakValue <= 0) return null;
  return roundMetric(clamp((peakValue - troughValue) / Math.max(peakValue, 1e-9), 0, 1));
}

/** 整条曲线相对历史高点的最大回落（可跨 UTC 日），与图表直觉一致 */
function computeWindowPeakDrawdown(points: CurvePoint[]): {
  drawdownValue: number;
  drawdownRatio: number | null;
  peakValue: number;
  troughValue: number;
  peakTs: string;
  troughTs: string;
} | null {
  if (points.length < 2) return null;
  let runningPeak = points[0].value;
  let runningPeakTs = points[0].ts;
  let bestDd = 0;
  let bestPeakValue = runningPeak;
  let bestTroughValue = points[0].value;
  let bestPeakTs = runningPeakTs;
  let bestTroughTs = points[0].ts;

  for (const p of points) {
    if (p.value > runningPeak) {
      runningPeak = p.value;
      runningPeakTs = p.ts;
    }
    const dd = runningPeak - p.value;
    if (dd > bestDd) {
      bestDd = dd;
      bestPeakValue = runningPeak;
      bestTroughValue = p.value;
      bestPeakTs = runningPeakTs;
      bestTroughTs = p.ts;
    }
  }

  if (bestDd <= 1e-9) {
    // 曲线单调不跌：回撤为 0，展示 0%（峰值>0 时），避免前端显示 "--"
    return {
      drawdownValue: 0,
      drawdownRatio: runningPeak > 0 ? 0 : null,
      peakValue: roundMetric(runningPeak) ?? runningPeak,
      troughValue: roundMetric(runningPeak) ?? runningPeak,
      peakTs: runningPeakTs,
      troughTs: runningPeakTs,
    };
  }
  const drawdownRatio = computeDrawdownRatioFromPeak(bestPeakValue, bestTroughValue);
  return {
    drawdownValue: roundMetric(bestDd) ?? bestDd,
    drawdownRatio,
    peakValue: roundMetric(bestPeakValue) ?? bestPeakValue,
    troughValue: roundMetric(bestTroughValue) ?? bestTroughValue,
    peakTs: bestPeakTs,
    troughTs: bestTroughTs,
  };
}

function computeWindowCurrentDrawdown(points: CurvePoint[]): {
  currentDrawdownValue: number;
  currentDrawdownRatio: number | null;
  peakValue: number;
  latestValue: number;
  peakTs: string;
  latestTs: string;
} | null {
  if (points.length < 2) return null;
  let runningPeak = points[0].value;
  let runningPeakTs = points[0].ts;
  for (const point of points) {
    if (point.value > runningPeak) {
      runningPeak = point.value;
      runningPeakTs = point.ts;
    }
  }
  const latest = points[points.length - 1];
  const currentDrawdownValue = Math.max(0, runningPeak - latest.value);
  if (currentDrawdownValue <= 1e-9) {
    return {
      currentDrawdownValue: 0,
      currentDrawdownRatio: 0,
      peakValue: roundMetric(runningPeak) ?? runningPeak,
      latestValue: roundMetric(latest.value) ?? latest.value,
      peakTs: runningPeakTs,
      latestTs: latest.ts,
    };
  }
  return {
    currentDrawdownValue: roundMetric(currentDrawdownValue) ?? currentDrawdownValue,
    currentDrawdownRatio: computeDrawdownRatioFromPeak(runningPeak, latest.value),
    peakValue: roundMetric(runningPeak) ?? runningPeak,
    latestValue: roundMetric(latest.value) ?? latest.value,
    peakTs: runningPeakTs,
    latestTs: latest.ts,
  };
}

function getRequestedPeriodDays(period: SmartMoneyRiskPeriod): number | null {
  if (period === '1D') return 1;
  if (period === '1W') return 7;
  if (period === '1M') return 30;
  return null;
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  const asNumber = toNumber(value);
  return asNumber == null ? null : String(asNumber);
}

function extractVolumeSummary(rawSummary: unknown): {
  totalPnl: string | null;
  totalVolume: string | null;
  realizedPnl: string | null;
  unrealizedPnl: string | null;
} {
  const totals = extractProfileTotalsFromRawSummary(rawSummary);
  const volumeSummary =
    isRecord(rawSummary) && isRecord(rawSummary.volumeSummary)
      ? rawSummary.volumeSummary
      : {};
  return {
    totalPnl: totals.totalPnl,
    totalVolume: totals.totalVolume,
    realizedPnl: toStringValue(
      volumeSummary.realized ?? volumeSummary.realizedPnl ?? volumeSummary.realizedPnlUsd
    ),
    unrealizedPnl: toStringValue(
      volumeSummary.unrealized ?? volumeSummary.unrealizedPnl ?? volumeSummary.unrealizedPnlUsd
    ),
  };
}

function extractScoreExplain(scoreExplain: unknown): SmartMoneyScoreExplainV2 | null {
  return isRecord(scoreExplain) ? (scoreExplain as SmartMoneyScoreExplainV2) : null;
}

function displayTotalReturnPercentFromRatio(ratio: unknown): number | null {
  const n = toNumber(ratio);
  if (n == null) return null;
  return roundMetric(Math.abs(n) <= 1 ? n * 100 : n);
}

function componentScoreString(components: Record<string, unknown> | undefined, key: string): string {
  const n = toNumber(components?.[key]);
  return n != null ? String(roundMetric(n)) : '0';
}

/** 未入榜但已 Deep 分析：从 ScoreCache + scoreExplain 合成详情 summary */
function buildAnalyzedSummaryFromScoreCache(input: {
  wallet: string;
  scoreCache: {
    score: { toString(): string };
    riskFlags: string[];
    scoreExplain: unknown;
    lastScoredAt: Date;
  };
  scoreExplain: SmartMoneyScoreExplainV2 | null;
  scoreExplainRaw: unknown;
  liveProfile: Awaited<ReturnType<typeof fetchPolymarketProfile>> | null;
  latestSnapshot: LatestProfileSnapshot;
  resolvedTotalPnl: string | null;
}) {
  const display =
    input.scoreExplain?.displayProfile && isRecord(input.scoreExplain.displayProfile)
      ? (input.scoreExplain.displayProfile as Record<string, unknown>)
      : {};
  const displayCols = extractLeaderboardDisplayColumns(
    input.scoreExplainRaw as Record<string, unknown> | null | undefined
  );
  const traderExplain = isRecord((input.scoreExplainRaw as Record<string, unknown>)?.traderProfile)
    ? ((input.scoreExplainRaw as Record<string, unknown>).traderProfile as Record<string, unknown>)
    : null;
  const components = isRecord(input.scoreExplain?.components)
    ? (input.scoreExplain!.components as Record<string, unknown>)
    : undefined;
  const closedWinRate =
    toNumber(display.winRate) ??
    toNumber(display.closedWinRate) ??
    toNumber(display.scoreWinRate);
  const totalReturnPct = displayTotalReturnPercentFromRatio(display.totalReturnRatio);
  const maxDdPct = toNumber(display.maxDrawdownPercent);
  const maxDdUsd = toNumber(display.maxDrawdownUsd);
  const maxWinTradeUsd = toNumber(traderExplain?.maxWinTradeUsd);

  return {
    rank: null,
    wallet: input.wallet,
    displayName: input.liveProfile?.displayName ?? input.latestSnapshot?.displayName ?? null,
    profileSlug: input.liveProfile?.profileSlug ?? input.latestSnapshot?.profileSlug ?? null,
    joinedAtText: input.liveProfile?.joinedAtText ?? input.latestSnapshot?.joinedAtText ?? null,
    profileImage: input.liveProfile?.profileImage ?? null,
    xUsername: input.liveProfile?.xUsername ?? null,
    score: input.scoreCache.score.toString(),
    tier: typeof traderExplain?.tier === 'string' ? traderExplain.tier : null,
    traderScore:
      toNumber(
        isRecord(traderExplain?.traderScore)
          ? (traderExplain!.traderScore as Record<string, unknown>).score
          : traderExplain?.traderScore
      ) != null
        ? String(
            roundMetric(
              toNumber(
                isRecord(traderExplain?.traderScore)
                  ? (traderExplain!.traderScore as Record<string, unknown>).score
                  : traderExplain?.traderScore
              )!
            )
          )
        : null,
    edgeScore: null,
    edgeSampleN: null,
    traderType: typeof traderExplain?.traderType === 'string' ? traderExplain.traderType : null,
    pnlQuality: componentScoreString(components, 'profit'),
    activityScore: componentScoreString(components, 'activity'),
    consistencyScore: componentScoreString(components, 'consistency'),
    officialCandidateScore: '0',
    externalQualityScore: componentScoreString(components, 'tradeQuality'),
    riskPenalty: componentScoreString(components, 'riskPenalty'),
    eligible: false,
    predictionCount:
      input.liveProfile?.predictionCount ?? input.latestSnapshot?.predictionCount ?? 0,
    holdingsValue:
      input.liveProfile?.holdingsValue ??
      input.latestSnapshot?.holdingsValue?.toString() ??
      null,
    externalWinRate: closedWinRate != null ? String(roundMetric(closedWinRate)) : null,
    externalSharpeRatio: null,
    externalTotalReturn: totalReturnPct != null ? String(totalReturnPct) : null,
    maxDrawdownPercent: maxDdPct != null ? String(roundMetric(maxDdPct)) : null,
    maxDrawdownUsd: maxDdUsd != null ? String(roundMetric(maxDdUsd)) : null,
    mddUnmeasurable: display.mddUnmeasurable === true,
    externalMetricsPeriod: 'ALL',
    externalMetricsSource: 'LOCAL_FALLBACK',
    flags: input.scoreCache.riskFlags,
    scoreExplain: input.scoreExplainRaw,
    totalPnl: input.resolvedTotalPnl,
    totalPnl1y: displayCols.totalPnl1y != null ? String(displayCols.totalPnl1y) : null,
    pnlWindowDays: displayCols.pnlWindowDays,
    recentPnl7d: displayCols.recentPnl7d != null ? String(displayCols.recentPnl7d) : null,
    trades7d: displayCols.trades7d,
    backtestPnlUsd: displayCols.backtestPnlUsd != null ? String(displayCols.backtestPnlUsd) : null,
    copyLossRate: displayCols.copyLossRate != null ? String(displayCols.copyLossRate) : null,
    slippageBpsEffective: displayCols.slippageBpsEffective,
    winRateSource: closedWinRate != null ? 'MARKET_CLOSED' : null,
    metricsSource: {
      pnl: 'USER_PNL_API',
      winRate: closedWinRate != null ? 'CLOSED_POSITIONS' : null,
      return: 'CAPITAL_ROI',
      copyMetrics: 'SIMULATION',
    },
    copyMetricsNote: '仿真回测：按延迟与滑点假设重放历史成交，非本平台真实跟单用户盈亏',
    lastCurveEnrichAt: null,
    sparkline: null,
    recentMarkets: null,
    biggestWinRecent: maxWinTradeUsd,
    rankScore: null,
    rankScoreComputedAt: null,
    copierFeedback: null,
    copierFeedbackReady: false,
  };
}

function extractScoreWarnings(scoreExplain: SmartMoneyScoreExplainV2 | null): string[] {
  const warnings = scoreExplain?.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((value): value is string => typeof value === 'string');
}

function extractReturnDistribution(raw: unknown): {
  sampledMarketCount?: number;
  sampledDayCount?: number;
  meanReturn: number | null;
  medianReturn: number | null;
  buckets: Array<{ id: string | null; label: string | null; count: number; ratio: number | null }>;
} | null {
  if (!isRecord(raw)) return null;
  const dist = raw as ReturnDistribution;
  const bucketsRaw = Array.isArray(dist.buckets) ? (dist.buckets as DistributionBucket[]) : [];
  return {
    sampledMarketCount: typeof dist.sampledMarketCount === 'number' ? dist.sampledMarketCount : undefined,
    sampledDayCount: typeof dist.sampledDayCount === 'number' ? dist.sampledDayCount : undefined,
    meanReturn: toNumber(dist.meanReturn),
    medianReturn: toNumber(dist.medianReturn),
    buckets: bucketsRaw.map((bucket) => ({
      id: typeof bucket.id === 'string' ? bucket.id : null,
      label: typeof bucket.label === 'string' ? bucket.label : null,
      count: typeof bucket.count === 'number' ? bucket.count : 0,
      ratio: toNumber(bucket.ratio),
    })),
  };
}

function numberToStringOrNull(value: unknown): string | null {
  const n = toNumber(value);
  return n == null ? null : String(n);
}

/** 与 buildCurveGroups 相同分组语义，输入为上游 fetchPolymarketProfile 的曲线点 */
function buildCurveGroupsFromUpstreamCurves(points: PolymarketProfileCurvePoint[]): Record<
  string,
  Array<{ ts: string; value: number }>
> {
  const grouped: Record<string, Array<{ ts: string; value: number }>> = {};
  for (const point of points) {
    const value = Number(point.value);
    if (!Number.isFinite(value)) continue;
    if (!grouped[point.curveType]) {
      grouped[point.curveType] = [];
    }
    grouped[point.curveType].push({
      ts: point.ts.toISOString(),
      value,
    });
  }
  for (const curveType of Object.keys(grouped)) {
    grouped[curveType].sort((left, right) => left.ts.localeCompare(right.ts));
  }
  return grouped;
}

function buildCurveGroups(points: CurvePointRow[]): Record<string, Array<{ ts: string; value: number }>> {
  const grouped: Record<string, Array<{ ts: string; value: number }>> = {};
  for (const point of points) {
    const value = Number(point.value);
    if (!Number.isFinite(value)) continue;
    if (!grouped[point.curveType]) {
      grouped[point.curveType] = [];
    }
    grouped[point.curveType].push({
      ts: point.ts.toISOString(),
      value,
    });
  }

  for (const curveType of Object.keys(grouped)) {
    grouped[curveType].sort((left, right) => left.ts.localeCompare(right.ts));
  }

  return grouped;
}

/** live 模式下：同一 curveType 上游有点则用上源，否则用 DB（避免官网 __NEXT_DATA__ 未脱水曲线时整页无图） */
function mergeCurveGroupsPreferUpstream(
  upstream: Record<string, Array<{ ts: string; value: number }>>,
  db: Record<string, Array<{ ts: string; value: number }>>
): Record<string, Array<{ ts: string; value: number }>> {
  const merged: Record<string, Array<{ ts: string; value: number }>> = {};
  const curveTypes = new Set([...Object.keys(upstream), ...Object.keys(db)]);
  for (const curveType of curveTypes) {
    const u = upstream[curveType] ?? [];
    const d = db[curveType] ?? [];
    merged[curveType] = u.length > 0 ? u : d;
  }
  return merged;
}

function compareMetricAsc(left: number | null, right: number | null): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left - right;
}

function dayKeyToUtcMs(dayKey: string): number | null {
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function summarizeDailyBucket(bucket: DailyBacktestBucket) {
  return {
    date: bucket.date,
    startTs: bucket.startTs,
    endTs: bucket.endTs,
    openValue: roundMetric(bucket.openValue),
    closeValue: roundMetric(bucket.closeValue),
    highValue: roundMetric(bucket.highValue),
    lowValue: roundMetric(bucket.lowValue),
    pointCount: bucket.pointCount,
    changeValue: bucket.changeValue,
    changeRatio: bucket.changeRatio,
    intradayMaxDrawdownValue: roundMetric(bucket.intradayMaxDrawdownValue),
    intradayMaxDrawdownRatio: bucket.intradayMaxDrawdownRatio,
    intradayPeakValue: roundMetric(bucket.intradayPeakValue),
    intradayPeakTs: bucket.intradayPeakTs,
    intradayTroughValue: roundMetric(bucket.intradayTroughValue),
    intradayTroughTs: bucket.intradayTroughTs,
  };
}

function buildDailyBacktestBuckets(points: CurvePoint[]): DailyBacktestBucket[] {
  const buckets = new Map<
    string,
    DailyBacktestBucket & {
      runningPeakValue: number;
      runningPeakTs: string;
    }
  >();

  for (const point of points) {
    const dayKey = point.ts.slice(0, 10);
    const existing = buckets.get(dayKey);
    if (!existing) {
      buckets.set(dayKey, {
        date: dayKey,
        startTs: point.ts,
        endTs: point.ts,
        openValue: point.value,
        closeValue: point.value,
        highValue: point.value,
        lowValue: point.value,
        pointCount: 1,
        intradayPeakValue: point.value,
        intradayPeakTs: point.ts,
        intradayTroughValue: point.value,
        intradayTroughTs: point.ts,
        intradayMaxDrawdownValue: 0,
        intradayMaxDrawdownRatio: 0,
        changeValue: 0,
        changeRatio: 0,
        runningPeakValue: point.value,
        runningPeakTs: point.ts,
      });
      continue;
    }

    existing.highValue = Math.max(existing.highValue, point.value);
    existing.lowValue = Math.min(existing.lowValue, point.value);
    existing.endTs = point.ts;
    existing.closeValue = point.value;
    existing.pointCount += 1;

    if (point.value > existing.runningPeakValue) {
      existing.runningPeakValue = point.value;
      existing.runningPeakTs = point.ts;
    }

    const drawdownValue = existing.runningPeakValue - point.value;
    const normalizedDrawdownRatio = computeDrawdownRatioFromPeak(existing.runningPeakValue, point.value);
    if (
      drawdownValue > existing.intradayMaxDrawdownValue ||
      (drawdownValue === existing.intradayMaxDrawdownValue &&
        compareMetricAsc(normalizedDrawdownRatio, existing.intradayMaxDrawdownRatio) > 0)
    ) {
      existing.intradayMaxDrawdownValue = drawdownValue;
      existing.intradayMaxDrawdownRatio = normalizedDrawdownRatio;
      existing.intradayPeakValue = existing.runningPeakValue;
      existing.intradayPeakTs = existing.runningPeakTs;
      existing.intradayTroughValue = point.value;
      existing.intradayTroughTs = point.ts;
    }
  }

  // 日收益 = 当日末点相对前一自然日末点（稀疏曲线常每日仅 1 点，不能用「当日首点→末点」）
  const sorted = Array.from(buckets.values()).sort((left, right) => left.date.localeCompare(right.date));
  let priorClose: number | null = null;
  return sorted.map((bucket) => {
    const hasPriorDay = priorClose != null;
    const openValue: number = hasPriorDay ? priorClose! : bucket.openValue;
    const closeValue = bucket.closeValue;
    const changeValue = hasPriorDay ? roundMetric(closeValue - openValue) : null;
    const changeRatio = hasPriorDay ? computeDeltaRatio(openValue, closeValue) : null;
    priorClose = closeValue;
    return {
      date: bucket.date,
      startTs: bucket.startTs,
      endTs: bucket.endTs,
      openValue,
      closeValue,
      highValue: bucket.highValue,
      lowValue: bucket.lowValue,
      pointCount: bucket.pointCount,
      intradayPeakValue: bucket.intradayPeakValue,
      intradayPeakTs: bucket.intradayPeakTs,
      intradayTroughValue: bucket.intradayTroughValue,
      intradayTroughTs: bucket.intradayTroughTs,
      intradayMaxDrawdownValue: bucket.intradayMaxDrawdownValue,
      intradayMaxDrawdownRatio: roundMetric(bucket.intradayMaxDrawdownRatio),
      changeValue,
      changeRatio,
    };
  });
}

function buildLosingStreakMetrics(dailyBuckets: DailyBacktestBucket[]) {
  let currentLength = 0;
  let currentStartDate: string | null = null;
  let longestLength = 0;
  let longestStartDate: string | null = null;
  let longestEndDate: string | null = null;

  for (const bucket of dailyBuckets) {
    const isLosingDay = (bucket.changeValue ?? 0) < 0;
    if (isLosingDay) {
      currentLength += 1;
      currentStartDate ??= bucket.date;
      if (currentLength > longestLength) {
        longestLength = currentLength;
        longestStartDate = currentStartDate;
        longestEndDate = bucket.date;
      }
      continue;
    }

    currentLength = 0;
    currentStartDate = null;
  }

  const lastBucket = dailyBuckets[dailyBuckets.length - 1] ?? null;
  const currentStreakDays =
    currentLength > 0 && lastBucket && (lastBucket.changeValue ?? 0) < 0 ? currentLength : 0;
  const currentStreakStartDate = currentStreakDays > 0 ? currentStartDate : null;

  return {
    longestLosingStreakDays: longestLength,
    longestLosingStreakStartDate: longestStartDate,
    longestLosingStreakEndDate: longestEndDate,
    currentLosingStreakDays: currentStreakDays,
    currentLosingStreakStartDate: currentStreakStartDate,
  };
}

function pickWorstRollingWindow(dailyBuckets: DailyBacktestBucket[], windowDays: number) {
  if (dailyBuckets.length === 0) {
    return null;
  }

  type RollingCandidate = {
    startDate: string;
    endDate: string;
    startTs: string;
    endTs: string;
    openValue: number;
    closeValue: number;
    changeValue: number | null;
    changeRatio: number | null;
    sampledDayCount: number;
    calendarDaySpan: number;
    hasFullWindow: boolean;
  };

  const candidates: RollingCandidate[] = [];
  for (let startIndex = 0; startIndex < dailyBuckets.length; startIndex += 1) {
    const startBucket = dailyBuckets[startIndex];
    const startMs = dayKeyToUtcMs(startBucket.date);
    if (startMs == null) continue;

    for (let endIndex = startIndex; endIndex < dailyBuckets.length; endIndex += 1) {
      const endBucket = dailyBuckets[endIndex];
      const endMs = dayKeyToUtcMs(endBucket.date);
      if (endMs == null) continue;

      const calendarDaySpan = Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
      if (calendarDaySpan > windowDays) {
        break;
      }

      candidates.push({
        startDate: startBucket.date,
        endDate: endBucket.date,
        startTs: startBucket.startTs,
        endTs: endBucket.endTs,
        openValue: startBucket.openValue,
        closeValue: endBucket.closeValue,
        changeValue: roundMetric(endBucket.closeValue - startBucket.openValue),
        changeRatio: computeDeltaRatio(startBucket.openValue, endBucket.closeValue),
        sampledDayCount: endIndex - startIndex + 1,
        calendarDaySpan,
        hasFullWindow: calendarDaySpan >= windowDays,
      });
    }
  }

  const pool = candidates.some((candidate) => candidate.hasFullWindow)
    ? candidates.filter((candidate) => candidate.hasFullWindow)
    : candidates;

  const worst = pool.reduce((selected, candidate) => {
    if (selected == null) return candidate;
    const ratioCmp = compareMetricAsc(candidate.changeRatio, selected.changeRatio);
    if (ratioCmp !== 0) return ratioCmp < 0 ? candidate : selected;
    const valueCmp = compareMetricAsc(candidate.changeValue, selected.changeValue);
    if (valueCmp !== 0) return valueCmp < 0 ? candidate : selected;
    return candidate.calendarDaySpan > selected.calendarDaySpan ? candidate : selected;
  }, null as RollingCandidate | null);

  if (!worst) {
    return null;
  }

  return {
    windowDays,
    startDate: worst.startDate,
    endDate: worst.endDate,
    startTs: worst.startTs,
    endTs: worst.endTs,
    openValue: roundMetric(worst.openValue),
    closeValue: roundMetric(worst.closeValue),
    changeValue: worst.changeValue,
    changeRatio: worst.changeRatio,
    sampledDayCount: worst.sampledDayCount,
    calendarDaySpan: worst.calendarDaySpan,
    hasFullWindow: worst.hasFullWindow,
  };
}

type DailyReturnDistributionRange = {
  id: string;
  label: string;
  test: (value: number) => boolean;
};

/** 日收益分布分桶：在原先 5 档基础上拆细负/正侧与尾部区间。 */
const DAILY_RETURN_DISTRIBUTION_RANGES: DailyReturnDistributionRange[] = [
  { id: 'leMinus5', label: '<= -5%', test: (value) => value <= -0.05 },
  { id: 'minus5ToMinus2', label: '-5% to -2%', test: (value) => value > -0.05 && value <= -0.02 },
  { id: 'minus2ToMinus1', label: '-2% to -1%', test: (value) => value > -0.02 && value <= -0.01 },
  { id: 'minus1ToZero', label: '-1% to 0%', test: (value) => value > -0.01 && value < 0 },
  { id: 'zeroToPlus1', label: '0% to +1%', test: (value) => value >= 0 && value < 0.01 },
  { id: 'plus1ToPlus2', label: '+1% to +2%', test: (value) => value >= 0.01 && value < 0.02 },
  { id: 'plus2ToPlus5', label: '+2% to +5%', test: (value) => value >= 0.02 && value < 0.05 },
  { id: 'plus5ToPlus10', label: '+5% to +10%', test: (value) => value >= 0.05 && value < 0.1 },
  { id: 'gePlus10', label: '>= +10%', test: (value) => value >= 0.1 },
];

function buildDailyReturnDistribution(dailyBuckets: DailyBacktestBucket[]) {
  const ratios = dailyBuckets
    .map((bucket) => bucket.changeRatio)
    .filter((value): value is number => value != null && Number.isFinite(value));

  if (ratios.length === 0) {
    return {
      sampledDayCount: 0,
      meanReturn: null,
      medianReturn: null,
      buckets: [],
    };
  }

  const sortedRatios = [...ratios].sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedRatios.length / 2);
  const medianReturn =
    sortedRatios.length % 2 === 0
      ? roundMetric((sortedRatios[middleIndex - 1] + sortedRatios[middleIndex]) / 2)
      : roundMetric(sortedRatios[middleIndex]);
  const meanReturn = roundMetric(sortedRatios.reduce((sum, value) => sum + value, 0) / sortedRatios.length);

  return {
    sampledDayCount: ratios.length,
    meanReturn,
    medianReturn,
    buckets: DAILY_RETURN_DISTRIBUTION_RANGES.map((range) => {
      const count = ratios.filter(range.test).length;
      return {
        id: range.id,
        label: range.label,
        count,
        ratio: roundMetric(count / ratios.length),
      };
    }),
  };
}

function buildCurveBacktestMetrics(points: CurvePoint[]) {
  if (points.length < 2) {
    return {
      sampledDayCount: 0,
      positiveDayRatio: null,
      negativeDayRatio: null,
      maxStepGainValue: null,
      maxStepLossValue: null,
      bestDay: null,
      worstDay: null,
      dailyReturnDistribution: {
        sampledDayCount: 0,
        meanReturn: null,
        medianReturn: null,
        buckets: [],
      },
      losingStreaks: {
        longestLosingStreakDays: 0,
        longestLosingStreakStartDate: null,
        longestLosingStreakEndDate: null,
        currentLosingStreakDays: 0,
        currentLosingStreakStartDate: null,
      },
      rollingWorst7D: null,
      rollingWorst30D: null,
      worstIntradayDrawdownDay: null,
      windowPeakDrawdown: null,
    };
  }

  let maxStepGainValue: number | null = null;
  let maxStepLossValue: number | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].value - points[index - 1].value;
    if (maxStepGainValue == null || delta > maxStepGainValue) {
      maxStepGainValue = delta;
    }
    if (maxStepLossValue == null || delta < maxStepLossValue) {
      maxStepLossValue = delta;
    }
  }

  const dailyBuckets = buildDailyBacktestBuckets(points).filter((bucket) => bucket.changeValue != null);
  const positiveDayCount = dailyBuckets.filter((bucket) => (bucket.changeValue ?? 0) > 0).length;
  const negativeDayCount = dailyBuckets.filter((bucket) => (bucket.changeValue ?? 0) < 0).length;
  const dailyReturnDistribution = buildDailyReturnDistribution(dailyBuckets);
  const losingStreaks = buildLosingStreakMetrics(dailyBuckets);
  const rollingWorst7D = pickWorstRollingWindow(dailyBuckets, 7);
  const rollingWorst30D = pickWorstRollingWindow(dailyBuckets, 30);

  const bestDay =
    dailyBuckets.length === 0
      ? null
      : dailyBuckets.reduce((best, bucket) =>
          (bucket.changeValue ?? Number.NEGATIVE_INFINITY) > (best.changeValue ?? Number.NEGATIVE_INFINITY)
            ? bucket
            : best
        );
  const worstDay =
    dailyBuckets.length === 0
      ? null
      : dailyBuckets.reduce((worst, bucket) =>
          (bucket.changeValue ?? Number.POSITIVE_INFINITY) < (worst.changeValue ?? Number.POSITIVE_INFINITY)
            ? bucket
            : worst
        );
  const worstIntradayDrawdownDay =
    dailyBuckets.length === 0
      ? null
      : dailyBuckets.reduce((worst, bucket) => {
          const valueCmp = compareMetricAsc(
            worst.intradayMaxDrawdownValue,
            bucket.intradayMaxDrawdownValue
          );
          if (valueCmp !== 0) {
            return valueCmp < 0 ? bucket : worst;
          }
          const ratioCmp = compareMetricAsc(
            worst.intradayMaxDrawdownRatio,
            bucket.intradayMaxDrawdownRatio
          );
          return ratioCmp < 0 ? bucket : worst;
        });

  const windowPeakDrawdown = computeWindowPeakDrawdown(points);

  return {
    sampledDayCount: dailyBuckets.length,
    positiveDayRatio: dailyBuckets.length > 0 ? roundMetric(positiveDayCount / dailyBuckets.length) : null,
    negativeDayRatio: dailyBuckets.length > 0 ? roundMetric(negativeDayCount / dailyBuckets.length) : null,
    maxStepGainValue: roundMetric(maxStepGainValue),
    maxStepLossValue: roundMetric(maxStepLossValue),
    bestDay: bestDay ? summarizeDailyBucket(bestDay) : null,
    worstDay: worstDay ? summarizeDailyBucket(worstDay) : null,
    dailyReturnDistribution,
    losingStreaks,
    rollingWorst7D,
    rollingWorst30D,
    worstIntradayDrawdownDay: worstIntradayDrawdownDay ? summarizeDailyBucket(worstIntradayDrawdownDay) : null,
    windowPeakDrawdown,
  };
}

function getCurveCoverageMeta(
  period: SmartMoneyRiskPeriod,
  points: Array<{ ts: string; value: number }>
): {
  startTs: string | null;
  endTs: string | null;
  coverageDays: number | null;
  requestedPeriodDays: number | null;
  hasFullRequestedWindow: boolean | null;
} {
  if (points.length === 0) {
    return {
      startTs: null,
      endTs: null,
      coverageDays: null,
      requestedPeriodDays: getRequestedPeriodDays(period),
      hasFullRequestedWindow: null,
    };
  }

  const startTs = points[0].ts;
  const endTs = points[points.length - 1].ts;
  const startMs = Date.parse(startTs);
  const endMs = Date.parse(endTs);
  const coverageDays =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? roundMetric((endMs - startMs) / (24 * 60 * 60 * 1000)) : null;
  const requestedPeriodDays = getRequestedPeriodDays(period);

  return {
    startTs,
    endTs,
    coverageDays,
    requestedPeriodDays,
    hasFullRequestedWindow:
      requestedPeriodDays == null || coverageDays == null ? null : coverageDays >= requestedPeriodDays - 0.25,
  };
}

function getRiskLevel(riskScore: number | null): SmartMoneyRiskLevel {
  if (riskScore == null) return 'UNKNOWN';
  if (riskScore < 25) return 'LOW';
  if (riskScore < 50) return 'MEDIUM';
  if (riskScore < 75) return 'HIGH';
  return 'EXTREME';
}

function buildRiskScore(input: {
  riskPenalty: number | null;
  maxDrawdownPercent: number | null;
  currentDrawdown: number | null;
  volatilityProxy: number | null;
  sharpeLike: number | null;
}): number | null {
  const hasSignal =
    input.riskPenalty != null ||
    input.maxDrawdownPercent != null ||
    input.currentDrawdown != null ||
    input.volatilityProxy != null ||
    input.sharpeLike != null;
  if (!hasSignal) return null;

  const basePenalty = input.riskPenalty ?? 0;
  const maxDrawdownPenalty = (input.maxDrawdownPercent ?? 0) * 45;
  const currentDrawdownPenalty = (input.currentDrawdown ?? 0) * 20;
  const volatilityPenalty = Math.min((input.volatilityProxy ?? 0) * 400, 15);
  const sharpePenalty =
    input.sharpeLike == null || input.sharpeLike >= 0 ? 0 : Math.min(Math.abs(input.sharpeLike) * 8, 12);

  return roundMetric(
    clamp(basePenalty + maxDrawdownPenalty + currentDrawdownPenalty + volatilityPenalty + sharpePenalty, 0, 100)
  );
}

function pickSelectedExternalMetric(
  period: SmartMoneyRiskPeriod,
  metrics: Record<PredictingTopPeriod, PredictingTopWalletMetric | null>
): PredictingTopWalletMetric | null {
  const externalPeriod = PERIOD_TO_EXTERNAL[period];
  return externalPeriod ? metrics[externalPeriod] : null;
}

function buildLocalRiskMetrics(values: number[]) {
  if (values.length < 2) {
    return null;
  }
  // Polymarket profile curves are cumulative P&L dollars, not account equity.
  // Without invested capital / NAV, percentage return is easy to misread when
  // the curve starts near zero. Drawdown percent is filled from the peak-to-trough
  // backtest window, where the denominator is the positive P&L peak.
  return {
    source: 'LOCAL_CURVE' as const,
    maxDrawdownPercent: null,
    currentDrawdown: null,
    returnRatio: computeDisplayCurveReturnRatio(values),
    sharpeLike: roundMetric(computeSharpeLikeRatio(values)),
    sortinoLike: roundMetric(computeSortinoLikeRatio(values)),
    winRateProxy: roundMetric(getPositiveStepRatio(values)),
    volatilityProxy: roundMetric(computeVolatilityLike(values)),
  };
}

function buildExternalRiskMetrics(metric: PredictingTopWalletMetric | null) {
  if (!metric) return null;
  return {
    source: 'PREDICTING_TOP' as const,
    maxDrawdownPercent: roundMetric(metric.maxDrawdownPercent),
    currentDrawdown: roundMetric(metric.currentDrawdown),
    returnRatio: roundMetric(metric.totalReturn),
    sharpeLike: roundMetric(metric.sharpeRatio),
    sortinoLike: roundMetric(metric.sortinoRatio),
    winRateProxy: roundMetric(metric.winRate),
    volatilityProxy: null,
  };
}

export async function getSmartMoneyRiskProfileByDisplayName(
  displayName: string,
  period: SmartMoneyRiskPeriod,
  options?: GetSmartMoneyRiskProfileOptions
) {
  const trimmed = displayName.trim();
  if (!trimmed) {
    return null;
  }

  const row = await prisma.smartMoneyLeaderboardRow.findFirst({
    where: {
      displayName: { equals: trimmed, mode: 'insensitive' },
    },
  });

  if (!row) {
    return null;
  }

  return getSmartMoneyRiskProfile(row.wallet, period, options);
}

export async function getSmartMoneyRiskProfile(
  wallet: string,
  period: SmartMoneyRiskPeriod,
  options?: GetSmartMoneyRiskProfileOptions
) {
  const normalizedWallet = normalizeWallet(wallet);
  const neededCurveTypes = getNeededCurveTypes(period);
  const requestedCurveType = PERIOD_TO_CURVE_TYPE[period];

  // TTL 读穿：先看库内该周期曲线是否仍新鲜，新鲜则跳过上游
  let curveCacheFresh = false;
  if (options?.live) {
    const latestCurveMeta = await prisma.traderCurvePoint.findFirst({
      where: { wallet: normalizedWallet, curveType: requestedCurveType },
      orderBy: [{ snapshotAt: 'desc' }, { ts: 'desc' }],
      select: { snapshotAt: true },
    });
    curveCacheFresh = isCurveFresh(latestCurveMeta?.snapshotAt ?? null, period);
    if (!curveCacheFresh) {
      try {
        await fetchAndPersistUserPnlCurves(normalizedWallet, [period], { requestGap: false });
      } catch {
        // 落库失败仍允许走下方 live profile / DB 回退
      }
    }
  }

  const shouldLiveFetch = Boolean(options?.live) && !curveCacheFresh;

  const liveFetchPromise: Promise<
    | { profile: Awaited<ReturnType<typeof fetchPolymarketProfile>>; error: null }
    | { profile: null; error: unknown }
  > = shouldLiveFetch
    ? fetchPolymarketProfile(normalizedWallet, {
        retryMax: 1,
        cacheTtlMs: 60_000,
        pnlPeriods: [period],
      })
        .then((profile) => ({ profile, error: null }))
        .catch((error) => ({ profile: null, error }))
    : Promise.resolve({ profile: null, error: null });

  const latestSnapshotPromise = prisma.traderProfileSnapshot.findFirst({
    where: { wallet: normalizedWallet },
    orderBy: [{ snapshotAt: 'desc' }, { id: 'desc' }],
  });

  // 外部 predicting.top 指标改为曲线缺失时再查，避免热路径多一次 groupBy+findMany 抢库
  const [leaderboardRow, latestSnapshot, liveFetchResult, curvePoints, availableCurveTypes, scoreCache] =
    await Promise.all([
      prisma.smartMoneyLeaderboardRow.findUnique({
        where: { wallet: normalizedWallet },
      }),
      latestSnapshotPromise,
      liveFetchPromise,
      latestSnapshotPromise.then((snapshot) =>
        snapshot == null
          ? prisma.traderCurvePoint.findMany({
              where: {
                wallet: normalizedWallet,
                curveType: { in: neededCurveTypes },
              },
              orderBy: [{ curveType: 'asc' }, { ts: 'asc' }],
            })
          : prisma.traderCurvePoint.findMany({
              where: {
                wallet: normalizedWallet,
                snapshotAt: snapshot.snapshotAt,
                curveType: { in: neededCurveTypes },
              },
              orderBy: [{ curveType: 'asc' }, { ts: 'asc' }],
            }).then(async (rows) => {
              // Enrich 按 curveType 删写，可能 snapshotAt 与 profile 快照不一致；TTL 读穿时补最新周期点
              if (rows.some((r) => r.curveType === requestedCurveType)) return rows;
              const latestPeriodRows = await prisma.traderCurvePoint.findMany({
                where: {
                  wallet: normalizedWallet,
                  curveType: { in: neededCurveTypes },
                },
                orderBy: [{ curveType: 'asc' }, { ts: 'asc' }],
              });
              return latestPeriodRows.length > 0 ? latestPeriodRows : rows;
            })
      ),
      latestSnapshotPromise.then((snapshot) =>
        snapshot == null
          ? prisma.traderCurvePoint.groupBy({
              by: ['curveType'],
              where: { wallet: normalizedWallet },
            })
          : prisma.traderCurvePoint.groupBy({
              by: ['curveType'],
              where: { wallet: normalizedWallet, snapshotAt: snapshot.snapshotAt },
            })
      ),
      getSmartMoneyScoreCache(normalizedWallet),
    ]);
  let liveProfile: Awaited<ReturnType<typeof fetchPolymarketProfile>> | null = null;
  let liveUpstreamError: { kind: string } | null = null;
  if (options?.live) {
    if (liveFetchResult.error != null) {
      liveProfile = null;
      if (liveFetchResult.error instanceof PolymarketProfileFetchError) {
        liveUpstreamError = { kind: liveFetchResult.error.kind };
      } else {
        liveUpstreamError = { kind: 'unknown' };
      }
    } else {
      liveProfile = liveFetchResult.profile;
    }
  }

  if (!leaderboardRow && !latestSnapshot && !liveProfile && !scoreCache) {
    return null;
  }

  let loadedCurvePoints = curvePoints;
  const upstreamGroups =
    liveProfile != null ? buildCurveGroupsFromUpstreamCurves(liveProfile.curves) : {};
  let dbGroups = buildCurveGroups(loadedCurvePoints);
  let curveGroups =
    liveProfile != null ? mergeCurveGroupsPreferUpstream(upstreamGroups, dbGroups) : dbGroups;
  let selectedCurvePoints = curveGroups[requestedCurveType] ?? [];
  let resolvedPeriod: SmartMoneyRiskPeriod = period;
  if (selectedCurvePoints.length === 0) {
    const fallbackTypes = getFallbackCurveTypes(period);
    if (fallbackTypes.length > 0 && latestSnapshot != null) {
      const missingTypes = fallbackTypes.filter(
        (curveType) => (curveGroups[curveType] ?? []).length === 0
      );
      if (missingTypes.length > 0) {
        const fallbackRows = await prisma.traderCurvePoint.findMany({
          where: {
            wallet: normalizedWallet,
            snapshotAt: latestSnapshot.snapshotAt,
            curveType: { in: missingTypes },
          },
          orderBy: [{ curveType: 'asc' }, { ts: 'asc' }],
        });
        if (fallbackRows.length > 0) {
          loadedCurvePoints = loadedCurvePoints.concat(fallbackRows);
          dbGroups = buildCurveGroups(loadedCurvePoints);
          curveGroups =
            liveProfile != null
              ? mergeCurveGroupsPreferUpstream(upstreamGroups, dbGroups)
              : dbGroups;
        }
      }
    }
    for (const candidate of CURVE_PERIOD_FALLBACK[period]) {
      const pts = curveGroups[PERIOD_TO_CURVE_TYPE[candidate]] ?? [];
      if (pts.length > 0) {
        selectedCurvePoints = pts;
        resolvedPeriod = candidate;
        break;
      }
    }
  }
  const resolvedCurveType = PERIOD_TO_CURVE_TYPE[resolvedPeriod];
  const selectedValues = selectedCurvePoints.map((point) => point.value);
  const curveTypeToPeriod: Record<string, SmartMoneyRiskPeriod> = {
    PORTFOLIO_PNL_1D: '1D',
    PORTFOLIO_PNL_1W: '1W',
    PORTFOLIO_PNL_1M: '1M',
    PORTFOLIO_PNL_ALL: 'ALL',
  };
  const periodsFromDb = new Set(
    availableCurveTypes
      .map((row) => curveTypeToPeriod[row.curveType])
      .filter((candidate): candidate is SmartMoneyRiskPeriod => candidate != null)
  );
  const availablePeriods = SMART_MONEY_RISK_PERIODS.filter((candidatePeriod) => {
    if ((curveGroups[PERIOD_TO_CURVE_TYPE[candidatePeriod]] ?? []).length > 0) {
      return true;
    }
    return periodsFromDb.has(candidatePeriod);
  });
  const responseCurvePoints = downsampleCurvePoints(selectedCurvePoints, MAX_RESPONSE_CURVE_POINTS);

  const localRiskBase = buildLocalRiskMetrics(selectedValues);
  const backtest = buildCurveBacktestMetrics(selectedCurvePoints);
  const localMaxDrawdownPercent = backtest.windowPeakDrawdown?.drawdownRatio ?? null;
  const localCurrentDrawdown = computeWindowCurrentDrawdown(selectedCurvePoints);
  /** 展示夏普：固定 ALL×1Y 本地代理，与榜表写入口径一致；不随详情周期切换、不回退第三方 */
  const allCurvePointsForSharpe = curveGroups.PORTFOLIO_PNL_ALL ?? [];
  const sharpeNowMs = Date.now();
  const localSharpeAll1y = roundMetric(
    computeLocalSharpeLikeAll1yFromPoints(allCurvePointsForSharpe, sharpeNowMs)
  );
  const localRisk =
    localRiskBase == null
      ? null
      : {
          ...localRiskBase,
          maxDrawdownPercent: localMaxDrawdownPercent,
          currentDrawdown: localCurrentDrawdown?.currentDrawdownRatio ?? null,
          sharpeLike: localSharpeAll1y,
        };

  let externalMetrics: Awaited<ReturnType<typeof getLatestPredictingTopWalletMetrics>> | null = null;
  if (localRisk == null) {
    externalMetrics = await getLatestPredictingTopWalletMetrics(normalizedWallet);
  }
  const selectedExternalMetric = pickSelectedExternalMetric(
    period,
    externalMetrics ?? {
      '7D': null,
      '30D': null,
      ALL: null,
    }
  );
  const externalRisk = buildExternalRiskMetrics(selectedExternalMetric);
  const effectiveRiskBase = localRisk ?? externalRisk;
  const effectiveRisk =
    effectiveRiskBase == null
      ? localSharpeAll1y == null
        ? null
        : {
            source: 'LOCAL_CURVE' as const,
            maxDrawdownPercent: null,
            currentDrawdown: null,
            returnRatio: null,
            sharpeLike: localSharpeAll1y,
            sortinoLike: null,
            winRateProxy: null,
            volatilityProxy: null,
          }
      : {
          ...effectiveRiskBase,
          // 强制本地 ALL×1Y；即使整包 risk 回退 predicting.top 也不用其 sharpe
          sharpeLike: localSharpeAll1y,
        };
  const riskScore = buildRiskScore({
    riskPenalty: leaderboardRow == null ? null : Number(leaderboardRow.riskPenalty),
    maxDrawdownPercent:
      effectiveRisk?.source === 'LOCAL_CURVE'
        ? localMaxDrawdownPercent
        : effectiveRisk?.maxDrawdownPercent ?? null,
    currentDrawdown: effectiveRisk?.currentDrawdown ?? null,
    volatilityProxy: effectiveRisk?.volatilityProxy ?? null,
    sharpeLike: localSharpeAll1y,
  });

  const latestValue = selectedCurvePoints.length > 0 ? selectedCurvePoints[selectedCurvePoints.length - 1].value : null;
  const startValue = selectedCurvePoints.length > 0 ? selectedCurvePoints[0].value : null;
  const changeValue =
    latestValue != null && startValue != null ? roundMetric(latestValue - startValue) : null;
  const coverage = getCurveCoverageMeta(resolvedPeriod, selectedCurvePoints);
  const lifetimeTradeCount =
    liveProfile?.predictionCount ?? latestSnapshot?.predictionCount ?? leaderboardRow?.predictionCount ?? null;
  const includeTradeActivity = options?.includeTradeActivity === true;
  const tradeActivityWindow = includeTradeActivity
    ? resolveTradeActivityWindow(resolvedPeriod, coverage, Date.now())
    : null;
  const tradingActivity =
    tradeActivityWindow == null
      ? null
      : await buildSmartMoneyTradeActivity({
          wallet: normalizedWallet,
          period: resolvedPeriod,
          windowStartTs: tradeActivityWindow.windowStartTs,
          windowEndTs: tradeActivityWindow.windowEndTs,
          lifetimeTradeCount,
        });
  const rawSummaryForVolume = liveProfile?.rawSummary ?? latestSnapshot?.rawSummary;
  const volumeSummary = extractVolumeSummary(rawSummaryForVolume);
  /**
   * 入榜地址展示只信榜表；无榜行才用 ScoreCache（未入榜已分析）。
   * 禁止再按 lastScoredAt 在两表间 fresher 合并，否则会出现列表 S / 详情 C。
   */
  const displayAuthority = resolveSmartMoneyDisplayAuthority({
    hasLeaderboardRow: leaderboardRow != null,
    hasScoreCache: scoreCache != null,
  });
  const lbExplain = extractScoreExplain(leaderboardRow?.scoreExplain);
  const cacheExplain = extractScoreExplain(scoreCache?.scoreExplain);
  // 榜表权威；仅当榜行缺 explain 时回退 Cache 正文（档位仍以榜表列为准，再 align）
  const scoreExplain =
    displayAuthority === 'leaderboard' ? (lbExplain ?? cacheExplain) : cacheExplain;
  const scoreExplainRaw =
    displayAuthority === 'leaderboard'
      ? (leaderboardRow?.scoreExplain ?? scoreCache?.scoreExplain ?? null)
      : displayAuthority === 'score_cache'
        ? scoreCache?.scoreExplain
        : null;
  const scoreResolvedMetrics = scoreExplain?.resolvedMetrics;
  const scoreComponents = scoreExplain?.components;
  const scoreWarnings = extractScoreWarnings(scoreExplain);
  const closedMarketReturnDistribution = extractReturnDistribution(
    scoreExplain?.closedMarketReturnDistribution
  );
  const tradesPerDay1DFromScore = toNumber(scoreResolvedMetrics?.tradesPerDay1D);
  const tradesPerDay1D =
    tradesPerDay1DFromScore ??
    (resolvedPeriod === '1D' && tradingActivity && tradingActivity.fetchError == null
      ? tradingActivity.tradeCount
      : null);
  // 各周期统一用 Data API 成交笔数（与 1D/1W/1M 同口径）。
  // 注意：lifetimeTradeCount/predictionCount 是主页「预测次数」，常小于成交笔数，不能用来填 ALL。
  const resolvedTradeCount =
    tradingActivity != null && tradingActivity.fetchError == null ? tradingActivity.tradeCount : null;
  const riskFlags = leaderboardRow?.riskFlags ?? scoreCache?.riskFlags ?? [];
  const highTradeFrequency =
    riskFlags.includes('HIGH_TRADE_FREQUENCY') ||
    isHighTradeFrequency(tradesPerDay1D, CONFIG.smartMoneyMaxTradesPerDay);
  const resolvedTotalPnl =
    numberToStringOrNull(scoreResolvedMetrics?.totalPnl) ??
    volumeSummary.totalPnl ??
    numberToStringOrNull(scoreExplain?.rawMetrics?.totalPnl);
  const resolvedTotalVolume =
    numberToStringOrNull(scoreResolvedMetrics?.totalVolume) ??
    volumeSummary.totalVolume ??
    numberToStringOrNull(scoreExplain?.rawMetrics?.totalVolume) ??
    (liveProfile?.totalVolume != null ? String(liveProfile.totalVolume) : null);

  const earlyDisplayProfile =
    scoreExplain?.displayProfile && isRecord(scoreExplain.displayProfile)
      ? (scoreExplain.displayProfile as Record<string, unknown>)
      : null;

  const resolvedRealizedPnl =
    numberToStringOrNull(
      isRecord(scoreExplain?.closedPositions)
        ? (scoreExplain.closedPositions as { totalRealizedPnl?: unknown }).totalRealizedPnl
        : null
    ) ??
    numberToStringOrNull(earlyDisplayProfile?.totalPnl1y) ??
    numberToStringOrNull(earlyDisplayProfile?.closedRealizedPnl1y) ??
    volumeSummary.realizedPnl;

  const resolvedUnrealizedPnl =
    volumeSummary.unrealizedPnl ??
    numberToStringOrNull(
      isRecord(scoreExplain?.openPositions)
        ? (scoreExplain.openPositions as { totalUnrealizedPnl?: unknown }).totalUnrealizedPnl
        : null
    );

  const resolvedUpstreamPoints = upstreamGroups[resolvedCurveType] ?? [];
  const profilePnlApiFilledPeriods = liveProfile?.profilePnlApiFilledPeriods ?? [];
  const usedUserPnlApi = profilePnlApiFilledPeriods.length > 0;

  let curveDataSource:
    | 'polymarket_upstream_live'
    | 'polymarket_upstream_live_merged_db_curves'
    | 'polymarket_upstream_live_user_pnl_api'
    | 'polymarket_upstream_live_user_pnl_api_merged_db_curves'
    | 'database_snapshot'
    | 'database_snapshot_fallback';

  if (liveProfile == null) {
    curveDataSource =
      options?.live && liveUpstreamError != null
        ? 'database_snapshot_fallback'
        : 'database_snapshot';
  } else {
    const baseLive =
      resolvedUpstreamPoints.length > 0
        ? 'polymarket_upstream_live'
        : (curveGroups[resolvedCurveType] ?? []).length > 0
          ? 'polymarket_upstream_live_merged_db_curves'
          : 'polymarket_upstream_live';
    if (usedUserPnlApi && baseLive === 'polymarket_upstream_live') {
      curveDataSource = 'polymarket_upstream_live_user_pnl_api';
    } else if (usedUserPnlApi && baseLive === 'polymarket_upstream_live_merged_db_curves') {
      curveDataSource = 'polymarket_upstream_live_user_pnl_api_merged_db_curves';
    } else {
      curveDataSource = baseLive;
    }
  }

  const periodWinRate =
    backtest.positiveDayRatio ??
    effectiveRisk?.winRateProxy ??
    (leaderboardRow?.externalWinRate != null ? Number(leaderboardRow.externalWinRate) : null) ??
    (() => {
      const dp = scoreExplain?.displayProfile;
      if (!isRecord(dp)) return null;
      return (
        toNumber((dp as Record<string, unknown>).winRate) ??
        toNumber((dp as Record<string, unknown>).closedWinRate) ??
        toNumber((dp as Record<string, unknown>).scoreWinRate)
      );
    })();
  const periodWinRateRounded =
    periodWinRate != null && Number.isFinite(periodWinRate) ? roundMetric(periodWinRate) : null;

  const displayProfileRecord =
    scoreExplain?.displayProfile && isRecord(scoreExplain.displayProfile)
      ? (scoreExplain.displayProfile as Record<string, unknown>)
      : null;

  /**
   * 入榜：档位权威为榜表列；再覆写 scoreExplain.traderProfile/card 以兼容旧前端。
   * 未入榜：从 ScoreCache explain 取档位。
   */
  const authoritativeTier = (() => {
    if (leaderboardRow) {
      return {
        tier: leaderboardRow.tier ?? null,
        traderScore: leaderboardRow.traderScore?.toString() ?? null,
        edgeScore: leaderboardRow.edgeScore?.toString() ?? null,
        edgeSampleN: leaderboardRow.edgeSampleN ?? null,
        traderType: leaderboardRow.traderType ?? null,
      };
    }
    const tp =
      scoreExplain && isRecord((scoreExplain as { traderProfile?: unknown }).traderProfile)
        ? ((scoreExplain as { traderProfile: Record<string, unknown> }).traderProfile as Record<
            string,
            unknown
          >)
        : null;
    const scoreRaw = tp
      ? isRecord(tp.traderScore)
        ? (tp.traderScore as Record<string, unknown>).score
        : tp.traderScore
      : null;
    return {
      tier: typeof tp?.tier === 'string' ? tp.tier : null,
      traderScore: toNumber(scoreRaw) != null ? String(toNumber(scoreRaw)) : null,
      edgeScore: null,
      edgeSampleN: null,
      traderType: typeof tp?.traderType === 'string' ? tp.traderType : null,
    };
  })();

  const scoreExplainForClient = alignScoreExplainTraderProfileToBoard({
    scoreExplain: scoreExplainRaw ?? leaderboardRow?.scoreExplain ?? null,
    tier: authoritativeTier.tier,
    traderScore: authoritativeTier.traderScore,
    traderType: authoritativeTier.traderType,
  });

  const onBoard =
    leaderboardRow?.inCopyPool === true &&
    leaderboardRow.rank != null &&
    Number(leaderboardRow.rank) >= 1;
  const storedEligibility = readBoardEligibilityFromExplain(
    scoreExplainForClient ?? scoreExplainRaw ?? scoreCache?.scoreExplain ?? null
  );
  const copyabilityFromExplain = (() => {
    const raw = scoreExplainForClient ?? scoreExplainRaw;
    if (!isRecord(raw)) return null;
    const copy = raw.copyability;
    if (isRecord(copy) && typeof copy.score === 'number' && Number.isFinite(copy.score)) {
      return copy.score;
    }
    if (isRecord(copy) && isRecord(copy.metrics)) {
      const s = toNumber(copy.metrics.score as string | number | null | undefined);
      return s;
    }
    return toNumber(
      leaderboardRow?.copyabilityScore != null
        ? String(leaderboardRow.copyabilityScore)
        : null
    );
  })();
  const boardEligibility =
    storedEligibility &&
    (storedEligibility.status === 'ON_BOARD') === onBoard &&
    (onBoard || storedEligibility.reasons.length > 0)
      ? storedEligibility
      : buildBoardEligibilityExplain({
          onBoard,
          gateFailReason: storedEligibility?.gateFailReason ?? null,
          riskFlags: leaderboardRow?.riskFlags ?? scoreCache?.riskFlags ?? [],
          traderScore: toNumber(authoritativeTier.traderScore),
          score: toNumber(
            leaderboardRow?.score != null
              ? String(leaderboardRow.score)
              : scoreCache?.score != null
                ? String(scoreCache.score)
                : null
          ),
          copyabilityScore:
            toNumber(
              leaderboardRow?.copyabilityScore != null
                ? String(leaderboardRow.copyabilityScore)
                : null
            ) ?? copyabilityFromExplain,
        });
  const scoreExplainWithEligibility = mergeBoardEligibilityIntoExplain(
    scoreExplainForClient ?? scoreExplainRaw ?? null,
    boardEligibility
  );

  const scoreComplete = isTraderScoreDisplayComplete({
    scoreExplain: scoreExplainWithEligibility,
    copyabilityScore:
      toNumber(
        leaderboardRow?.copyabilityScore != null
          ? String(leaderboardRow.copyabilityScore)
          : null
      ) ?? copyabilityFromExplain,
    tier: authoritativeTier.tier,
    traderScore: toNumber(authoritativeTier.traderScore),
  });
  const copyabilityReady = isCopyabilityComputed(
    toNumber(
      leaderboardRow?.copyabilityScore != null
        ? String(leaderboardRow.copyabilityScore)
        : null
    ) ?? copyabilityFromExplain
  );

  const analyzedSummaryRaw =
    !leaderboardRow && scoreCache && scoreExplain
      ? buildAnalyzedSummaryFromScoreCache({
          wallet: normalizedWallet,
          scoreCache,
          scoreExplain,
          scoreExplainRaw: scoreCache.scoreExplain,
          liveProfile,
          latestSnapshot,
          resolvedTotalPnl,
        })
      : null;
  const analyzedSummary =
    analyzedSummaryRaw == null
      ? null
      : {
          ...analyzedSummaryRaw,
          scoreExplain: scoreExplainWithEligibility,
          externalSharpeRatio:
            localSharpeAll1y != null
              ? String(localSharpeAll1y)
              : analyzedSummaryRaw.externalSharpeRatio,
        };

  return {
    wallet: normalizedWallet,
    boardEligibility,
    summary: leaderboardRow
      ? {
          rank: leaderboardRow.rank,
          wallet: leaderboardRow.wallet,
          displayName: leaderboardRow.displayName,
          profileSlug: leaderboardRow.profileSlug,
          joinedAtText: leaderboardRow.joinedAtText,
          profileImage: leaderboardRow.profileImage,
          xUsername: leaderboardRow.xUsername,
          score: leaderboardRow.score.toString(),
          tier: authoritativeTier.tier ?? leaderboardRow.tier ?? null,
          traderScore:
            authoritativeTier.traderScore ?? leaderboardRow.traderScore?.toString() ?? null,
          edgeScore: authoritativeTier.edgeScore ?? leaderboardRow.edgeScore?.toString() ?? null,
          edgeSampleN: authoritativeTier.edgeSampleN ?? leaderboardRow.edgeSampleN ?? null,
          traderType: authoritativeTier.traderType ?? leaderboardRow.traderType ?? null,
          pnlQuality: leaderboardRow.pnlQuality.toString(),
          activityScore: leaderboardRow.activityScore.toString(),
          consistencyScore: leaderboardRow.consistencyScore.toString(),
          officialCandidateScore: leaderboardRow.officialCandidateScore.toString(),
          externalQualityScore: leaderboardRow.externalQualityScore.toString(),
          riskPenalty: leaderboardRow.riskPenalty.toString(),
          eligible: leaderboardRow.eligible,
          predictionCount: leaderboardRow.predictionCount,
          holdingsValue: leaderboardRow.holdingsValue?.toString() ?? null,
          // 详情主胜率：仅榜行已平仓口径；曲线正步占比另见 meta.curveWinRateProxy
          externalWinRate: leaderboardRow.externalWinRate?.toString() ?? null,
          // 现场 ALL×1Y 覆盖榜表旧值，避免未复评前仍展示第三方夏普
          externalSharpeRatio:
            localSharpeAll1y != null
              ? String(localSharpeAll1y)
              : leaderboardRow.externalSharpeRatio?.toString() ?? null,
          externalTotalReturn: leaderboardRow.externalTotalReturn?.toString() ?? null,
          /** 与排行榜列表同源，详情页不得用当前曲线窗口回撤替代。 */
          maxDrawdownPercent: leaderboardRow.maxDrawdownPercent?.toString() ?? null,
          maxDrawdownUsd: (() => {
            const fromDisplay = toNumber(displayProfileRecord?.maxDrawdownUsd);
            return fromDisplay != null ? String(roundMetric(fromDisplay)) : null;
          })(),
          mddUnmeasurable: displayProfileRecord?.mddUnmeasurable === true,
          externalMetricsPeriod: leaderboardRow.externalMetricsPeriod,
          externalMetricsSource: leaderboardRow.externalMetricsSource,
          flags: leaderboardRow.riskFlags,
          scoreExplain: scoreExplainWithEligibility ?? leaderboardRow.scoreExplain,
          totalPnl: leaderboardRow.totalPnl?.toString() ?? null,
          totalPnl1y: leaderboardRow.totalPnl1y?.toString() ?? null,
          pnlWindowDays: leaderboardRow.pnlWindowDays ?? null,
          recentPnl7d: leaderboardRow.recentPnl7d?.toString() ?? null,
          trades7d: leaderboardRow.trades7d ?? null,
          backtestPnlUsd: leaderboardRow.backtestPnlUsd?.toString() ?? null,
          copyLossRate: leaderboardRow.copyLossRate?.toString() ?? null,
          slippageBpsEffective: leaderboardRow.slippageBpsEffective ?? null,
          winRateSource: leaderboardRow.winRateSource ?? null,
          metricsSource: {
            pnl: 'USER_PNL_API',
            winRate: leaderboardRow.winRateSource ?? null,
            return: 'CAPITAL_ROI',
            copyMetrics: 'SIMULATION',
          },
          copyMetricsNote:
            '仿真回测：按延迟与滑点假设重放历史成交，非本平台真实跟单用户盈亏',
          lastCurveEnrichAt: leaderboardRow.lastCurveEnrichAt?.toISOString() ?? null,
          sparkline: Array.isArray(
            (leaderboardRow.scoreExplain as { sparkline?: unknown } | null)?.sparkline
          )
            ? (leaderboardRow.scoreExplain as { sparkline: unknown }).sparkline
            : null,
          recentMarkets: Array.isArray(
            (leaderboardRow.scoreExplain as { recentMarkets?: unknown } | null)?.recentMarkets
          )
            ? (leaderboardRow.scoreExplain as { recentMarkets: unknown }).recentMarkets
            : null,
          biggestWinRecent: (() => {
            const fromTrader = isRecord(
              (scoreExplainRaw as Record<string, unknown> | null | undefined)?.traderProfile
            )
              ? toNumber(
                  (
                    (scoreExplainRaw as Record<string, unknown>).traderProfile as Record<
                      string,
                      unknown
                    >
                  ).maxWinTradeUsd
                )
              : null;
            if (fromTrader != null) return fromTrader;
            const dp =
              scoreExplainRaw &&
              typeof scoreExplainRaw === 'object' &&
              !Array.isArray(scoreExplainRaw)
                ? (scoreExplainRaw as { displayProfile?: { biggestWinRecent?: unknown } })
                    .displayProfile
                : leaderboardRow.scoreExplain &&
                    typeof leaderboardRow.scoreExplain === 'object' &&
                    !Array.isArray(leaderboardRow.scoreExplain)
                  ? (leaderboardRow.scoreExplain as { displayProfile?: { biggestWinRecent?: unknown } })
                      .displayProfile
                  : null;
            const n = dp?.biggestWinRecent;
            return typeof n === 'number' && Number.isFinite(n) ? n : null;
          })(),
          rankScore: leaderboardRow.rankScore?.toString() ?? null,
          rankScoreComputedAt: leaderboardRow.rankScoreComputedAt?.toISOString() ?? null,
          copierFeedback: leaderboardRow.copierFeedback ?? null,
          copierFeedbackReady: (() => {
            const fb = leaderboardRow.copierFeedback as {
              sampleWeight?: number;
              washSuspect?: boolean;
            } | null;
            if (fb == null || typeof fb !== 'object') return false;
            if (fb.washSuspect === true) return false;
            return typeof fb.sampleWeight === 'number' && fb.sampleWeight >= 1;
          })(),
        }
      : analyzedSummary,
    profile: {
      displayName: liveProfile?.displayName ?? latestSnapshot?.displayName ?? leaderboardRow?.displayName ?? null,
      profileSlug: liveProfile?.profileSlug ?? latestSnapshot?.profileSlug ?? leaderboardRow?.profileSlug ?? null,
      profileImage: liveProfile?.profileImage ?? leaderboardRow?.profileImage ?? null,
      xUsername: liveProfile?.xUsername ?? leaderboardRow?.xUsername ?? null,
      joinedAtText: liveProfile?.joinedAtText ?? latestSnapshot?.joinedAtText ?? leaderboardRow?.joinedAtText ?? null,
      viewsText: liveProfile?.viewsText ?? latestSnapshot?.viewsText ?? null,
      holdingsValue:
        liveProfile?.holdingsValue ??
        latestSnapshot?.holdingsValue?.toString() ??
        leaderboardRow?.holdingsValue?.toString() ??
        null,
      biggestWin: liveProfile?.biggestWin ?? latestSnapshot?.biggestWin?.toString() ?? null,
      predictionCount: lifetimeTradeCount,
      /** 生涯累计（Polymarket 主页 userStats.trades）；与 tradeCount 口径不同，仅作参考 */
      lifetimeTradeCount,
      /** 当前 resolvedPeriod 窗口内成交笔数（Data API /trades；与 lifetimeTradeCount 口径不同） */
      tradeCount: resolvedTradeCount,
      tradeCountPeriod: resolvedPeriod,
      tradeCountUnavailable: resolvedTradeCount == null,
      /** 当前周期曲线正步占比（辅指标，非已平仓市场胜率） */
      winRate: periodWinRateRounded,
      winRateSource:
        backtest.positiveDayRatio != null
          ? 'positive_day_ratio'
          : effectiveRisk?.winRateProxy != null
            ? 'curve_step_ratio'
            : periodWinRateRounded != null
              ? 'leaderboard_external'
              : null,
      /** 榜单权威胜率（composite / 仅已平仓）；与 winRate 曲线代理分离 */
      closedMarketWinRate:
        (leaderboardRow?.winRateSource === 'MARKET_CLOSED' ||
          leaderboardRow?.winRateSource === 'MARKET_COMPOSITE') &&
        leaderboardRow.externalWinRate != null
          ? Number(leaderboardRow.externalWinRate)
          : (() => {
              const dp = scoreExplain?.displayProfile;
              if (!isRecord(dp)) return null;
              return (
                toNumber((dp as Record<string, unknown>).winRate) ??
                toNumber((dp as Record<string, unknown>).closedWinRate) ??
                toNumber((dp as Record<string, unknown>).scoreWinRate)
              );
            })(),
      totalPnl: resolvedTotalPnl,
      totalPnlSource:
        typeof scoreResolvedMetrics?.totalPnlSource === 'string'
          ? scoreResolvedMetrics.totalPnlSource
          : volumeSummary.totalPnl != null
            ? 'profile'
            : null,
      totalVolume: resolvedTotalVolume,
      rawTotalPnl: volumeSummary.totalPnl,
      resolvedTotalPnl,
      pnlMismatchRatio: roundMetric(toNumber(scoreResolvedMetrics?.pnlMismatchRatio)),
      realizedPnl: resolvedRealizedPnl,
      unrealizedPnl: resolvedUnrealizedPnl,
    },
    curve: {
      period,
      /** 实际用于 points / curveType / coverage 的周期（无回退时与 period 相同） */
      resolvedPeriod,
      curveType: resolvedCurveType,
      activePeriod: resolvedPeriod !== period ? resolvedPeriod : undefined,
      availablePeriods,
      points: responseCurvePoints,
      pointCount: selectedCurvePoints.length,
      responsePointCount: responseCurvePoints.length,
      startTs: coverage.startTs,
      endTs: coverage.endTs,
      coverageDays: coverage.coverageDays,
      requestedPeriodDays: coverage.requestedPeriodDays,
      hasFullRequestedWindow: coverage.hasFullRequestedWindow,
      startValue: roundMetric(startValue),
      latestValue: roundMetric(latestValue),
      changeValue,
    },
    backtest: {
      ...backtest,
      closedMarketReturnDistribution,
      tradeCount: resolvedTradeCount,
    },
    // 成交日序列只放在 tradingActivity.points，避免与 backtest 重复一份撑爆 ALL 响应
    tradingActivity,
    risk: {
      source: (effectiveRisk?.source ?? null) as SmartMoneyRiskMetricSource,
      riskScore,
      riskLevel: getRiskLevel(riskScore),
      returnValue: changeValue,
      maxDrawdownValue: backtest.windowPeakDrawdown?.drawdownValue ?? null,
      maxDrawdownPercent:
        effectiveRisk?.source === 'LOCAL_CURVE'
          ? localMaxDrawdownPercent
          : effectiveRisk?.maxDrawdownPercent ?? null,
      currentDrawdown: effectiveRisk?.currentDrawdown ?? null,
      currentDrawdownValue: localCurrentDrawdown?.currentDrawdownValue ?? null,
      currentDrawdownPeakValue: localCurrentDrawdown?.peakValue ?? null,
      currentDrawdownLatestValue: localCurrentDrawdown?.latestValue ?? null,
      returnRatio: effectiveRisk?.returnRatio ?? null,
      sharpeLike: effectiveRisk?.sharpeLike ?? null,
      sortinoLike: effectiveRisk?.sortinoLike ?? null,
      /** 与 profile.winRate 一致：优先正收益日占比 */
      winRate: periodWinRateRounded,
      winRateProxy: periodWinRateRounded ?? effectiveRisk?.winRateProxy ?? null,
      volatilityProxy: effectiveRisk?.volatilityProxy ?? null,
    },
    externalRisk: selectedExternalMetric
      ? {
          period: selectedExternalMetric.period,
          rank: selectedExternalMetric.rank,
          smartScore: roundMetric(selectedExternalMetric.smartScore),
          maxDrawdownPercent: roundMetric(selectedExternalMetric.maxDrawdownPercent),
          currentDrawdown: roundMetric(selectedExternalMetric.currentDrawdown),
          totalReturn: roundMetric(selectedExternalMetric.totalReturn),
          sharpeRatio: roundMetric(selectedExternalMetric.sharpeRatio),
          sortinoRatio: roundMetric(selectedExternalMetric.sortinoRatio),
          winRate: roundMetric(selectedExternalMetric.winRate),
          rSquared: roundMetric(selectedExternalMetric.rSquared),
          tier: selectedExternalMetric.tier,
          calculatedAt: selectedExternalMetric.calculatedAt?.toISOString() ?? null,
        }
      : null,
    meta: {
      snapshotAt: (liveProfile?.snapshotAt ?? latestSnapshot?.snapshotAt)?.toISOString() ?? null,
      curveDataSource,
      curvePeriodFallback: resolvedPeriod !== period,
      profilePnlApiFilledPeriods,
      liveUpstreamError:
        options?.live && !liveProfile && liveUpstreamError ? liveUpstreamError : null,
      sourceFetchedAt: leaderboardRow?.sourceFetchedAt?.toISOString() ?? null,
      lastScoredAt: (() => {
        // 入榜：展示评分时间以榜表为准；未入榜：用 ScoreCache
        if (leaderboardRow?.lastScoredAt != null) {
          return leaderboardRow.lastScoredAt.toISOString();
        }
        return scoreCache?.lastScoredAt?.toISOString() ?? null;
      })(),
      /** 多因子 / 档位 / 入榜原因可展示：Gate + 仿跟单三情景齐备 */
      scoreComplete,
      copyabilityReady,
      enrichPending: leaderboardRow?.enrichPending === true,
      syncedAt: leaderboardRow?.syncedAt?.toISOString() ?? null,
      externalMetricsSource: leaderboardRow?.externalMetricsSource ?? null,
      dataConfidence:
        typeof scoreComponents?.dataConfidence === 'number' ? roundMetric(scoreComponents.dataConfidence) : null,
      scoreComponents: scoreComponents ?? null,
      dataWarnings: scoreWarnings,
      resolvedMetrics: scoreResolvedMetrics ?? null,
      marketCategoryProfile: scoreExplain?.marketCategoryProfile ?? null,
      displayProfile: scoreExplain?.displayProfile ?? null,
      copyabilitySim: scoreExplain?.copyability?.metrics ?? null,
      curveWinRateProxy: periodWinRateRounded,
      sampleNote:
        scoreExplain?.displayProfile?.sampleWindowDays != null ||
        scoreExplain?.copyability?.metrics?.sampleWindowDays != null
          ? `Metrics based on recent ~${
              scoreExplain?.displayProfile?.sampleWindowDays ??
              scoreExplain?.copyability?.metrics?.sampleWindowDays
            }d / ~${
              scoreExplain?.displayProfile?.sampleTradeCount ??
              scoreExplain?.copyability?.metrics?.sampleTradeCount ??
              'N'
            } trades (API window sample).`
          : null,
      copyability: {
        maxTradesPerDay: CONFIG.smartMoneyMaxTradesPerDay,
        tradesPerDay1D,
        highTradeFrequency,
        warning: highTradeFrequency ? 'HIGH_TRADE_FREQUENCY' : null,
      },
    },
  };
}
