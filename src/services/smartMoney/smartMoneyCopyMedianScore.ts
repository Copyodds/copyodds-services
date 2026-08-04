/**
 * 仿跟单综合分：RT 仿真 + 已平仓盈利率中位数稳健分（60/40）。
 * 中位数复用 ClosedMarketReturnDistribution，不新增成交/closed 采集。
 */
import { CONFIG } from '../../config/env';
import type { ClosedMarketReturnDistribution } from './smartMoneyPositionStats';

export type MedianProfitScoreInputs = {
  medianReturn: number | null;
  meanReturn: number | null;
  totalReturnRatio: number | null;
  sampledMarketCount: number;
};

export type MedianProfitScoreResult = {
  medianProfitScore: number;
  rawMedianScore: number;
  shrunkScore: number;
  penalty: number;
  flags: string[];
  inputs: MedianProfitScoreInputs;
};

export type ComposeCopyabilityScoreResult = {
  /** 对外主分（受 COPY_COMPOSITE_AS_PRIMARY 控制） */
  copyabilityScore: number;
  /** 纯三情景仿真分 */
  rtScore: number;
  /** 60/40 综合分（始终计算，便于影子 explain） */
  compositeScore: number;
  medianProfitScore: number;
  roundTripCount: number;
  weights: { rt: number; median: number };
  flags: string[];
  median: MedianProfitScoreResult;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeWeights(): { rt: number; median: number } {
  const rt = Math.max(0, CONFIG.smartMoneyCopyRtWeight);
  const median = Math.max(0, CONFIG.smartMoneyCopyMedianWeight);
  const sum = rt + median;
  if (sum <= 0) return { rt: 0.6, median: 0.4 };
  return { rt: rt / sum, median: median / sum };
}

/** 从 scoreExplain JSON 解析已平仓回报分布（无则 null，勿为此再拉 closed） */
export function closedReturnDistFromExplain(
  scoreExplain: unknown
): Pick<
  ClosedMarketReturnDistribution,
  'medianReturn' | 'meanReturn' | 'totalReturnRatio' | 'sampledMarketCount'
> | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object') return null;
  const raw = (scoreExplain as Record<string, unknown>).closedMarketReturnDistribution;
  if (raw == null || typeof raw !== 'object') return null;
  const dist = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const n = Math.max(0, Math.round(num(dist.sampledMarketCount) ?? 0));
  const medianReturn = num(dist.medianReturn);
  const meanReturn = num(dist.meanReturn);
  const totalReturnRatio = num(dist.totalReturnRatio);
  if (n <= 0 && medianReturn == null && meanReturn == null) return null;
  return {
    sampledMarketCount: n,
    medianReturn,
    meanReturn,
    totalReturnRatio,
  };
}

/**
 * 已平仓盈利率中位数 → 0–100 稳健分（映射 + 样本收缩 + 虚高惩罚）。
 */
