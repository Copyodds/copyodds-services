import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.SMART_MONEY_RANK_MODEL_ENABLED = 'true';
// 验证旧 display blend 时用非 v4；v4.0 禁止 copyability 双计
process.env.SMART_MONEY_SCORE_VERSION = 'v3.1';
process.env.SMART_MONEY_COPYABILITY_ENABLED = 'true';

async function main(): Promise<void> {
  const { computeDisplayScore, computeMlDisplayScore } = await import('./smartMoneyDisplayScore');

  assert.equal(computeDisplayScore(null, 72.5), 72.5);
  assert.equal(Math.round((80 * 0.7 + 60 * 0.3) * 100) / 100, 74);
  assert.equal(computeDisplayScore(80, 60), 74);
  assert.equal(computeMlDisplayScore(80, 70), 74);
  assert.equal(Math.round((70 * 0.6 + 80 * 0.4) * 100) / 100, 74);

  console.log('smartMoneyDisplayScore.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
