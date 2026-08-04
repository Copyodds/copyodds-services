import type { SmartMoneyLeaderboardRow, SmartMoneyScoreCache } from '../../generated/prisma/client';
import type { SmartMoneyScoreResult } from './smartMoneyScorer';
import { isSmartMoneyEligibleFromFlags } from './smartMoneyScorer';

function metricFromExplain(explain: Record<string, unknown>, key: string): number {
  const components = explain.components;
  if (!components || typeof components !== 'object') return 0;
  const value = (components as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function scoreResultFromLeaderboardRow(row: SmartMoneyLeaderboardRow): SmartMoneyScoreResult {
  const explain = (row.scoreExplain ?? {}) as Record<string, unknown>;
  const resolvedMetrics = (explain.resolvedMetrics ?? {}) as Record<string, unknown>;
  const curve = (explain.curve ?? {}) as Record<string, unknown>;
  const externalSources = (explain.externalSources ?? {}) as Record<string, unknown>;

  return {
    wallet: row.wallet,
    score: Number(row.score),
    pnlQuality: Number(row.pnlQuality),
    activityScore: Number(row.activityScore),
    consistencyScore: Number(row.consistencyScore),
    officialCandidateScore: Number(row.officialCandidateScore),
    externalQualityScore: Number(row.externalQualityScore),
    riskPenalty: Number(row.riskPenalty),
    eligible: row.eligible,
    riskFlags: row.riskFlags,
    scoreVersion: row.scoreVersion,
    sourceFetchedAt: row.sourceFetchedAt ?? row.lastScoredAt,
    lastScoredAt: row.lastScoredAt,
    displayName: row.displayName,
    profileSlug: row.profileSlug,
    joinedAtText: row.joinedAtText,
    profileImage: row.profileImage,
    xUsername: row.xUsername,
    predictionCount: row.predictionCount,
    holdingsValue: row.holdingsValue?.toString() ?? null,
    totalPnl: row.totalPnl != null ? Number(row.totalPnl) : null,
    sourceRankWeek: row.sourceRankWeek,
    sourceRankMonth: row.sourceRankMonth,
    sourceRankAll: row.sourceRankAll,
    officialSourceRankWeek: row.officialSourceRankWeek,
    officialSourceRankMonth: row.officialSourceRankMonth,
    officialSourceRankAll: row.officialSourceRankAll,
    externalSourceRankWeek: row.externalSourceRankWeek,
    externalSourceRankMonth: row.externalSourceRankMonth,
    externalSourceRankAll: row.externalSourceRankAll,
    candidatePeriods: row.candidatePeriods,
    candidateCategories: row.candidateCategories,
    externalWinRate: row.externalWinRate != null ? Number(row.externalWinRate) : null,
    externalSharpeRatio: row.externalSharpeRatio != null ? Number(row.externalSharpeRatio) : null,
    externalTotalReturn: row.externalTotalReturn != null ? Number(row.externalTotalReturn) : null,
    maxDrawdownPercent: row.maxDrawdownPercent != null ? Number(row.maxDrawdownPercent) : null,
    externalMetricsPeriod:
      row.externalMetricsPeriod === '7D' ||
      row.externalMetricsPeriod === '30D' ||
      row.externalMetricsPeriod === 'ALL'
        ? row.externalMetricsPeriod
        : null,
    externalMetricsSource:
      row.externalMetricsSource === 'PREDICTING_TOP' ||
      row.externalMetricsSource === 'LOCAL_FALLBACK' ||
      row.externalMetricsSource === 'MIXED'
        ? row.externalMetricsSource
        : null,
    winRateSource:
      row.winRateSource === 'MARKET_CLOSED' ||
      row.winRateSource === 'MARKET_COMPOSITE' ||
      row.winRateSource === 'PREDICTING_TOP' ||
      row.winRateSource === 'CURVE_PROXY'
        ? row.winRateSource
        : null,
    metricsSourceBadge:
      row.metricsSourceBadge === 'PREDICTING_TOP' ||
      row.metricsSourceBadge === 'LOCAL_FALLBACK' ||
      row.metricsSourceBadge === 'MIXED'
        ? row.metricsSourceBadge
        : null,
    metrics: {
      totalPnl:
        row.totalPnl != null
          ? Number(row.totalPnl)
          : typeof resolvedMetrics.totalPnl === 'number'
            ? resolvedMetrics.totalPnl
            : null,
      totalVolume:
        typeof resolvedMetrics.totalVolume === 'number' ? resolvedMetrics.totalVolume : null,
      curveSourcePeriod:
        typeof curve.sourcePeriod === 'string' ? curve.sourcePeriod : null,
      recentCurveStrength:
        typeof curve.recentCurveStrength === 'number' ? curve.recentCurveStrength : null,
      maxSpikeRatio: typeof curve.maxSpikeRatio === 'number' ? curve.maxSpikeRatio : null,
      curveCount: typeof curve.curveCount === 'number' ? curve.curveCount : 0,
      externalCalculatedAt:
        typeof externalSources.all === 'string' ? externalSources.all : null,
      externalTier: null,
    },
    scoreExplain: explain,
    traderScore: row.traderScore != null ? Number(row.traderScore) : null,
    tier: row.tier ?? null,
    edgeScore: row.edgeScore != null ? Number(row.edgeScore) : null,
    edgeSampleN: row.edgeSampleN ?? null,
    traderType: row.traderType ?? null,
    activeDays: row.activeDays ?? null,
    maxWinTradeUsd: row.maxWinTradeUsd != null ? Number(row.maxWinTradeUsd) : null,
    maxLossTradeUsd: row.maxLossTradeUsd != null ? Number(row.maxLossTradeUsd) : null,
    copyabilityScore: row.copyabilityScore != null ? Number(row.copyabilityScore) : null,
  };
}

export function scoreResultFromScoreCache(
  cache: SmartMoneyScoreCache,
  observed: {
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
  } | null
): SmartMoneyScoreResult {
  const explain = (cache.scoreExplain ?? {}) as Record<string, unknown>;
  const resolvedMetrics = (explain.resolvedMetrics ?? {}) as Record<string, unknown>;
  const curve = (explain.curve ?? {}) as Record<string, unknown>;

  return {
    wallet: cache.wallet,
    score: Number(cache.score),
    pnlQuality: metricFromExplain(explain, 'profit'),
    activityScore: metricFromExplain(explain, 'activity'),
    consistencyScore: metricFromExplain(explain, 'consistency'),
    officialCandidateScore: 0,
    externalQualityScore: metricFromExplain(explain, 'tradeQuality'),
    riskPenalty: metricFromExplain(explain, 'riskPenalty'),
    eligible: isSmartMoneyEligibleFromFlags(cache.riskFlags),
    riskFlags: cache.riskFlags,
    scoreVersion: cache.scoreVersion,
    sourceFetchedAt: cache.lastScoredAt,
    lastScoredAt: cache.lastScoredAt,
    displayName: null,
    profileSlug: null,
    joinedAtText: null,
    profileImage: null,
    xUsername: null,
    predictionCount:
      typeof resolvedMetrics.predictionCount === 'number' ? resolvedMetrics.predictionCount : null,
    holdingsValue:
      typeof resolvedMetrics.holdingsValue === 'number'
        ? String(resolvedMetrics.holdingsValue)
        : null,
    totalPnl:
      typeof resolvedMetrics.totalPnl === 'number' ? resolvedMetrics.totalPnl : null,
    sourceRankWeek: observed?.sourceRankWeek ?? null,
    sourceRankMonth: observed?.sourceRankMonth ?? null,
    sourceRankAll: observed?.sourceRankAll ?? null,
    officialSourceRankWeek: observed?.officialSourceRankWeek ?? null,
    officialSourceRankMonth: observed?.officialSourceRankMonth ?? null,
    officialSourceRankAll: observed?.officialSourceRankAll ?? null,
    externalSourceRankWeek: observed?.externalSourceRankWeek ?? null,
    externalSourceRankMonth: observed?.externalSourceRankMonth ?? null,
    externalSourceRankAll: observed?.externalSourceRankAll ?? null,
    candidatePeriods: observed?.candidatePeriods ?? [],
    candidateCategories: observed?.candidateCategories ?? ['OVERALL'],
    externalWinRate: null,
    externalSharpeRatio: null,
    externalTotalReturn: null,
    maxDrawdownPercent: null,
    externalMetricsPeriod: null,
    externalMetricsSource: null,
    winRateSource: null,
    metricsSourceBadge: null,
    metrics: {
      totalPnl:
        typeof resolvedMetrics.totalPnl === 'number' ? resolvedMetrics.totalPnl : null,
      totalVolume:
        typeof resolvedMetrics.totalVolume === 'number' ? resolvedMetrics.totalVolume : null,
      curveSourcePeriod:
        typeof curve.sourcePeriod === 'string' ? curve.sourcePeriod : null,
      recentCurveStrength:
        typeof curve.recentCurveStrength === 'number' ? curve.recentCurveStrength : null,
      maxSpikeRatio: typeof curve.maxSpikeRatio === 'number' ? curve.maxSpikeRatio : null,
      curveCount: typeof curve.curveCount === 'number' ? curve.curveCount : 0,
      externalCalculatedAt: null,
      externalTier: null,
    },
    scoreExplain: explain,
    traderScore: null,
    tier: null,
    edgeScore: null,
    edgeSampleN: null,
    traderType: null,
    activeDays: null,
    maxWinTradeUsd: null,
    maxLossTradeUsd: null,
    copyabilityScore: null,
  };
}
