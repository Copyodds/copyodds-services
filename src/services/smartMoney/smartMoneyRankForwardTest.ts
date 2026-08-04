import { inferRankScoreFromRow, type RankModelRowFeatures } from './smartMoneyRankModel';
import type { CopierFeedbackSnapshot } from './smartMoneyCopierFeedbackMetrics';

export type { RankModelRowFeatures } from './smartMoneyRankModel';

export type RankForwardTestRow = {
  wallet: string;
  smartMoneyScore: number;
  copyabilityScore: number | null;
  rankScore?: number | null;
  copierRoi: number | null;
  tier2Enhanced?: boolean;
  feedback?: CopierFeedbackSnapshot | null;
  rowFeatures?: RankModelRowFeatures;
};

export type RankForwardTestVariantId =
  | 'smart_score'
  | 'copyability'
  | 'phase2_display'
  | 'phase3_ml'
  | 'rank_score';

export type RankForwardTestWeights = {
  phase2Copy: number;
  phase2Smart: number;
  phase3Rank: number;
  phase3Copy: number;
};

export const DEFAULT_FORWARD_TEST_WEIGHTS: RankForwardTestWeights = {
  phase2Copy: 0.7,
  phase2Smart: 0.3,
  phase3Rank: 0.6,
  phase3Copy: 0.4,
};

export type RankForwardTestVariantResult = {
  variant: RankForwardTestVariantId;
  sampleCount: number;
  labeledCount: number;
  spearmanRho: number | null;
  topDecileMeanRoi: number | null;
  bottomDecileMeanRoi: number | null;
  spreadTopBottom: number | null;
};

export type RankForwardTestReport = {
  generatedAt: string;
  lookbackNote: string;
  variants: RankForwardTestVariantResult[];
  winner: RankForwardTestVariantId | null;
};

function roundMetric(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function blend(copy: number | null, other: number, copyWeight: number, otherWeight: number): number {
  if (copy == null) return other;
  const total = copyWeight + otherWeight;
  if (total <= 0) return other;
  return (copy * copyWeight + other * otherWeight) / total;
}

export function resolveVariantScore(
  row: RankForwardTestRow,
  variant: RankForwardTestVariantId,
  weights: RankForwardTestWeights = DEFAULT_FORWARD_TEST_WEIGHTS
): number {
  switch (variant) {
    case 'smart_score':
      return row.smartMoneyScore;
    case 'copyability':
      return row.copyabilityScore ?? row.smartMoneyScore;
    case 'phase2_display':
      return blend(
        row.copyabilityScore,
        row.smartMoneyScore,
        weights.phase2Copy,
        weights.phase2Smart
      );
    case 'rank_score': {
      if (row.rankScore != null) return row.rankScore;
      if (row.rowFeatures) {
        return inferRankScoreFromRow({
          row: row.rowFeatures,
          feedback: row.feedback ?? null,
          tier2Enhanced: row.tier2Enhanced ?? false,
        });
      }
      return row.smartMoneyScore;
    }
    case 'phase3_ml': {
      const rank =
        row.rankScore ??
        (row.rowFeatures
          ? inferRankScoreFromRow({
              row: row.rowFeatures,
              feedback: row.feedback ?? null,
              tier2Enhanced: row.tier2Enhanced ?? false,
            })
          : row.smartMoneyScore);
      return blend(row.copyabilityScore, rank, weights.phase3Copy, weights.phase3Rank);
    }
    default:
      return row.smartMoneyScore;
  }
}

function averageRanks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.value === indexed[i]!.value) {
      j += 1;
    }
    const avgRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) {
      ranks[indexed[k]!.index] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

export function spearmanCorrelation(
  pairs: Array<{ score: number; label: number }>
): number | null {
  if (pairs.length < 3) return null;
  const scoreRanks = averageRanks(pairs.map((pair) => pair.score));
  const labelRanks = averageRanks(pairs.map((pair) => pair.label));
  const n = pairs.length;
  let sumD2 = 0;
  for (let i = 0; i < n; i += 1) {
    const d = scoreRanks[i]! - labelRanks[i]!;
    sumD2 += d * d;
  }
  return roundMetric(1 - (6 * sumD2) / (n * (n * n - 1)));
}

export function computeDecileSpread(
  pairs: Array<{ score: number; label: number }>,
  decileCount = 10
): { topMean: number | null; bottomMean: number | null; spread: number | null } {
  if (pairs.length < decileCount) {
    return { topMean: null, bottomMean: null, spread: null };
  }
  const sorted = [...pairs].sort((left, right) => right.score - left.score);
  const bucketSize = Math.max(1, Math.floor(sorted.length / decileCount));
  const top = sorted.slice(0, bucketSize);
  const bottom = sorted.slice(-bucketSize);
  const topMean = top.reduce((sum, row) => sum + row.label, 0) / top.length;
  const bottomMean = bottom.reduce((sum, row) => sum + row.label, 0) / bottom.length;
  return {
    topMean: roundMetric(topMean),
    bottomMean: roundMetric(bottomMean),
    spread: roundMetric(topMean - bottomMean),
  };
}

export function evaluateRankVariant(
  rows: RankForwardTestRow[],
  variant: RankForwardTestVariantId,
  weights: RankForwardTestWeights = DEFAULT_FORWARD_TEST_WEIGHTS
): RankForwardTestVariantResult {
  const labeledPairs: Array<{ score: number; label: number }> = [];
  for (const row of rows) {
    if (row.copierRoi == null || !Number.isFinite(row.copierRoi)) continue;
    labeledPairs.push({
      score: resolveVariantScore(row, variant, weights),
      label: row.copierRoi,
    });
  }

  const deciles = computeDecileSpread(labeledPairs);
  return {
    variant,
    sampleCount: rows.length,
    labeledCount: labeledPairs.length,
    spearmanRho: spearmanCorrelation(labeledPairs),
    topDecileMeanRoi: deciles.topMean,
    bottomDecileMeanRoi: deciles.bottomMean,
    spreadTopBottom: deciles.spread,
  };
}

export function pickForwardTestWinner(
  variants: RankForwardTestVariantResult[]
): RankForwardTestVariantId | null {
  const ranked = [...variants]
    .filter((variant) => variant.labeledCount >= 3)
    .sort((left, right) => {
      const leftSpread = left.spreadTopBottom ?? -Infinity;
      const rightSpread = right.spreadTopBottom ?? -Infinity;
      if (rightSpread !== leftSpread) return rightSpread - leftSpread;
      const leftRho = left.spearmanRho ?? -Infinity;
      const rightRho = right.spearmanRho ?? -Infinity;
      return rightRho - leftRho;
    });
  return ranked[0]?.variant ?? null;
}

export function runRankForwardTest(
  rows: RankForwardTestRow[],
  variants: RankForwardTestVariantId[] = [
    'smart_score',
    'copyability',
    'phase2_display',
    'rank_score',
    'phase3_ml',
  ],
  weights: RankForwardTestWeights = DEFAULT_FORWARD_TEST_WEIGHTS
): RankForwardTestReport {
  const results = variants.map((variant) => evaluateRankVariant(rows, variant, weights));
  return {
    generatedAt: new Date().toISOString(),
    lookbackNote: 'Label = copierRoi with full sample weight (see copier feedback aggregation)',
    variants: results,
    winner: pickForwardTestWinner(results),
  };
}
