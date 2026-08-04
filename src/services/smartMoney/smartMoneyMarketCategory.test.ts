import assert from 'node:assert/strict';

async function main() {
  const { smartMoneyMarketCategoryLogic } = await import('./smartMoneyMarketCategory');

  assert.equal(smartMoneyMarketCategoryLogic.normalizeMarketCategory('Sports'), 'SPORTS');
  assert.equal(smartMoneyMarketCategoryLogic.normalizeMarketCategory(' US politics '), 'US_POLITICS');
  assert.equal(smartMoneyMarketCategoryLogic.normalizeMarketCategory(''), null);

  const profile = smartMoneyMarketCategoryLogic.buildCategoryProfileFromRows(
    [
      { asset: '1', conditionId: 'c1', size: 10, redeemable: false, currentValue: 120 },
      { asset: '2', conditionId: 'c2', size: 8, redeemable: false, currentValue: 80 },
      { asset: '3', conditionId: 'c3', size: 5, redeemable: false, currentValue: 40 },
    ],
    new Map([
      ['1', { category: 'Sports' }],
      ['2', { category: 'Sports' }],
      ['3', { category: 'Politics' }],
    ])
  );

  assert.ok(profile);
  assert.equal(profile?.dominantCategory, 'SPORTS');
  assert.equal(profile?.diversified, false);
  assert.equal(profile?.buckets[0]?.category, 'SPORTS');
  assert.equal(profile?.buckets[0]?.positionCount, 2);

  const diversified = smartMoneyMarketCategoryLogic.buildCategoryProfileFromRows(
    [
      { asset: '1', conditionId: 'c1', size: 10, redeemable: false, currentValue: 100 },
      { asset: '2', conditionId: 'c2', size: 10, redeemable: false, currentValue: 90 },
      { asset: '3', conditionId: 'c3', size: 10, redeemable: false, currentValue: 80 },
    ],
    new Map([
      ['1', { category: 'Sports' }],
      ['2', { category: 'Politics' }],
      ['3', { category: 'Crypto' }],
    ])
  );

  assert.ok(diversified);
  assert.equal(diversified?.dominantCategory, 'DIVERSIFIED');
  assert.equal(diversified?.diversified, true);

  console.log('smartMoneyMarketCategory.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
