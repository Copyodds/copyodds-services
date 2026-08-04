import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main(): Promise<void> {
  const {
    evaluateRankVariant,
    runRankForwardTest,
    spearmanCorrelation,
    resolveVariantScore,
    DEFAULT_FORWARD_TEST_WEIGHTS,
  } = await import('./smartMoneyRankForwardTest');

  const rows = [
    { wallet: 'a', smartMoneyScore: 90, copyabilityScore: 70, copierRoi: 0.3 },
    { wallet: 'b', smartMoneyScore: 80, copyabilityScore: 75, copierRoi: 0.2 },
    { wallet: 'c', smartMoneyScore: 70, copyabilityScore: 80, copierRoi: 0.15 },
    { wallet: 'd', smartMoneyScore: 60, copyabilityScore: 50, copierRoi: 0.05 },
    { wallet: 'e', smartMoneyScore: 50, copyabilityScore: 40, copierRoi: -0.1 },
    { wallet: 'f', smartMoneyScore: 40, copyabilityScore: 30, copierRoi: -0.2 },
  ];

  const rho = spearmanCorrelation(
    rows.map((row) => ({
      score: resolveVariantScore(row, 'smart_score', DEFAULT_FORWARD_TEST_WEIGHTS),
      label: row.copierRoi!,
    }))
  );
  assert.ok(rho != null && rho > 0.8);

  const phase2 = evaluateRankVariant(rows, 'phase2_display');
  const phase3 = evaluateRankVariant(rows, 'phase3_ml');
  assert.ok(phase2.labeledCount === 6);
  assert.ok((phase3.spreadTopBottom ?? 0) >= 0);

  const report = runRankForwardTest(rows);
  assert.ok(report.variants.length === 5);
  assert.ok(report.winner != null);

  console.log('smartMoneyRankForwardTest.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
