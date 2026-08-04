import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main() {
  const {
    buildPositionPnlStats,
    detectHedgedPairExposure,
    EMPTY_OPEN_POSITION_STATS,
    HEDGED_PAIR_SHARE_THRESHOLD,
  } = await import('./smartMoneyPositionStats');
  const { isSmartMoneyEligibleFromFlags } = await import('./smartMoneyScorer');
  const { resolvePersistedEligibleForTest } = await import('./smartMoneyLeaderboardWriter');
  type DataApiPosition = import('../polymarket/polymarketData').DataApiPosition;

  function pos(
    partial: Partial<DataApiPosition> & Pick<DataApiPosition, 'asset' | 'conditionId' | 'size'>
  ): DataApiPosition {
    return {
      redeemable: false,
      ...partial,
    };
  }

  const condition = 'cond-vance-2028';

  const fullHedgeRows: DataApiPosition[] = [
    pos({
      asset: 'yes-token',
      conditionId: condition,
      outcome: 'Yes',
      outcomeIndex: 0,
      size: 325_545,
      avgPrice: 0.5,
      // MTM 已严重偏离：若误用 currentValue 会把等量对冲算成 <50%
      currentValue: 64_946,
    }),
    pos({
      asset: 'no-token',
      conditionId: condition,
      outcome: 'No',
      outcomeIndex: 1,
      size: 325_545,
      avgPrice: 0.5,
      currentValue: 260_599,
    }),
  ];

  const hedge = detectHedgedPairExposure(fullHedgeRows);
  assert.equal(hedge.hedgedMarketCount, 1);
  assert.ok(hedge.hedgedPairShare != null && hedge.hedgedPairShare >= HEDGED_PAIR_SHARE_THRESHOLD);
  assert.ok(
    (hedge.hedgedPairShare ?? 0) >= 0.99,
    `equal Yes/No book should be ~100% hedged, got ${hedge.hedgedPairShare}`
  );

  const singleSide = detectHedgedPairExposure([
    pos({
      asset: 'yes-token',
      conditionId: condition,
      outcome: 'Yes',
      size: 10_000,
      avgPrice: 0.5,
      currentValue: 5_000,
    }),
  ]);
  assert.equal(singleSide.hedgedMarketCount, 0);
  assert.equal(singleSide.hedgedPairShare, 0);

  const tinyHedgeBesideDirectional: DataApiPosition[] = [
    pos({
      asset: 'yes-a',
      conditionId: 'cond-a',
      outcome: 'Yes',
      size: 100,
      avgPrice: 0.5,
      currentValue: 50,
    }),
    pos({
      asset: 'no-a',
      conditionId: 'cond-a',
      outcome: 'No',
      size: 100,
      avgPrice: 0.5,
      currentValue: 50,
    }),
    pos({
      asset: 'yes-b',
      conditionId: 'cond-b',
      outcome: 'Yes',
      size: 20_000,
      avgPrice: 0.5,
      currentValue: 10_000,
    }),
  ];
  const minorityHedge = detectHedgedPairExposure(tinyHedgeBesideDirectional);
  assert.equal(minorityHedge.hedgedMarketCount, 1);
  assert.ok(
    (minorityHedge.hedgedPairShare ?? 1) < HEDGED_PAIR_SHARE_THRESHOLD,
    'small paired book next to large directional should stay under threshold'
  );

  const unbalanced = detectHedgedPairExposure([
    pos({
      asset: 'yes-token',
      conditionId: condition,
      outcome: 'Yes',
      size: 10_000,
      currentValue: 5_000,
    }),
    pos({
      asset: 'no-token',
      conditionId: condition,
      outcome: 'No',
      size: 100,
      currentValue: 50,
    }),
  ]);
  assert.equal(unbalanced.hedgedMarketCount, 0, 'highly unbalanced sides should not count as hedge pair');

  const hedgedStats = buildPositionPnlStats(null, EMPTY_OPEN_POSITION_STATS, fullHedgeRows);
  assert.ok((hedgedStats.hedgedPairExposure?.hedgedPairShare ?? 0) >= HEDGED_PAIR_SHARE_THRESHOLD);

  assert.equal(
    isSmartMoneyEligibleFromFlags(['HEDGED_PAIR_EXPOSURE']),
    false,
    'hedged pair flag must block eligibility'
  );

  assert.equal(
    resolvePersistedEligibleForTest({
      scoredEligible: false,
      riskFlags: ['HEDGED_PAIR_EXPOSURE'],
    }),
    false,
    'hedged pair flag must block eligibility'
  );

  assert.equal(
    resolvePersistedEligibleForTest({
      scoredEligible: false,
      riskFlags: ['WEAK_RECENT_PERFORMANCE'],
    }),
    false,
    'without sticky, soft flags follow scoredEligible'
  );

  assert.equal(
    resolvePersistedEligibleForTest({
      scoredEligible: true,
      riskFlags: ['WEAK_RECENT_PERFORMANCE'],
    }),
    true,
    'scoredEligible true kept when no hard flags'
  );

  assert.equal(
    resolvePersistedEligibleForTest({
      scoredEligible: true,
      riskFlags: ['BLACKLISTED'],
    }),
    false,
    'hard flags override scoredEligible'
  );

  console.log('smartMoneyHedgedPair.test.ts: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
