import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main(): Promise<void> {
  const { buildRankModelFeatures, copierRoiToSignal, inferRankScore } = await import(
    './smartMoneyRankModel'
  );

  assert.equal(copierRoiToSignal(0), 50);
  assert.equal(copierRoiToSignal(0.25), 75);

  const baseline = inferRankScore(
    buildRankModelFeatures({
      row: {
        score: 70,
        pnlQuality: 80,
        activityScore: 60,
        consistencyScore: 75,
        externalQualityScore: 65,
        copyabilityScore: 72,
      },
      feedback: null,
      tier2Enhanced: false,
    })
  );
  assert.ok(baseline >= 65 && baseline <= 80);

  const withFeedback = inferRankScore(
    buildRankModelFeatures({
      row: {
        score: 70,
        pnlQuality: 80,
        activityScore: 60,
        consistencyScore: 75,
        externalQualityScore: 65,
        copyabilityScore: 72,
      },
      feedback: {
        version: 'v1',
        lookbackDays: 30,
        computedAt: new Date().toISOString(),
        closeCount: 20,
        tradeCount: 25,
        subscriberCount: 5,
        totalPnlUsd: 200,
        totalNotionalUsd: 1000,
        copierRoi: 0.2,
        sampleWeight: 1,
      },
      tier2Enhanced: true,
    })
  );
  assert.ok(withFeedback > baseline);

  console.log('smartMoneyRankModel.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
