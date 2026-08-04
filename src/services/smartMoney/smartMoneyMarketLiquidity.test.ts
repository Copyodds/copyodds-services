import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main() {
  const { smartMoneyMarketLiquidityLogic } = await import('./smartMoneyMarketLiquidity');

  const profile = smartMoneyMarketLiquidityLogic.buildLiquidityProfileFromRows(
    [
      { asset: '1', conditionId: 'c1', size: 10, redeemable: false, currentValue: 120 },
      { asset: '2', conditionId: 'c2', size: 8, redeemable: false, currentValue: 80 },
      { asset: '3', conditionId: 'c3', size: 5, redeemable: false, currentValue: 40 },
    ],
    new Map([
      ['1', { volumeNum: 250_000 }],
      ['2', { volumeNum: 180_000 }],
      ['3', { volumeNum: 20_000 }],
    ]),
    100_000
  );

  assert.ok(profile);
  assert.equal(profile?.highVolumeMarketShare, 0.8333);
  assert.equal(profile?.lowVolumeMarketShare, 0.1667);
  assert.equal(profile?.classifiedPositionCount, 3);
  assert.equal(profile?.classificationShare, 1);

  const incomplete = smartMoneyMarketLiquidityLogic.buildLiquidityProfileFromRows(
    [{ asset: '1', conditionId: 'c1', size: 10, redeemable: false, currentValue: 120 }],
    new Map(),
    100_000
  );
  assert.ok(incomplete);
  assert.equal(incomplete?.highVolumeMarketShare, null);
  assert.equal(incomplete?.classificationShare, 0);

  console.log('smartMoneyMarketLiquidity.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
