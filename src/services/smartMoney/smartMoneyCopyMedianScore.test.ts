/**
 * 跑：npx tsx src/services/smartMoney/smartMoneyCopyMedianScore.test.ts
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import assert from 'node:assert/strict';
import {
  closedReturnDistFromExplain,
  composeCopyabilityScore,
  computeMedianProfitScore,
} from './smartMoneyCopyMedianScore.js';

const missing = computeMedianProfitScore(null);
assert.equal(missing.medianProfitScore, 35);
assert.ok(missing.flags.includes('MEDIAN_MISSING'));

const thin = computeMedianProfitScore({
  sampledMarketCount: 2,
  medianReturn: 0.2,
  meanReturn: 0.2,
  totalReturnRatio: 0.2,
});
assert.equal(thin.medianProfitScore, 35);
assert.ok(thin.flags.includes('MEDIAN_SAMPLE_THIN'));

const solid = computeMedianProfitScore({
  sampledMarketCount: 20,
  medianReturn: 0.1,
  meanReturn: 0.12,
  totalReturnRatio: 0.11,
});
assert.ok(solid.medianProfitScore > 40);
assert.ok(!solid.flags.includes('MEDIAN_INFLATED'));

const inflated = computeMedianProfitScore({
  sampledMarketCount: 20,
  medianReturn: 0.02,
  meanReturn: 0.4,
  totalReturnRatio: 0.5,
});
assert.ok(inflated.flags.includes('MEDIAN_INFLATED'));
assert.ok(inflated.medianProfitScore < solid.medianProfitScore);

const noRt = composeCopyabilityScore({
  rtScore: 0,
  roundTripCount: 0,
  closedDist: {
    sampledMarketCount: 30,
    medianReturn: 0.2,
    meanReturn: 0.22,
    totalReturnRatio: 0.21,
  },
});
assert.ok(noRt.flags.includes('NO_ROUND_TRIP'));
assert.ok(noRt.compositeScore <= 40 + 1e-6);
assert.ok(noRt.compositeScore > 0);

const withRt = composeCopyabilityScore({
  rtScore: 70,
  roundTripCount: 5,
  closedDist: {
    sampledMarketCount: 20,
    medianReturn: 0.1,
    meanReturn: 0.12,
    totalReturnRatio: 0.11,
  },
});
const expected =
  Math.round(
    (withRt.weights.rt * 70 + withRt.weights.median * withRt.medianProfitScore) * 100
  ) / 100;
assert.ok(Math.abs(withRt.compositeScore - expected) < 1e-6);

const fromExplain = closedReturnDistFromExplain({
  closedMarketReturnDistribution: {
    sampledMarketCount: 8,
    medianReturn: 0.05,
    meanReturn: 0.06,
    totalReturnRatio: 0.055,
  },
});
assert.equal(fromExplain?.sampledMarketCount, 8);
assert.equal(fromExplain?.medianReturn, 0.05);

import { recomposeCopyabilityWithClosedDist, rtScoreFromExplain } from './smartMoneyCopyMedianScore.js';

assert.equal(
  rtScoreFromExplain({
    copyability: { multiScenario: { score: 42 }, version: 'v1' },
  }),
  42
);

const recomposed = recomposeCopyabilityWithClosedDist({
  scoreExplain: {
    copyability: {
      version: 'v1',
      multiScenario: { score: 0 },
      metrics: { roundTripCount: 0 },
    },
  },
  fallbackCopyabilityScore: 0,
  closedDist: {
    sampledMarketCount: 30,
    medianReturn: 0.2,
    meanReturn: 0.22,
    totalReturnRatio: 0.21,
  },
});
assert.ok(recomposed != null);
assert.equal(recomposed!.rtScore, 0);
assert.ok(recomposed!.compositeScore > 0);
assert.ok(recomposed!.compositeScore <= 40 + 1e-6);

console.log('smartMoneyCopyMedianScore.test.ts: ok');
