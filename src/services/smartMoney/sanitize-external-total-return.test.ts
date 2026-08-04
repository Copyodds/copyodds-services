process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import assert from 'node:assert/strict';

async function main() {
  const { scoreObservedTraderProfile } = await import('./smartMoneyScorer');
  type PredictingTopWalletMetric =
    import('../polymarket/predictingTopLeaderboard').PredictingTopWalletMetric;

  const observedTrader = {
    wallet: '0x0000000000000000000000000000000000000002',
    sourceRankWeek: 10,
    sourceRankMonth: 10,
    sourceRankAll: 10,
    officialSourceRankWeek: 10,
    officialSourceRankMonth: 10,
    officialSourceRankAll: 10,
    externalSourceRankWeek: 10,
    externalSourceRankMonth: 10,
    externalSourceRankAll: 10,
    candidatePeriods: ['7D', '30D', 'ALL'],
    candidateCategories: ['OVERALL'],
    blacklisted: false,
    noiseTags: [] as string[],
  };

  const metric: PredictingTopWalletMetric = {
    period: 'ALL',
    rank: 80,
    smartScore: 53.8,
    sharpeRatio: 1.37,
    sortinoRatio: 2.33,
    winRate: 0.57,
    profitFactor: 2.08,
    totalReturn: 409_504,
    maxDrawdownPercent: 1,
    currentDrawdown: 0.289,
    rSquared: 0.4,
    calculatedAt: new Date(),
    tier: 'Average',
  };

  const result = scoreObservedTraderProfile(
    {
      wallet: observedTrader.wallet,
      profileSlug: null,
      displayName: 't',
      username: null,
      xUsername: null,
      profileImage: null,
      joinedAtText: null,
      viewsText: null,
      holdingsValue: '310220',
      biggestWin: null,
      predictionCount: 3619,
      totalPnl: '410339',
      totalVolume: '25477017',
      sourceUrl: 'https://x',
      snapshotAt: new Date(),
      profilePnlApiFilledPeriods: [],
      rawSummary: {},
      curves: Array.from({ length: 40 }, (_, i) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 0, i + 1)),
        value: String(100_000 + i * 5000),
      })),
    },
    observedTrader,
    { '7D': null, '30D': null, ALL: metric }
  );

  const explain = result.scoreExplain as {
    warnings?: string[];
    rawMetrics?: { externalTotalReturnRaw?: number | null; externalTotalReturn?: number | null };
  };

  assert.ok((explain.warnings ?? []).includes('absurd_external_return'));
  assert.equal(explain.rawMetrics?.externalTotalReturnRaw, 409_504);
  assert.notEqual(result.externalTotalReturn, 409_504);
  // 无已平仓窗口回报时总盈利率为 null（禁止 holdings/volume 回退）
  assert.equal(result.externalTotalReturn, null);
  console.log('sanitize-external-total-return.test: ok', {
    display: result.externalTotalReturn,
    cleaned: explain.rawMetrics?.externalTotalReturn,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
