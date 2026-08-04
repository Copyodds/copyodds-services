import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.SMART_MONEY_MAX_TRADES_PER_DAY = process.env.SMART_MONEY_MAX_TRADES_PER_DAY ?? '50';

async function main(): Promise<void> {
  const {
    computeSmartMoneyScoreV40,
    computeActivityFreqFactor,
    computeSignedPnlFactor,
    sumSmartMoneyScoreV40Weights,
    SMART_MONEY_COPYABILITY_MISSING_DEFAULT,
  } = await import('./smartMoneyScoreV40');

  assert.ok(Math.abs(sumSmartMoneyScoreV40Weights() - 1) < 1e-9);

  assert.equal(computeActivityFreqFactor(0), 40);
  assert.ok(computeActivityFreqFactor(7 * 25) > 70); // t=25 → mid of 100→70
  assert.ok(Math.abs(computeActivityFreqFactor(7 * 50) - 70) < 0.01);
  assert.ok(Math.abs(computeActivityFreqFactor(7 * 100) - 40) < 0.01);
  assert.ok(Math.abs(computeActivityFreqFactor(7 * 200) - 10) < 0.01);
  assert.equal(computeActivityFreqFactor(7 * 250), 0);
  assert.equal(computeSignedPnlFactor(null, 1), 50);
  assert.equal(computeSignedPnlFactor(0, 1), 50);
  assert.ok(computeSignedPnlFactor(0.1, 1) > 50);
  assert.ok(computeSignedPnlFactor(-0.1, 1) < 50);
  assert.ok(computeSignedPnlFactor(0.1, 0.5) < computeSignedPnlFactor(0.1, 1));

  const result = computeSmartMoneyScoreV40({
    dataConfidence: 80,
    sampleSize: 40,
    totalReturn: 0.35,
    sharpeRatio: 1.2,
    maxDrawdownPercent: 0.2,
    winRate: 0.55,
    profitFactor: 1.6,
    maxSpikeRatio: 0.15,
    copyabilityScore: 70,
    recentPnl7d: 500,
    recentPnl30d: 1_500,
    recentReturn7d: 0.05,
    recentReturn30d: 0.15,
    recentCoverage7d: 1,
    recentCoverage30d: 1,
    totalPnl1y: 12_000,
    trades7d: 21,
    consistencyScore: 65,
    highReturnMarketShare: 0.35,
    top1MarketPnlShare: 0.3,
    tradesPerDay1D: 5,
    hasHighTradeFrequencyFlag: false,
  });
  assert.ok(result.score >= 40 && result.score <= 95, `score=${result.score}`);
  assert.equal(result.penalties.P_hft, 0);
  assert.equal(result.copyabilityMissing, false);
  assert.ok(result.factors.S_recent_pnl > 0);
  assert.ok(result.factors.S_pnl_30d > 50);
  assert.ok(result.factors.S_total_pnl > 0);
  assert.ok(result.factors.S_activity_freq > 0);

  const missingCopy = computeSmartMoneyScoreV40({
    dataConfidence: 70,
    sampleSize: 30,
    totalReturn: 0.3,
    sharpeRatio: 1,
    maxDrawdownPercent: 0.25,
    winRate: 0.5,
    profitFactor: 1.4,
    maxSpikeRatio: 0.2,
    copyabilityScore: null,
    recentPnl7d: 100,
    totalPnl1y: 5_000,
    trades7d: 14,
    consistencyScore: 55,
    highReturnMarketShare: 0.3,
    top1MarketPnlShare: 0.35,
    tradesPerDay1D: 5,
    hasHighTradeFrequencyFlag: false,
  });
  assert.equal(missingCopy.copyabilityMissing, true);
  assert.equal(missingCopy.factors.S_copyability, SMART_MONEY_COPYABILITY_MISSING_DEFAULT);

  const base = computeSmartMoneyScoreV40({
    dataConfidence: 70,
    sampleSize: 30,
    totalReturn: 0.3,
    sharpeRatio: 1,
    maxDrawdownPercent: 0.25,
    winRate: 0.5,
    profitFactor: 1.4,
    maxSpikeRatio: 0.2,
    copyabilityScore: 60,
    recentPnl7d: 200,
    totalPnl1y: 8_000,
    trades7d: 14,
    consistencyScore: 55,
    highReturnMarketShare: 0.3,
    top1MarketPnlShare: 0.35,
    tradesPerDay1D: 5,
    hasHighTradeFrequencyFlag: false,
  });
  const hft = computeSmartMoneyScoreV40({
    dataConfidence: 70,
    sampleSize: 30,
    totalReturn: 0.3,
    sharpeRatio: 1,
    maxDrawdownPercent: 0.25,
    winRate: 0.5,
    profitFactor: 1.4,
    maxSpikeRatio: 0.2,
    copyabilityScore: 60,
    recentPnl7d: 200,
    totalPnl1y: 8_000,
    trades7d: 14,
    consistencyScore: 55,
    highReturnMarketShare: 0.3,
    top1MarketPnlShare: 0.35,
    tradesPerDay1D: 100,
    hasHighTradeFrequencyFlag: true,
  });
  assert.ok(hft.score < base.score);
  assert.ok(hft.penalties.P_hft >= 15);

  process.env.SMART_MONEY_SCORE_VERSION = 'v4.0';
  process.env.SMART_MONEY_COPYABILITY_ENABLED = 'true';
  const { computeDisplayScore } = await import('./smartMoneyDisplayScore');
  assert.equal(computeDisplayScore(80, 60), 60);

  console.log('smartMoneyScoreV40.test.ts: ok', { score: result.score, hft: hft.score });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
