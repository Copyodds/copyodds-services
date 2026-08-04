import assert from 'node:assert/strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/polycopy_test';
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main(): Promise<void> {
  const {
    computeCopyPoolNextDeepAnalyzeAt,
    computeCopyPoolRescoreDelayMs,
  } = await import('./smartMoneyCopyPoolReschedule');
  const { CONFIG } = await import('../../config/env');

  const DAY = 24 * 60 * 60 * 1000;

  assert.equal(computeCopyPoolRescoreDelayMs(1), CONFIG.smartMoneyCopyPoolRescoreTopMs);
  assert.equal(computeCopyPoolRescoreDelayMs(100), CONFIG.smartMoneyCopyPoolRescoreTopMs);
  assert.equal(computeCopyPoolRescoreDelayMs(101), CONFIG.smartMoneyCopyPoolRescoreMidMs);
  assert.equal(computeCopyPoolRescoreDelayMs(500), CONFIG.smartMoneyCopyPoolRescoreMidMs);
  assert.equal(computeCopyPoolRescoreDelayMs(501), CONFIG.smartMoneyCopyPoolRescoreTailMs);
  // 纯函数仍把 null 当尾部；调度路径必须先 resolveCopyPoolRescoreRank，避免 Top 被冻 7d
  assert.equal(computeCopyPoolRescoreDelayMs(null), CONFIG.smartMoneyCopyPoolRescoreTailMs);

  const now = new Date('2026-07-20T00:00:00.000Z');
  const topAt = computeCopyPoolNextDeepAnalyzeAt(50, now);
  assert.equal(topAt.getTime() - now.getTime(), CONFIG.smartMoneyCopyPoolRescoreTopMs);
  assert.ok(CONFIG.smartMoneyCopyPoolRescoreTopMs <= DAY + 1000);
  assert.ok(CONFIG.smartMoneyCopyPoolRescoreTailMs >= 5 * DAY);

  console.log('smartMoneyCopyPoolReschedule.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
