import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

function trade(partial: Partial<import('../polymarket/polymarketTrades').DataApiTrade> &
  Pick<import('../polymarket/polymarketTrades').DataApiTrade, 'side' | 'asset' | 'conditionId'>) {
  return {
    price: 0.5,
    size: 200,
    timestamp: Date.UTC(2026, 5, 1, 12, 0, 0),
    ...partial,
  };
}

async function main(): Promise<void> {
  const {
    computeCopyabilityScore,
    effectiveCopySlippageBps,
    simulateCopyabilityFromTrades,
  } = await import('./smartMoneyCopyabilitySim');
  const { computeDisplayScore } = await import('./smartMoneyDisplayScore');

  assert.equal(effectiveCopySlippageBps(50, 45), 65);

  const profitable = simulateCopyabilityFromTrades(
    [
      trade({ side: 'BUY', asset: 'yes-a', conditionId: 'cond-a', price: 0.4, timestamp: Date.UTC(2026, 5, 1) }),
      trade({ side: 'SELL', asset: 'yes-a', conditionId: 'cond-a', price: 0.6, timestamp: Date.UTC(2026, 5, 2) }),
      trade({ side: 'BUY', asset: 'yes-b', conditionId: 'cond-b', price: 0.3, timestamp: Date.UTC(2026, 5, 3) }),
      trade({ side: 'SELL', asset: 'yes-b', conditionId: 'cond-b', price: 0.45, timestamp: Date.UTC(2026, 5, 4) }),
    ],
    {
      copyNotionalUsd: 100,
      copyDelaySec: 45,
      slippageBps: 50,
      lookbackDays: 30,
      excludeHedged: true,
      minMarketVolumeUsd: 100_000,
    },
    Date.UTC(2026, 5, 10)
  );

  assert.equal(profitable.roundTripCount, 2);
  assert.ok((profitable.simulatedRoi ?? 0) > 0);
  assert.ok(profitable.copyabilityScore > 40);
  assert.equal(profitable.replicableTradeShare, 1);

  const hedgedSkipped = simulateCopyabilityFromTrades(
    [
      trade({ side: 'BUY', asset: 'yes-h', conditionId: 'hedged-cond', price: 0.5 }),
      trade({ side: 'SELL', asset: 'yes-h', conditionId: 'hedged-cond', price: 0.55 }),
    ],
    {
      copyNotionalUsd: 100,
      copyDelaySec: 0,
      slippageBps: 50,
      lookbackDays: 30,
      excludeHedged: true,
      minMarketVolumeUsd: 100_000,
      hedgedConditionIds: new Set(['hedged-cond']),
    },
    Date.UTC(2026, 5, 10)
  );
  assert.equal(hedgedSkipped.roundTripCount, 0);
  assert.equal(hedgedSkipped.copyabilityScore, 0);

  const lowReplScore = computeCopyabilityScore({
    simulatedRoi: 0.2,
    simulatedWinRate: 0.6,
    simulatedMaxDrawdown: 0.1,
    replicableTradeShare: 0.2,
    roundTripCount: 3,
  });
  const highReplScore = computeCopyabilityScore({
    simulatedRoi: 0.2,
    simulatedWinRate: 0.6,
    simulatedMaxDrawdown: 0.1,
    replicableTradeShare: 0.8,
    roundTripCount: 3,
  });
  assert.ok(lowReplScore < highReplScore);

  assert.equal(computeDisplayScore(80, 60), 60);
  assert.equal(Math.round((80 * 0.7 + 60 * 0.3) * 100) / 100, 74);

  console.log('smartMoneyCopyability.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
