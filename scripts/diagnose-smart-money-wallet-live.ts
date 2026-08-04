/**
 * 无 DB 单地址实时诊断：Profile → Tier1L → 30d trades/positions → v4.1 → L1 → CopyPool。
 *
 * Usage:
 *   npx tsx scripts/diagnose-smart-money-wallet-live.ts --wallet=0x...
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.SMART_MONEY_SCORE_VERSION = process.env.SMART_MONEY_SCORE_VERSION ?? 'v4.1';

function walletArg(): string {
  const raw = process.argv.find((arg) => arg.startsWith('--wallet='))?.slice('--wallet='.length);
  const wallet = raw?.trim().toLowerCase() ?? '';
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error('valid --wallet=0x... is required');
  return wallet;
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main(): Promise<void> {
  const wallet = walletArg();
  const [
    { CONFIG },
    { fetchPolymarketProfile },
    { fetchDataApiTradesInWindow },
    { fetchPositionPnlContext, buildClosedMarketReturnDistribution },
    { evaluateTier1L, evaluateL1CandidateGate, hasCopyPoolHardFlag },
    { scoreObservedTraderProfile },
    { buildDefaultCopyabilitySimOptions, simulateCopyabilityFromTrades },
  ] = await Promise.all([
    import('../src/config/env.js'),
    import('../src/services/polymarket/polymarketProfile.js'),
    import('../src/services/polymarket/polymarketTrades.js'),
    import('../src/services/smartMoney/smartMoneyPositionStats.js'),
    import('../src/services/smartMoney/smartMoneyTierGate.js'),
    import('../src/services/smartMoney/smartMoneyScorer.js'),
    import('../src/services/smartMoney/smartMoneyCopyabilitySim.js'),
  ]);

  const now = Date.now();
  const profile = await fetchPolymarketProfile(wallet, { pnlPeriods: ['1W', 'ALL'] });
  const tier1l = evaluateTier1L(profile);
  const start30d = now - 30 * 24 * 60 * 60 * 1000;
  const start7d = now - 7 * 24 * 60 * 60 * 1000;
  const [{ trades }, positionContext] = await Promise.all([
    fetchDataApiTradesInWindow(wallet, start30d, now),
    fetchPositionPnlContext(wallet),
  ]);
  const trades7d = trades.filter((trade: { timestamp?: unknown }) => {
    const raw = (trade as { timestamp?: unknown }).timestamp;
    const numeric = Number(raw);
    const timestampMs =
      Number.isFinite(numeric) && numeric > 0
        ? numeric < 10_000_000_000
          ? numeric * 1000
          : numeric
        : typeof raw === 'string'
          ? Date.parse(raw)
          : NaN;
    return Number.isFinite(timestampMs) && timestampMs >= start7d;
  }).length;
  const distribution = buildClosedMarketReturnDistribution(positionContext.closedRows);
  const copyability = simulateCopyabilityFromTrades(
    trades,
    buildDefaultCopyabilitySimOptions(),
    now
  );
  const observed = {
    wallet,
    sourceRankWeek: null,
    sourceRankMonth: null,
    sourceRankAll: null,
    officialSourceRankWeek: null,
    officialSourceRankMonth: null,
    officialSourceRankAll: null,
    externalSourceRankWeek: null,
    externalSourceRankMonth: null,
    externalSourceRankAll: null,
    candidatePeriods: [],
    candidateCategories: ['OVERALL'],
    blacklisted: false,
    noiseTags: [],
  };
  const score = scoreObservedTraderProfile(
    profile,
    observed,
    { '7D': null, '30D': null, ALL: null },
    {
      trades7d,
      trades30d: trades.length,
      positionPnlStats: positionContext.stats,
      closedMarketReturnDistribution: distribution,
      marketLiquidityProfile: null,
      copyabilityScore: copyability.copyabilityScore,
    }
  );
  const explain = score.scoreExplain as {
    warnings?: unknown;
    resolvedMetrics?: unknown;
    rawMetrics?: unknown;
    displayProfile?: {
      totalPnl1y?: unknown;
      pnlWindowDays?: unknown;
      pnlWindowMetrics?: { pnl1y?: { returnRatio?: unknown; maxDrawdownRatio?: unknown } };
      recentPnl7d?: unknown;
      recentPnl30d?: unknown;
    };
  };
  const display = explain.displayProfile ?? {};
  const closed = positionContext.stats.closed;
  const totalVolume = score.metrics.totalVolume ?? numberValue(profile.totalVolume);
  const l1 = evaluateL1CandidateGate({
    profile,
    resolvedTotalPnl: score.totalPnl,
    totalVolume,
    winRate: closed?.marketWinRate ?? null,
    profitFactor: closed?.profitFactor ?? null,
    profitFactorNoLoss: closed?.profitFactorNoLoss ?? false,
    trades7d,
    trades30d: trades.length,
    closedMarketCount: closed?.decisiveMarkets ?? 0,
    totalPnl1y: numberValue(display.totalPnl1y),
    pnlWindowDays: numberValue(display.pnlWindowDays),
    totalReturn1y: numberValue(display.pnlWindowMetrics?.pnl1y?.returnRatio),
    maxDrawdown1y: numberValue(display.pnlWindowMetrics?.pnl1y?.maxDrawdownRatio),
  });
  const hardFlag = hasCopyPoolHardFlag(score.riskFlags);
  const canEnter =
    tier1l.passed &&
    l1.passed &&
    !hardFlag &&
    score.score >= CONFIG.smartMoneyCopyPoolEnterScore;

  console.log(
    JSON.stringify(
      {
        wallet,
        profile: {
          holdingsValue: profile.holdingsValue,
          predictionCount: profile.predictionCount,
          totalVolume: profile.totalVolume,
          totalPnl: profile.totalPnl,
          curvePoints: profile.curves.length,
        },
        activity: { trades7d, trades30d: trades.length },
        closed: {
          decisiveMarkets: closed?.decisiveMarkets ?? 0,
          winRate: closed?.marketWinRate ?? null,
          profitFactor: closed?.profitFactor ?? null,
          profitFactorNoLoss: closed?.profitFactorNoLoss ?? false,
        },
        windows: {
          recentPnl7d: numberValue(display.recentPnl7d),
          recentPnl30d: numberValue(display.recentPnl30d),
          totalPnl1y: numberValue(display.totalPnl1y),
          pnlWindowDays: numberValue(display.pnlWindowDays),
          totalReturn1y: numberValue(display.pnlWindowMetrics?.pnl1y?.returnRatio),
          maxDrawdown1y: numberValue(display.pnlWindowMetrics?.pnl1y?.maxDrawdownRatio),
        },
        score: score.score,
        resolvedTotalPnl: score.totalPnl,
        warnings: explain.warnings ?? null,
        resolvedMetrics: explain.resolvedMetrics ?? null,
        rawMetrics: explain.rawMetrics ?? null,
        riskFlags: score.riskFlags,
        tier1l,
        l1,
        copyabilityScore: copyability.copyabilityScore,
        hardFlag,
        enterScore: CONFIG.smartMoneyCopyPoolEnterScore,
        canEnterCopyPool: canEnter,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[diagnose-smart-money-wallet-live] failed', error);
  process.exitCode = 1;
});
