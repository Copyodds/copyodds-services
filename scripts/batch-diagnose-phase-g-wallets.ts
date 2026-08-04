/**
 * 无 DB：按 Phase G 当前漏斗（Light→Deep L1→硬旗→入榜分）批量诊断地址。
 *
 *   npx tsx scripts/batch-diagnose-phase-g-wallets.ts
 *   npx tsx scripts/batch-diagnose-phase-g-wallets.ts --wallet=0x...
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.SMART_MONEY_SCORE_VERSION = process.env.SMART_MONEY_SCORE_VERSION ?? 'v4.1';

const DEFAULT_WALLETS = [
  // 优质
  '0x9b12e00626d7dd10fdae0121a0d944f3e76e5ee4',
  '0x0787a58e205a70320db638113fe8da18c8800ca3',
  '0x7dddf1968c14900b2d2ef9dada8465e82ac4c933',
  // 中等
  '0x96ac09bb24ebbb771ff98fae83fc97de6fd7dc89',
  '0x5a3b0183ccdc34989fb4c58e853e2a6ef6f1957b',
  '0x5ae3d9d04cd44699e6316ab8053d2d05c007d88a',
  // 刚好
  '0x0a6d26d31b28fd5a84c301f8b27296612f3b1d0a',
  '0x35a093addfdebaa5578696b46b8faa6881952bab',
  '0xb41ead279375742d6c2a1a2239bdce56376411fd',
] as const;

const TIER_LABEL: Record<string, string> = {
  '0x9b12e00626d7dd10fdae0121a0d944f3e76e5ee4': '优质',
  '0x0787a58e205a70320db638113fe8da18c8800ca3': '优质',
  '0x7dddf1968c14900b2d2ef9dada8465e82ac4c933': '优质',
  '0x96ac09bb24ebbb771ff98fae83fc97de6fd7dc89': '中等',
  '0x5a3b0183ccdc34989fb4c58e853e2a6ef6f1957b': '中等',
  '0x5ae3d9d04cd44699e6316ab8053d2d05c007d88a': '中等',
  '0x0a6d26d31b28fd5a84c301f8b27296612f3b1d0a': '刚好',
  '0x35a093addfdebaa5578696b46b8faa6881952bab': '刚好',
  '0xb41ead279375742d6c2a1a2239bdce56376411fd': '刚好',
};

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function walletsFromArgs(): string[] {
  const single = process.argv
    .find((arg) => arg.startsWith('--wallet='))
    ?.slice('--wallet='.length)
    ?.trim()
    .toLowerCase();
  if (single) return [single];
  return [...DEFAULT_WALLETS];
}

async function diagnoseOne(wallet: string) {
  const [
    { CONFIG },
    { getSmartMoneyTierThresholds },
    { fetchPolymarketProfile },
    { fetchDataApiTradesInWindow, normalizeTradeTimestampMs },
    { fetchPositionPnlContext, buildClosedMarketReturnDistribution },
    {
      evaluateTier1L,
      evaluateLightCheapReject,
      evaluateL1CandidateGate,
      hasCopyPoolHardFlag,
      buildCopyPoolHardElimReason,
    },
    { scoreObservedTraderProfile },
    { buildDefaultCopyabilitySimOptions, simulateCopyabilityFromTrades },
  ] = await Promise.all([
    import('../src/config/env.js'),
    import('../src/services/smartMoney/smartMoneyTierThresholds.js'),
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
  const lightCheap = evaluateLightCheapReject(profile);
  const lightPassed = tier1l.passed && lightCheap.passed;

  const start30d = now - 30 * 24 * 60 * 60 * 1000;
  const start7d = now - 7 * 24 * 60 * 60 * 1000;
  const start1d = now - 24 * 60 * 60 * 1000;
  const [{ trades }, positionContext] = await Promise.all([
    fetchDataApiTradesInWindow(wallet, start30d, now),
    fetchPositionPnlContext(wallet),
  ]);

  const countSince = (sinceMs: number) =>
    trades.filter((trade) => {
      const ts = normalizeTradeTimestampMs(trade.timestamp);
      return ts != null && ts >= sinceMs;
    }).length;

  const trades7d = countSince(start7d);
  const trades30d = trades.length;
  const tradesPerDay1D = countSince(start1d);

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
      tradesPerDay1D,
      trades7d,
      trades30d,
      positionPnlStats: positionContext.stats,
      closedMarketReturnDistribution: distribution,
      marketLiquidityProfile: null,
      copyabilityScore: copyability.copyabilityScore,
      tradesSample: trades,
      openPositions: positionContext.openRows,
    }
  );

  const explain = score.scoreExplain as {
    warnings?: unknown;
    resolvedMetrics?: Record<string, unknown>;
    displayProfile?: {
      totalPnl1y?: unknown;
      pnlWindowDays?: unknown;
      pnlWindowMetrics?: { pnl1y?: { returnRatio?: unknown; maxDrawdownRatio?: unknown } };
      recentPnl7d?: unknown;
      recentPnl30d?: unknown;
      winRate?: unknown;
      profitFactor?: unknown;
    };
    closedPositions?: {
      marketWinRate?: number | null;
      decisiveMarkets?: number;
      profitFactor?: number | null;
      profitFactorNoLoss?: boolean;
    };
  };

  const display = explain.displayProfile ?? {};
  const closed = positionContext.stats.closed;
  const totalVolume = score.metrics.totalVolume ?? numberValue(profile.totalVolume);
  const closedWinRate = explain.closedPositions?.marketWinRate ?? closed?.marketWinRate ?? null;
  const closedProfitFactor =
    numberValue(display.profitFactor) ?? closed?.profitFactor ?? null;
  const profitFactorNoLoss =
    explain.closedPositions?.profitFactorNoLoss === true || closed?.profitFactorNoLoss === true;
  const closedMarketCount =
    explain.closedPositions?.decisiveMarkets ?? closed?.decisiveMarkets ?? 0;

  const l1 = evaluateL1CandidateGate({
    profile,
    resolvedTotalPnl: score.totalPnl,
    totalVolume,
    winRate: closedWinRate,
    profitFactor: closedProfitFactor,
    profitFactorNoLoss,
    trades7d,
    trades30d,
    closedMarketCount,
    totalPnl1y: numberValue(display.totalPnl1y),
    pnlWindowDays: numberValue(display.pnlWindowDays),
    totalReturn1y: numberValue(display.pnlWindowMetrics?.pnl1y?.returnRatio),
    maxDrawdown1y: numberValue(display.pnlWindowMetrics?.pnl1y?.maxDrawdownRatio),
  });

  const hardFlag = hasCopyPoolHardFlag(score.riskFlags);
  const enterScore = CONFIG.smartMoneyCopyPoolEnterScore;
  const scoreOk = score.score >= enterScore;
  const canEnter = lightPassed && l1.passed && !hardFlag && scoreOk;

  const thresholds = getSmartMoneyTierThresholds();
  const blockers: string[] = [];
  if (!tier1l.passed) blockers.push(`Light Tier1L: ${tier1l.failReason}`);
  if (!lightCheap.passed) blockers.push(`Light Cheap: ${lightCheap.failReason}`);
  if (!l1.passed) blockers.push(`Deep L1: ${l1.failReason}`);
  if (hardFlag) blockers.push(`HardFlag: ${buildCopyPoolHardElimReason(score.riskFlags)}`);
  if (!scoreOk) blockers.push(`Score ${score.score} < enter ${enterScore}`);

  let pipelineOutcome: string;
  if (!lightPassed) pipelineOutcome = 'ELIMINATED@Light';
  else if (!l1.passed) pipelineOutcome = 'ELIMINATED@L1';
  else if (hardFlag) pipelineOutcome = 'ELIMINATED@COPY_HARD';
  else if (!scoreOk) pipelineOutcome = 'SCORED(未入榜)';
  else pipelineOutcome = 'COPY_POOL';

  return {
    wallet,
    label: TIER_LABEL[wallet] ?? '自定义',
    pipelineOutcome,
    canEnterCopyPool: canEnter,
    blockers,
    light: { tier1l, lightCheap, lightPassed },
    l1,
    hardFlag,
    hardElimReason: hardFlag ? buildCopyPoolHardElimReason(score.riskFlags) : null,
    score: score.score,
    enterScore,
    riskFlags: score.riskFlags,
    profile: {
      holdingsValue: numberValue(profile.holdingsValue),
      predictionCount: profile.predictionCount,
      totalVolume: numberValue(profile.totalVolume),
      totalPnl: numberValue(profile.totalPnl),
      curvePoints: profile.curves.length,
      joinDate: profile.joinedAtText ?? null,
    },
    activity: { trades7d, trades30d, tradesPerDay1D },
    closed: {
      decisiveMarkets: closedMarketCount,
      winRate: closedWinRate,
      profitFactor: closedProfitFactor,
      profitFactorNoLoss,
    },
    windows: {
      recentPnl7d: numberValue(display.recentPnl7d),
      recentPnl30d: numberValue(display.recentPnl30d),
      totalPnl1y: numberValue(display.totalPnl1y),
      pnlWindowDays: numberValue(display.pnlWindowDays),
      totalReturn1y: numberValue(display.pnlWindowMetrics?.pnl1y?.returnRatio),
      maxDrawdown1y: numberValue(display.pnlWindowMetrics?.pnl1y?.maxDrawdownRatio),
    },
    copyabilityScore: copyability.copyabilityScore,
    resolvedTotalPnl: score.totalPnl,
    thresholds: {
      enterScore,
      scorePoolMinPnl1y: thresholds.scorePoolMinPnl1y,
      tier2MinTotalReturn: thresholds.tier2MinTotalReturn,
      scorePoolMinWinRate: thresholds.scorePoolMinWinRate,
      scorePoolMinProfitFactor: thresholds.scorePoolMinProfitFactor,
      scorePoolMinClosedMarkets: thresholds.scorePoolMinClosedMarkets,
      scorePoolMinTrades30d: thresholds.scorePoolMinTrades30d,
      scorePoolMinLifetimeVolume: thresholds.scorePoolMinLifetimeVolume,
      maxTradesPerDay: CONFIG.smartMoneyMaxTradesPerDay,
      minAvgTradeNotionalUsd: CONFIG.smartMoneyMinAvgTradeNotionalUsd,
    },
    warnings: explain.warnings ?? null,
    resolvedMetrics: explain.resolvedMetrics ?? null,
  };
}

async function main(): Promise<void> {
  const wallets = walletsFromArgs();
  const results = [];
  for (let i = 0; i < wallets.length; i += 1) {
    const wallet = wallets[i]!;
    process.stderr.write(`[${i + 1}/${wallets.length}] ${wallet}...\n`);
    try {
      const row = await diagnoseOne(wallet);
      results.push(row);
      process.stderr.write(
        `  -> ${row.pipelineOutcome} score=${row.score} canEnter=${row.canEnterCopyPool}\n`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        wallet,
        label: TIER_LABEL[wallet] ?? '自定义',
        pipelineOutcome: 'ERROR',
        canEnterCopyPool: false,
        blockers: [message],
        error: message,
      });
      process.stderr.write(`  -> ERROR ${message}\n`);
    }
    if (i < wallets.length - 1) await sleep(800);
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
}

main().catch((error) => {
  console.error('[batch-diagnose-phase-g-wallets] failed', error);
  process.exitCode = 1;
});