export function computeMedianProfitScore(
  dist:
    | Pick<
        ClosedMarketReturnDistribution,
        'medianReturn' | 'meanReturn' | 'totalReturnRatio' | 'sampledMarketCount'
      >
    | null
    | undefined
): MedianProfitScoreResult {
  const flags: string[] = [];
  const inputs: MedianProfitScoreInputs = {
    medianReturn: dist?.medianReturn ?? null,
    meanReturn: dist?.meanReturn ?? null,
    totalReturnRatio: dist?.totalReturnRatio ?? null,
    sampledMarketCount: Math.max(0, Math.round(dist?.sampledMarketCount ?? 0)),
  };

  if (dist == null) {
    flags.push('MEDIAN_MISSING');
    return {
      medianProfitScore: 35,
      rawMedianScore: 40,
      shrunkScore: 35,
      penalty: 0,
      flags,
      inputs,
    };
  }

  const lo = CONFIG.smartMoneyCopyMedianScoreLo;
  const hi = CONFIG.smartMoneyCopyMedianScoreHi;
  const span = Math.max(hi - lo, 1e-9);
  const rawMedianScore =
    inputs.medianReturn == null
      ? 40
      : clamp(((inputs.medianReturn - lo) / span) * 100, 0, 100);

  const n = inputs.sampledMarketCount;
  const neutral = CONFIG.smartMoneyCopyMedianNeutral;
  const k = CONFIG.smartMoneyCopyMedianShrinkK;
  let shrunkScore: number;
  if (n < CONFIG.smartMoneyCopyMedianMinN) {
    flags.push('MEDIAN_SAMPLE_THIN');
    shrunkScore = 35;
  } else {
    const shrink = n / (n + k);
    shrunkScore = neutral + (rawMedianScore - neutral) * shrink;
  }

  let penalty = 0;
  const { medianReturn, meanReturn, totalReturnRatio } = inputs;
  if (meanReturn != null && medianReturn != null) {
    const gapMean = meanReturn - medianReturn;
    if (gapMean > CONFIG.smartMoneyCopyMedianGapMean) {
      penalty += Math.min(
        25,
        ((gapMean - CONFIG.smartMoneyCopyMedianGapMean) / 0.35) * 25
      );
    }
  }
  if (totalReturnRatio != null && medianReturn != null) {
    const gapTotal = totalReturnRatio - medianReturn;
    if (gapTotal > CONFIG.smartMoneyCopyMedianGapTotal) {
      penalty += Math.min(
        20,
        ((gapTotal - CONFIG.smartMoneyCopyMedianGapTotal) / 0.4) * 20
      );
    }
  }
  if (medianReturn != null && medianReturn < 0) {
    penalty += Math.min(15, (-medianReturn / 0.1) * 15);
  }
  penalty = Math.min(CONFIG.smartMoneyCopyMedianPenaltyCap, penalty);
  if (
    (meanReturn != null &&
      medianReturn != null &&
      meanReturn - medianReturn > CONFIG.smartMoneyCopyMedianGapMean) ||
    (totalReturnRatio != null &&
      medianReturn != null &&
      totalReturnRatio - medianReturn > CONFIG.smartMoneyCopyMedianGapTotal)
  ) {
    flags.push('MEDIAN_INFLATED');
  }

  return {
    medianProfitScore: roundScore(clamp(shrunkScore - penalty, 0, 100)),
    rawMedianScore: roundScore(rawMedianScore),
    shrunkScore: roundScore(shrunkScore),
    penalty: roundScore(penalty),
    flags,
    inputs,
  };
}

/**
 * 合成仿跟单主分。无 RT 时 rtScore 应为 0（由仿真层保证）。
 */
export function composeCopyabilityScore(input: {
  rtScore: number;
  roundTripCount: number;
  closedDist?:
    | Pick<
        ClosedMarketReturnDistribution,
        'medianReturn' | 'meanReturn' | 'totalReturnRatio' | 'sampledMarketCount'
      >
    | null;
}): ComposeCopyabilityScoreResult {
  const weights = normalizeWeights();
  const median = computeMedianProfitScore(input.closedDist ?? null);
  const rtScore = clamp(Number(input.rtScore) || 0, 0, 100);
  const compositeScore = roundScore(
    clamp(weights.rt * rtScore + weights.median * median.medianProfitScore, 0, 100)
  );
  const flags = [...median.flags];
  if (input.roundTripCount < 1) flags.push('NO_ROUND_TRIP');

  const primaryIsComposite = CONFIG.smartMoneyCopyCompositeAsPrimary;
  return {
    copyabilityScore: primaryIsComposite ? compositeScore : roundScore(rtScore),
    rtScore: roundScore(rtScore),
    compositeScore,
    medianProfitScore: median.medianProfitScore,
    roundTripCount: Math.max(0, Math.round(input.roundTripCount)),
    weights,
    flags,
    median,
  };
}

