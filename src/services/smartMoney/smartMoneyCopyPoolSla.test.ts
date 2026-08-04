import assert from 'node:assert/strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/polycopy_test';
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main(): Promise<void> {
  const { checkCopyPoolTopNDailySla } = await import('./smartMoneyCopyPoolSla');

  // 非日终窗口且不 force → 不检查
  const early = await checkCopyPoolTopNDailySla({
    now: new Date('2026-07-29T10:00:00.000Z'),
    force: false,
  });
  assert.equal(early.checked, false);

  console.log('smartMoneyCopyPoolSla.test.ts: ok (window gate)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
