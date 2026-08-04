import assert from 'node:assert/strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/polycopy_test';
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main(): Promise<void> {
  const {
    businessDayKey,
    isScoredOnBusinessDay,
    compareBgOrder,
    computeDualChannelNextDeepAnalyzeAt,
  } = await import('./smartMoneyCopyPoolRescoreChannels');
  const { planCopyPoolPipelineReconciliation } = await import(
    './smartMoneyCopyPoolConsistency'
  );
  const { CONFIG } = await import('../../config/env');

  assert.equal(CONFIG.smartMoneyCopyPoolRescoreMode, 'dual_channel');
  assert.equal(CONFIG.smartMoneyClosedGateMaxPages, 30);
  assert.ok(CONFIG.smartMoneyCopyPoolDailyTopN >= 1);
  assert.ok(CONFIG.smartMoneyCopyPoolDailyTopN <= 500);

  const now = new Date('2026-07-29T12:00:00.000Z');
  assert.equal(businessDayKey(now, 'UTC'), '2026-07-29');
  assert.equal(isScoredOnBusinessDay(new Date('2026-07-29T01:00:00.000Z'), now, 'UTC'), true);
  assert.equal(isScoredOnBusinessDay(new Date('2026-07-28T23:00:00.000Z'), now, 'UTC'), false);
  assert.equal(isScoredOnBusinessDay(null, now, 'UTC'), false);

  assert.ok(compareBgOrder({ rank: 101, wallet: '0xa' }, { rank: 200, wallet: '0xb' }) < 0);
  assert.ok(compareBgOrder({ rank: null, wallet: '0xa' }, { rank: 200, wallet: '0xb' }) < 0);
  assert.ok(compareBgOrder({ rank: null, wallet: '0xa' }, { rank: null, wallet: '0xb' }) < 0);

  const dualAt = computeDualChannelNextDeepAnalyzeAt(now);
  assert.equal(
    dualAt.getTime(),
    now.getTime() + CONFIG.smartMoneyCopyPoolBgRescoreMs,
    'F5: dual_channel background 成功后不得 nextDeep=now'
  );
  const priorityAt = computeDualChannelNextDeepAnalyzeAt(now, 'priority');
  assert.equal(
    priorityAt.getTime(),
    now.getTime() + CONFIG.smartMoneyCopyPoolPriorityRescoreMs
  );

  const reconciliation = planCopyPoolPipelineReconciliation(
    [
      { wallet: '0xmissing', copyPoolEnteredAt: now, lastScoredAt: now },
      { wallet: '0xraw', copyPoolEnteredAt: now, lastScoredAt: now },
      { wallet: '0xqualified', copyPoolEnteredAt: now, lastScoredAt: now },
      { wallet: '0xeliminated', copyPoolEnteredAt: now, lastScoredAt: now },
      { wallet: '0xcopy', copyPoolEnteredAt: now, lastScoredAt: now },
      { wallet: '0xrunning', copyPoolEnteredAt: now, lastScoredAt: now },
    ],
    [
      { wallet: '0xraw', pipelineStage: 'RAW' },
      { wallet: '0xqualified', pipelineStage: 'QUALIFIED' },
      { wallet: '0xeliminated', pipelineStage: 'ELIMINATED' },
      { wallet: '0xcopy', pipelineStage: 'COPY_POOL' },
      { wallet: '0xrunning', pipelineStage: 'FULL_ANALYZING' },
    ]
  );
  assert.deepEqual(reconciliation.missing.map((row) => row.wallet), ['0xmissing']);
  assert.deepEqual(reconciliation.driftedWallets, [
    '0xraw',
    '0xqualified',
    '0xeliminated',
  ]);
  assert.equal(reconciliation.activeAnalyzing, 1);

  console.log('smartMoneyCopyPoolRescoreChannels.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
