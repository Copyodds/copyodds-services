/**
 * 评分门槛调整：TraderScore 演进影子 + 三情景 Copy 合成冒烟
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import assert from 'node:assert/strict';

async function main(): Promise<void> {
  const { computeTraderScore, TRADER_SCORE_WEIGHTS } = await import('./smartMoneyTraderScore.js');
  const { computeCopyabilityScore, simulateCopyabilityMultiScenario } = await import(
    './smartMoneyCopyabilitySim.js'
  );

  assert.equal(TRADER_SCORE_WEIGHTS.profitability, 0.3);
  assert.equal(
    TRADER_SCORE_WEIGHTS.edge +
      TRADER_SCORE_WEIGHTS.profitability +
      TRADER_SCORE_WEIGHTS.copyability +
      TRADER_SCORE_WEIGHTS.drawdownHealth +
      TRADER_SCORE_WEIGHTS.survivalConsistency,
    1
  );

  const base = computeTraderScore({
    edgeScore: 70,
    edgeSampleN: 12,
    totalReturn: 0.25,
    profitFactor: 1.6,
    winRate: 0.55,
    closedMarketCount: 20,
    copyabilityScore: 60,
    copyabilityMissing: false,
    activeDays: 200,
    maxDrawdownPercent: 0.25,
    consistencyScore: 60,
    top1MarketPnlShare: 0.2,
    hasHighTradeFrequencyFlag: false,
    hasElevatedTradeFrequencyFlag: false,
    hasHedgedPairFlag: false,
    hasBlacklistedFlag: false,
    extremeOddsShare: 0.05,
    pnl1yUsd: 2000,
    pnl30dUsd: 400,
    pnl7dUsd: 50,
    maxDrawdownUsd: 500,
    totalPnlUsd: 2000,
    mdd7dPercent: 0.05,
    mdd30dPercent: 0.12,
    mddAllPercent: 0.25,
  });
  assert.equal(base.formula, 'legacy');
  assert.ok(base.traderScoreNext > 0);
  assert.ok(base.traderScoreLegacy > 0);
  assert.equal(base.traderScore, base.traderScoreLegacy);

  const pathHit = computeTraderScore({
    edgeScore: 70,
    edgeSampleN: 12,
    totalReturn: 0.25,
    profitFactor: 1.6,
    winRate: 0.55,
    closedMarketCount: 20,
    copyabilityScore: 60,
    copyabilityMissing: false,
    activeDays: 200,
    maxDrawdownPercent: 0.25,
    consistencyScore: 60,
    top1MarketPnlShare: 0.2,
    hasHighTradeFrequencyFlag: false,
    hasHedgedPairFlag: false,
    hasBlacklistedFlag: false,
    extremeOddsShare: 0.05,
    maxDrawdownUsd: 3000,
    totalPnlUsd: 1000,
    pnl1yUsd: 1000,
  });
  assert.ok(
    pathHit.traderScoreNext <= base.traderScoreNext,
    `MDD$>=PnL$ should not raise next score (${pathHit.traderScoreNext} vs ${base.traderScoreNext})`
  );

  const single = computeCopyabilityScore({
    simulatedRoi: 0.1,
    simulatedWinRate: 0.55,
    simulatedMaxDrawdown: 0.1,
    replicableTradeShare: 0.5,
    roundTripCount: 5,
  });
  assert.ok(single > 0);

  const multi = simulateCopyabilityMultiScenario([]);
  assert.equal(multi.copyabilityScore, 0);
  assert.ok('tight' in multi.scenarios && 'base' in multi.scenarios && 'stress' in multi.scenarios);

  const { inferDrawdownRecovered } = await import('./smartMoneyScorer.js');
  assert.equal(
    inferDrawdownRecovered({ maxDrawdownPercent: 0.6, currentDrawdownPercent: 0.02 }),
    true
  );
  assert.equal(
    inferDrawdownRecovered({ maxDrawdownPercent: 0.6, currentDrawdownPercent: 0.3 }),
    false
  );
  assert.equal(
    inferDrawdownRecovered({ maxDrawdownPercent: 0.2, currentDrawdownPercent: 0.01 }),
    false
  );

  console.log('smartMoneyScoreGateV2.smoke.test.ts: ok', {
    legacy: base.traderScoreLegacy,
    next: base.traderScoreNext,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
