/**
 * 成交名义分布：中位数 + 粉尘占比（HIGH_DUST_SHARE 软扣分 / S/A / 大额软分）
 */
export type TradeNotionalStats = {
  medianNotionalUsd: number | null;
  dustShare: number | null;
  sampleCount: number;
};

function medianSorted(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function computeTradeNotionalStats(
  notionals: Array<number | null | undefined>,
  dustThresholdUsd: number
): TradeNotionalStats {
  const values = notionals
    .map((n) => (n == null ? NaN : Number(n)))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return { medianNotionalUsd: null, dustShare: null, sampleCount: 0 };
  }
  const dustCount = values.filter((n) => n < dustThresholdUsd).length;
  return {
    medianNotionalUsd: medianSorted(values),
    dustShare: dustCount / values.length,
    sampleCount: values.length,
  };
}

/** 粉尘软扣分判定（原 L1-DUST 硬门；现仅用于评分侧 HIGH_DUST_SHARE） */
export function failsL1DustGate(input: {
  medianNotionalUsd: number | null;
  dustShare: number | null;
  sampleCount: number;
  minSampleCount: number;
  minMedianUsd: number;
  maxDustShare: number;
}): boolean {
  if (input.sampleCount < input.minSampleCount) {
    return false;
  }
  if (input.minMedianUsd > 0 && input.medianNotionalUsd != null && input.medianNotionalUsd < input.minMedianUsd) {
    return true;
  }
  if (
    input.maxDustShare > 0 &&
    input.dustShare != null &&
    input.dustShare >= input.maxDustShare
  ) {
    return true;
  }
  return false;
}