/** 从 scoreExplain 解析已缓存的纯 RT 仿真分（优先 v2 rtScore，否则 multiScenario） */
export function rtScoreFromExplain(scoreExplain: unknown): number | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object') return null;
  const copyability = (scoreExplain as Record<string, unknown>).copyability;
  if (copyability == null || typeof copyability !== 'object') return null;
  const c = copyability as Record<string, unknown>;
  const direct = Number(c.rtScore);
  if (Number.isFinite(direct)) return direct;
  const multi = c.multiScenario;
  if (multi != null && typeof multi === 'object') {
    const score = Number((multi as Record<string, unknown>).score);
    if (Number.isFinite(score)) return score;
  }
  const metrics = c.metrics;
  if (metrics != null && typeof metrics === 'object') {
    // 旧版 metrics.copyabilityScore 即为纯 RT
    const version = c.version;
    if (version !== 'v2_rt_median') {
      const m = Number((metrics as Record<string, unknown>).copyabilityScore);
      if (Number.isFinite(m)) return m;
    }
  }
  return null;
}

export function roundTripCountFromExplain(scoreExplain: unknown): number | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object') return null;
  const copyability = (scoreExplain as Record<string, unknown>).copyability;
  if (copyability == null || typeof copyability !== 'object') return null;
  const c = copyability as Record<string, unknown>;
  const direct = Number(c.roundTripCount);
  if (Number.isFinite(direct) && direct >= 0) return Math.round(direct);
  const metrics = c.metrics;
  if (metrics != null && typeof metrics === 'object') {
    const n = Number((metrics as Record<string, unknown>).roundTripCount);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return null;
}

/**
 * Gate/复评廉价重算：用缓存 RT + 当次 closed 分布合成综合分，不拉 trades。
 * 若无可用 RT 缓存则返回 null（保持原 copyabilityScore）。
 */
export function recomposeCopyabilityWithClosedDist(input: {
  scoreExplain: unknown;
  fallbackCopyabilityScore: number | null;
  closedDist:
    | Pick<
        ClosedMarketReturnDistribution,
        'medianReturn' | 'meanReturn' | 'totalReturnRatio' | 'sampledMarketCount'
      >
    | null;
}): ComposeCopyabilityScoreResult | null {
  if (!CONFIG.smartMoneyCopyCompositeAsPrimary) return null;
  const rtScore = rtScoreFromExplain(input.scoreExplain);
  const resolvedRt =
    rtScore != null
      ? rtScore
      : input.fallbackCopyabilityScore != null && Number.isFinite(input.fallbackCopyabilityScore)
        ? // 旧行尚无 v2：榜上分即纯 RT
          Number(input.fallbackCopyabilityScore)
        : null;
  if (resolvedRt == null) return null;
  const roundTripCount =
    roundTripCountFromExplain(input.scoreExplain) ?? (resolvedRt > 0 ? 1 : 0);
  return composeCopyabilityScore({
    rtScore: resolvedRt,
    roundTripCount,
    closedDist: input.closedDist,
  });
}

/** explain.copyability 扩展字段（V2） */
export function buildCopyabilityCompositeExplain(
  composed: ComposeCopyabilityScoreResult
): Record<string, unknown> {
  return {
    version: 'v2_rt_median',
    weights: composed.weights,
    copyabilityScore: composed.copyabilityScore,
    compositeScore: composed.compositeScore,
    rtScore: composed.rtScore,
    roundTripCount: composed.roundTripCount,
    medianProfitScore: composed.medianProfitScore,
    primaryIsComposite: CONFIG.smartMoneyCopyCompositeAsPrimary,
    median: {
      ...composed.median.inputs,
      rawMedianScore: composed.median.rawMedianScore,
      shrunkScore: composed.median.shrunkScore,
      penalty: composed.median.penalty,
      flags: composed.median.flags,
    },
    flags: composed.flags,
  };
}
