import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main(): Promise<void> {
  const {
    buildCopierFeedbackSnapshot,
    computeCopierRoi,
    computeCopierSampleWeight,
  } = await import('./smartMoneyCopierFeedbackMetrics');

  assert.equal(computeCopierRoi(50, 200), 0.25);
  assert.equal(computeCopierRoi(50, 0), null);

  assert.equal(
    computeCopierSampleWeight({ closeCount: 10, subscriberCount: 4, minCloses: 5, minSubscribers: 2 }),
    1
  );
  assert.equal(
    computeCopierSampleWeight({ closeCount: 2, subscriberCount: 1, minCloses: 5, minSubscribers: 2 }),
    0.4
  );

  const snapshot = buildCopierFeedbackSnapshot({
    lookbackDays: 30,
    closeCount: 12,
    tradeCount: 15,
    subscriberCount: 3,
    totalPnlUsd: 120,
    totalNotionalUsd: 1000,
    minCloses: 5,
    minSubscribers: 2,
  });
  assert.equal(snapshot.version, 'v1');
  assert.equal(snapshot.copierRoi, 0.12);
  assert.equal(snapshot.sampleWeight, 1);

  const sparse = buildCopierFeedbackSnapshot({
    lookbackDays: 30,
    closeCount: 1,
    tradeCount: 1,
    subscriberCount: 1,
    totalPnlUsd: 10,
    totalNotionalUsd: 100,
    minCloses: 5,
    minSubscribers: 2,
  });
  assert.equal(sparse.copierRoi, null);
  assert.equal(sparse.sampleWeight, 0.2);

  console.log('smartMoneyCopierFeedback.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
