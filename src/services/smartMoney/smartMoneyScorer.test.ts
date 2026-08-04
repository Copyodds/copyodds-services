import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main() {
  const {
    computeCurveReturnRatio,
    computeDisplayCurveReturnRatio,
    computeDrawdownStats,
    computeLocalSharpeLikeAll1y,
    computeSharpeLikeRatio,
    getNormalizedStepReturns,
    scoreObservedTraderProfile,
  } = await import('./smartMoneyScorer');
  const { buildPositionPnlStats, EMPTY_OPEN_POSITION_STATS } = await import('./smartMoneyPositionStats');
  type ClosedMarketReturnDistribution = import('./smartMoneyPositionStats').ClosedMarketReturnDistribution;
  type SmartMoneyMarketLiquidityProfile = import('./smartMoneyMarketLiquidity').SmartMoneyMarketLiquidityProfile;

  function buildEligibleClosedDistribution(
    marketCount = 10,
    highReturnRatio = 0.6
  ): ClosedMarketReturnDistribution {
    const highCount = Math.max(1, Math.round(marketCount * highReturnRatio));
    const plus5To10 = Math.max(1, Math.floor(highCount * 0.3));
    const ge10 = Math.max(highCount - plus5To10, 1);
    const lowCount = Math.max(0, marketCount - plus5To10 - ge10);
    const plus1To2 = Math.min(lowCount, 2);
    const zeroTo1 = lowCount - plus1To2;
    const ratio = (count: number) => (marketCount > 0 ? Math.round((count / marketCount) * 10000) / 10000 : 0);
    return {
      sampledMarketCount: marketCount,
      meanReturn: 0.4,
      medianReturn: 0.35,
      totalReturnRatio: 0.4,
      totalRealizedPnl: 12_000,
      totalCostBasisUsd: 100_000,
      buckets: [
        { id: 'leMinus5', label: '<= -5%', count: 0, ratio: 0 },
        { id: 'minus5ToMinus2', label: '-5% to -2%', count: 0, ratio: 0 },
        { id: 'minus2ToMinus1', label: '-2% to -1%', count: 0, ratio: 0 },
        { id: 'minus1ToZero', label: '-1% to 0%', count: 0, ratio: 0 },
        { id: 'zeroToPlus1', label: '0% to +1%', count: zeroTo1, ratio: ratio(zeroTo1) },
        { id: 'plus1ToPlus2', label: '+1% to +2%', count: plus1To2, ratio: ratio(plus1To2) },
        { id: 'plus2ToPlus5', label: '+2% to +5%', count: 0, ratio: 0 },
        { id: 'plus5ToPlus10', label: '+5% to +10%', count: plus5To10, ratio: ratio(plus5To10) },
        { id: 'gePlus10', label: '>= +10%', count: ge10, ratio: ratio(ge10) },
      ],
    };
  }

  function buildLowHighReturnDistribution(marketCount = 10): ClosedMarketReturnDistribution {
    return {
      sampledMarketCount: marketCount,
      meanReturn: 0.01,
      medianReturn: 0.01,
      totalReturnRatio: 0.01,
      totalRealizedPnl: 1_000,
      totalCostBasisUsd: 100_000,
      buckets: [
        { id: 'leMinus5', label: '<= -5%', count: 0, ratio: 0 },
        { id: 'minus5ToMinus2', label: '-5% to -2%', count: 0, ratio: 0 },
        { id: 'minus2ToMinus1', label: '-2% to -1%', count: 0, ratio: 0 },
        { id: 'minus1ToZero', label: '-1% to 0%', count: 0, ratio: 0 },
        { id: 'zeroToPlus1', label: '0% to +1%', count: 6, ratio: 0.6 },
        { id: 'plus1ToPlus2', label: '+1% to +2%', count: 4, ratio: 0.4 },
        { id: 'plus2ToPlus5', label: '+2% to +5%', count: 0, ratio: 0 },
        { id: 'plus5ToPlus10', label: '+5% to +10%', count: 0, ratio: 0 },
        { id: 'gePlus10', label: '>= +10%', count: 0, ratio: 0 },
      ],
    };
  }

  function buildEligibleLiquidityProfile(): SmartMoneyMarketLiquidityProfile {
    return {
      minMarketVolumeUsd: 100_000,
      highVolumeMarketShare: 0.8,
      lowVolumeMarketShare: 0.2,
      classifiedPositionCount: 10,
      totalPositionCount: 10,
      classificationShare: 1,
      highVolumePositionCount: 8,
      lowVolumePositionCount: 2,
      uniqueTokenCount: 10,
      sampledTokenCount: 10,
      usedTokenLookupCap: false,
    };
  }

  const eligibleV23Options = {
    closedMarketReturnDistribution: buildEligibleClosedDistribution(),
    marketLiquidityProfile: buildEligibleLiquidityProfile(),
  };

  assert.equal(
    computeCurveReturnRatio([0, 100, 8_871_024.81]),
    null,
    'cumulative P&L from zero has no meaningful percent-return denominator'
  );

  assert.equal(
    computeCurveReturnRatio([-100, 100]),
    null,
    'cumulative P&L from a negative baseline has no meaningful percent-return denominator'
  );

  assert.equal(computeCurveReturnRatio([100, 150]), 0.5);

  assert.equal(
    computeDisplayCurveReturnRatio([74, 40582]),
    null,
    'tiny cumulative P&L baseline should not produce a display percent return'
  );
  assert.equal(computeDisplayCurveReturnRatio([1000, 1500]), 0.5);

  assert.deepEqual(
    computeDrawdownStats([0, -100, -50]),
    { maxDrawdownPercent: null, currentDrawdown: null },
    'no reliable peak (>=$100) should not invent drawdown'
  );

  assert.deepEqual(computeDrawdownStats([0, -100, 200, 150]), {
    maxDrawdownPercent: 0.25,
    currentDrawdown: 0.25,
  });

  assert.equal(
    computeDrawdownStats([0.97, 0, 100_000, 90_000]).maxDrawdownPercent,
    0.1,
    'tiny early peak must not become 100% drawdown'
  );

  assert.deepEqual(
    getNormalizedStepReturns([0, 100, 150]),
    [0.5],
    'step returns skip zero/negative baselines instead of manufacturing 100% moves'
  );

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
    candidateCategories: ['OVERALL', 'CRYPTO'],
    blacklisted: false,
    noiseTags: [],
  };
  const baseProfile = {
    wallet: observedTrader.wallet,
    profileSlug: null,
    displayName: 'Test trader',
    username: null,
    xUsername: null,
    profileImage: null,
    joinedAtText: null,
    viewsText: null,
    holdingsValue: '2500',
    biggestWin: null,
    predictionCount: 100,
    totalPnl: '100',
    totalVolume: '5000',
    sourceUrl: 'https://polymarket.com/profile/test',
    snapshotAt: new Date('2026-01-01T00:00:00.000Z'),
    profilePnlApiFilledPeriods: [],
    rawSummary: {},
  };
  type PredictingTopPeriod = import('../polymarket/predictingTopLeaderboard').PredictingTopPeriod;
  type PredictingTopWalletMetric = import('../polymarket/predictingTopLeaderboard').PredictingTopWalletMetric;
  const allExternalMetric: PredictingTopWalletMetric = {
    period: 'ALL',
    rank: 10,
    smartScore: 80,
    sharpeRatio: 1.5,
    sortinoRatio: 2,
    winRate: 0.62,
    profitFactor: 1.8,
    totalReturn: 0.35,
    maxDrawdownPercent: 0.08,
    currentDrawdown: 0.02,
    rSquared: 0.85,
    calculatedAt: new Date('2026-01-01T00:00:00.000Z'),
    tier: 'Great',
  };
  const externalMetrics: Record<PredictingTopPeriod, PredictingTopWalletMetric | null> = {
    '7D': null,
    '30D': null,
    ALL: allExternalMetric,
  };

  {
    const now = Date.UTC(2026, 6, 1);
    const day = 24 * 60 * 60 * 1000;
    // 400 天：前段缓升，近窗陡升——ALL×1Y 截窗应与全 ALL 不同，且忽略第三方夏普
    const curves = Array.from({ length: 400 }, (_, index) => {
      const age = 399 - index;
      const value = age >= 365 ? 1000 + index : 1000 + 365 + (index - 35) * 20;
      return {
        curveType: 'PORTFOLIO_PNL_ALL' as const,
        period: 'ALL' as const,
        ts: new Date(now - age * day),
        value: String(value),
      };
    });
    const profile = {
      ...baseProfile,
      snapshotAt: new Date(now),
      curves,
    };
    const allValues = curves.map((c) => Number(c.value));
    const sharpeAll = computeSharpeLikeRatio(allValues);
    const sharpe1y = computeLocalSharpeLikeAll1y(profile, now);
    assert.ok(sharpe1y != null, 'ALL×1Y sharpe should compute');
    assert.notEqual(
      sharpe1y,
      sharpeAll,
      '1Y window should differ from full ALL when early path differs'
    );

    const scored = scoreObservedTraderProfile(
      profile,
      observedTrader,
      {
        '7D': null,
        '30D': null,
        ALL: { ...allExternalMetric, sharpeRatio: 9.99 },
      },
      eligibleV23Options
    );
    assert.equal(
      scored.externalSharpeRatio,
      sharpe1y == null ? null : Math.round(sharpe1y * 10000) / 10000,
      'leaderboard sharpe must be local ALL×1Y, ignoring predicting.top'
    );
    const explain = scored.scoreExplain as {
      displayProfile?: { metricsSource?: { sharpe?: string } };
    };
    assert.equal(explain.displayProfile?.metricsSource?.sharpe, 'PORTFOLIO_PNL_ALL_1Y');
  }

  const steadyScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      curves: Array.from({ length: 25 }, (_, index) => 100 + index * (100 / 24)).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 0, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    externalMetrics,
    eligibleV23Options
  );

  const steadyExplain = steadyScore.scoreExplain as {
    components?: { dataConfidence?: unknown; profit?: unknown };
    warnings?: unknown;
    resolvedMetrics?: { totalPnl?: unknown; totalPnlSource?: unknown };
  };
  assert.equal(steadyScore.eligible, true);
  assert.equal(steadyExplain.resolvedMetrics?.totalPnl, 100);
  assert.equal(steadyExplain.resolvedMetrics?.totalPnlSource, 'curve');
  assert.equal(Array.isArray(steadyExplain.warnings), true);
  assert.equal((steadyExplain.warnings as string[]).includes('pnl_mismatch_major'), false);
  assert.equal(typeof steadyExplain.components?.dataConfidence, 'number');
  assert.ok((steadyExplain.components?.dataConfidence as number) >= 80);

  const lowAvgReturnScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      curves: Array.from({ length: 25 }, (_, index) => 100 + index * (100 / 24)).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 0, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    externalMetrics,
    {
      ...eligibleV23Options,
      closedMarketReturnDistribution: {
        ...buildEligibleClosedDistribution(),
        meanReturn: 0.2,
        medianReturn: 0.18,
        totalReturnRatio: 0.2,
      },
    }
  );
  assert.equal(lowAvgReturnScore.riskFlags.includes('LOW_AVG_CLOSED_RETURN_RATE'), true);
  assert.equal(lowAvgReturnScore.eligible, false);

  const shortAndAllScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      curves: [
        ...Array.from({ length: 25 }, (_, index) => ({
          curveType: 'PORTFOLIO_PNL_ALL' as const,
          period: 'ALL' as const,
          ts: new Date(Date.UTC(2026, 0, index + 1)),
          value: String(100 + index * (100 / 24)),
        })),
        ...Array.from({ length: 7 }, (_, index) => ({
          curveType: 'PORTFOLIO_PNL_1W' as const,
          period: '1W' as const,
          ts: new Date(Date.UTC(2026, 0, 19 + index)),
          value: String(1_000 + index * 500),
        })),
      ],
    },
    observedTrader,
    externalMetrics,
    eligibleV23Options
  );
  const shortAndAllWarnings =
    (shortAndAllScore.scoreExplain as { warnings?: string[] }).warnings ?? [];
  assert.equal(shortAndAllWarnings.includes('pnl_mismatch_major'), false);
  assert.equal(shortAndAllScore.riskFlags.includes('DATA_MISMATCH'), false);

  const mismatchedScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      totalPnl: '10000',
      curves: Array.from({ length: 25 }, (_, index) => 100 + index * (30 / 24)).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 1, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    externalMetrics,
    eligibleV23Options
  );
  assert.equal(mismatchedScore.riskFlags.includes('DATA_MISMATCH'), true);
  // DATA_MISMATCH 仅软惩罚，不再单独把 eligible 打成 false
  assert.equal(mismatchedScore.eligible, true);
  assert.equal(
    ((mismatchedScore.scoreExplain as { warnings?: string[] }).warnings ?? []).includes('pnl_mismatch_major'),
    true
  );

  const riskyHighWinRateScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      curves: [100, 104, 108, 112, 116, 120, 70, 72, 74, 76, 78, 130].map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 2, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    {
      ...externalMetrics,
      ALL: {
        ...allExternalMetric,
        winRate: 0.9,
        profitFactor: 0.8,
        maxDrawdownPercent: 0.5,
        currentDrawdown: 0.3,
      },
    },
    eligibleV23Options
  );
  assert.equal(riskyHighWinRateScore.riskFlags.includes('HIGH_WIN_RATE_TAIL_RISK'), true);
  assert.equal(riskyHighWinRateScore.riskFlags.includes('LOW_PROFIT_FACTOR'), true);
  assert.equal(riskyHighWinRateScore.riskFlags.includes('EXCESSIVE_DRAWDOWN'), true);
  // 短曲线触发 INSUFFICIENT_CURVE_DATA，v2.2 硬门槛下不可新进
  assert.equal(riskyHighWinRateScore.riskFlags.includes('INSUFFICIENT_CURVE_DATA'), true);
  assert.equal(riskyHighWinRateScore.eligible, false);

  const highFrequencyScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      curves: Array.from({ length: 25 }, (_, index) => 100 + index * (100 / 24)).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 0, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    externalMetrics,
    { ...eligibleV23Options, tradesPerDay1D: 600 }
  );
  // 24h 尖峰仅软旗，不硬淘、不进 HIGH_TRADE_FREQUENCY
  assert.equal(highFrequencyScore.riskFlags.includes('HIGH_TRADE_FREQUENCY'), false);
  assert.equal(highFrequencyScore.riskFlags.includes('ELEVATED_TRADE_FREQUENCY'), true);
  assert.equal(highFrequencyScore.eligible, true);

  const whaleScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      holdingsValue: '7332000',
      curves: Array.from({ length: 25 }, (_, index) => 100 + index * (100 / 24)).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 0, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    externalMetrics,
    eligibleV23Options
  );
  assert.equal(whaleScore.eligible, true);
  assert.equal(whaleScore.riskFlags.includes('HIGH_HOLDINGS'), false);

  const lotteryCurve = Array.from({ length: 120 }, (_, index) => {
    if (index === 0) return 50;
    if (index === 60) return 40_000;
    return 40_000 - (index - 60) * 120;
  });
  const lotteryScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      totalPnl: '40000',
      totalVolume: '120000',
      predictionCount: 800,
      curves: lotteryCurve.map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 3, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    { '7D': null, '30D': null, ALL: null },
    {
      ...eligibleV23Options,
      closedMarketReturnDistribution: buildLowHighReturnDistribution(45),
      positionPnlStats: buildPositionPnlStats(
        {
          sampleSize: 120,
          marketCount: 45,
          decisiveMarkets: 45,
          winningMarkets: 10,
          losingMarkets: 35,
          marketWinRate: 0.22,
          topMarketPnlShare: 0.72,
          totalRealizedPnl: 38_000,
          profitFactor: 1.2,
          profitFactorNoLoss: false,
        },
        EMPTY_OPEN_POSITION_STATS
      ),
    }
  );
  assert.equal(lotteryScore.riskFlags.includes('LOW_WIN_RATE_CONCENTRATED'), true);
  assert.equal(lotteryScore.riskFlags.includes('SINGLE_HIT_DEPENDENCY'), true);
  assert.equal(lotteryScore.riskFlags.includes('LOW_HIGH_RETURN_MARKET_SHARE'), true);
  assert.equal(lotteryScore.riskFlags.includes('LOW_AVG_CLOSED_RETURN_RATE'), true);
  assert.equal(lotteryScore.eligible, false);
  assert.ok(Math.abs((lotteryScore.externalWinRate ?? 0) - 0.22) < 0.01);
  // 主胜率已统一为已平仓；不再用「总 score 必低于 steady」作脆断言（steady 无 closed 样本时分位会变）
  assert.ok(
    (lotteryScore.traderScore ?? 100) <= 70,
    'low closed win-rate lottery profile should not get a high TraderScore'
  );
  // holdings 过小相对暴击 PnL 时资本 ROI 置空，禁止曲线伪回报数百%
  assert.ok(
    lotteryScore.externalTotalReturn == null || lotteryScore.externalTotalReturn < 100,
    `expected null or modest capital ROI, got ${lotteryScore.externalTotalReturn}`
  );

  const realizedOpenGapStats = buildPositionPnlStats(
    {
      sampleSize: 31,
      marketCount: 31,
      decisiveMarkets: 31,
      winningMarkets: 29,
      losingMarkets: 2,
      marketWinRate: 29 / 31,
      topMarketPnlShare: 0.15,
      totalRealizedPnl: 12_000,
      profitFactor: 2,
      profitFactorNoLoss: false,
    },
    {
      sampleSize: 55,
      marketCount: 55,
      decisiveMarkets: 50,
      winningMarkets: 6,
      marketWinRate: 6 / 50,
      underwaterMarketShare: 44 / 50,
      totalUnrealizedPnl: -800,
      totalCostBasis: null,
    }
  );
  assert.ok(
    (realizedOpenGapStats.compositeMarketWinRate ?? 0) < 0.5,
    'composite win rate should blend underwater open exposure'
  );
  const gapScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      predictionCount: 86,
      holdingsValue: '8459',
      totalPnl: '580',
      curves: Array.from({ length: 30 }, (_, index) => 1000 + index * 20).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 4, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    { '7D': null, '30D': null, ALL: null },
    { ...eligibleV23Options, positionPnlStats: realizedOpenGapStats }
  );
  assert.equal(gapScore.riskFlags.includes('OPEN_EXPOSURE_UNDERWATER'), true);
  assert.equal(gapScore.riskFlags.includes('REALIZED_OPEN_WIN_RATE_GAP'), true);
  assert.equal(gapScore.eligible, false);
  // 展示 = 评分：已平仓 MARKET_CLOSED（365 天窗）
  const gapClosed = realizedOpenGapStats.closed!.marketWinRate!;
  assert.ok(Math.abs((gapScore.externalWinRate ?? 0) - gapClosed) < 0.01);
  assert.equal(gapScore.winRateSource, 'MARKET_CLOSED');
  const gapExplain = gapScore.scoreExplain as {
    winRateMeta?: { scoreWinRate?: number | null; scoreWinRateSource?: string | null };
  };
  assert.ok(Math.abs((gapExplain.winRateMeta?.scoreWinRate ?? 0) - gapClosed) < 0.01);
  assert.equal(gapExplain.winRateMeta?.scoreWinRateSource, 'MARKET_CLOSED');
  const gapCard = (gapExplain as { traderProfile?: { card?: { reasons?: string[] } } }).traderProfile
    ?.card;
  assert.ok(
    !(gapCard?.reasons ?? []).some((r) => r.includes('胜率')),
    'entry reasons must not mention win rate'
  );

  const harrvestLikeStats = buildPositionPnlStats(
    {
      sampleSize: 50,
      marketCount: 50,
      decisiveMarkets: 50,
      winningMarkets: 50,
      losingMarkets: 0,
      marketWinRate: 1,
      topMarketPnlShare: 0.6,
      totalRealizedPnl: 40_000,
      profitFactor: null,
      profitFactorNoLoss: true,
    },
    {
      sampleSize: 14,
      marketCount: 14,
      decisiveMarkets: 12,
      winningMarkets: 4,
      marketWinRate: 4 / 12,
      underwaterMarketShare: 8 / 12,
      totalUnrealizedPnl: -500,
      totalCostBasis: null,
    }
  );
  assert.ok(
    (harrvestLikeStats.compositeMarketWinRate ?? 1) < 0.95,
    'closed-only winners plus underwater open book must not show as ~100% win rate'
  );

  const negativePnlScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      totalPnl: '-2295.9',
      totalVolume: '12000',
      curves: Array.from({ length: 25 }, (_, index) => -100 - index * 80).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 0, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    externalMetrics,
    {
      ...eligibleV23Options,
      positionPnlStats: buildPositionPnlStats(
        {
          sampleSize: 8,
          marketCount: 8,
          decisiveMarkets: 8,
          winningMarkets: 8,
          losingMarkets: 0,
          marketWinRate: 1,
          topMarketPnlShare: 0.2,
          totalRealizedPnl: 500,
          profitFactor: null,
          profitFactorNoLoss: true,
        },
        {
          sampleSize: 0,
          marketCount: 0,
          decisiveMarkets: 0,
          winningMarkets: 0,
          marketWinRate: null,
          underwaterMarketShare: null,
          totalUnrealizedPnl: null,
          totalCostBasis: null,
        }
      ),
    }
  );
  assert.equal(negativePnlScore.eligible, false);
  assert.equal(negativePnlScore.riskFlags.includes('NEGATIVE_TOTAL_PNL'), true);
  // open 为空仓时退回已平仓；总 PnL 为负另由风险旗表达
  assert.ok(Math.abs((negativePnlScore.externalWinRate ?? 0) - 1) < 0.01);
  assert.equal(negativePnlScore.winRateSource, 'MARKET_CLOSED');

  const missingDataScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      curves: Array.from({ length: 25 }, (_, index) => 100 + index * (100 / 24)).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 0, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    externalMetrics
  );
  assert.equal(missingDataScore.eligible, false);
  assert.equal(missingDataScore.riskFlags.includes('CLOSED_RETURN_DATA_MISSING'), true);
  assert.equal(missingDataScore.riskFlags.includes('LIQUIDITY_DATA_INCOMPLETE'), true);
  assert.equal(missingDataScore.riskFlags.includes('LOW_HIGH_RETURN_MARKET_SHARE'), false);
  assert.equal(missingDataScore.riskFlags.includes('LOW_AVG_CLOSED_RETURN_RATE'), false);
  assert.equal(missingDataScore.riskFlags.includes('LOW_VOLUME_MARKET_EXPOSURE'), false);

  const hedgedPairRows = [
    {
      asset: 'yes',
      conditionId: 'cond-hedge',
      size: 100_000,
      avgPrice: 0.5,
      currentValue: 50_000,
      outcome: 'Yes',
      outcomeIndex: 0,
      redeemable: false,
    },
    {
      asset: 'no',
      conditionId: 'cond-hedge',
      size: 100_000,
      avgPrice: 0.5,
      currentValue: 50_000,
      outcome: 'No',
      outcomeIndex: 1,
      redeemable: false,
    },
  ];
  const hedgedScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      curves: Array.from({ length: 25 }, (_, index) => 100 + index * (100 / 24)).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 0, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    externalMetrics,
    {
      ...eligibleV23Options,
      positionPnlStats: buildPositionPnlStats(null, EMPTY_OPEN_POSITION_STATS, hedgedPairRows),
    }
  );
  assert.equal(hedgedScore.riskFlags.includes('HEDGED_PAIR_EXPOSURE'), true);
  assert.equal(hedgedScore.eligible, false);
  assert.ok(
    (hedgedScore.scoreExplain as { hedgedPairExposure?: { hedgedPairShare?: number } }).hedgedPairExposure
      ?.hedgedPairShare != null
  );

  // predicting.top 偶发把美元 PnL 写进 totalReturn；展示列应回退本地代理而非写出天文数字
  const absurdExternalMetrics: Record<PredictingTopPeriod, PredictingTopWalletMetric | null> = {
    '7D': null,
    '30D': null,
    ALL: {
      ...allExternalMetric,
      totalReturn: 409_504,
    },
  };
  const absurdScore = scoreObservedTraderProfile(
    {
      ...baseProfile,
      totalPnl: '410339.87',
      totalVolume: '25477017.26',
      predictionCount: 3619,
      holdingsValue: '310220.06',
      curves: Array.from({ length: 40 }, (_, index) => 100_000 + index * 5000).map((value, index) => ({
        curveType: 'PORTFOLIO_PNL_ALL',
        period: 'ALL',
        ts: new Date(Date.UTC(2026, 0, index + 1)),
        value: String(value),
      })),
    },
    observedTrader,
    absurdExternalMetrics,
    eligibleV23Options
  );
  const absurdExplain = absurdScore.scoreExplain as {
    warnings?: string[];
    rawMetrics?: { externalTotalReturnRaw?: number | null; externalTotalReturn?: number | null };
  };
  assert.ok((absurdExplain.warnings ?? []).includes('absurd_external_return'));
  assert.equal(absurdExplain.rawMetrics?.externalTotalReturnRaw, 409_504);
  // 总盈利率改近窗已平仓 Σpnl/Σcost；本用例经 eligible 分布注入为 40%
  assert.ok(
    absurdScore.externalTotalReturn != null &&
      Math.abs(absurdScore.externalTotalReturn - 40) < 0.5,
    `expected ~40% closed-event ROI display points, got ${absurdScore.externalTotalReturn}`
  );
  assert.notEqual(absurdScore.externalTotalReturn, 409_504);

  // 展示口径：PF 仅 closed；无亏损不回退曲线；MDD 仅 ALL×1Y
  const noLossDisplay = scoreObservedTraderProfile(
    {
      ...baseProfile,
      totalPnl: '50000',
      totalVolume: '200000',
      curves: [
        ...Array.from({ length: 20 }, (_, index) => ({
          curveType: 'PORTFOLIO_PNL_ALL' as const,
          period: 'ALL' as const,
          ts: new Date(Date.UTC(2025, 6, index + 1)),
          value: String(10_000 + index * 200),
        })),
        // 短窗曲线故意做成更大回撤，若误回退 preferred(1W) 会吃到它
        ...Array.from({ length: 8 }, (_, index) => ({
          curveType: 'PORTFOLIO_PNL_1W' as const,
          period: '1W' as const,
          ts: new Date(Date.UTC(2025, 6, 20 + index)),
          value: String(index === 0 ? 50_000 : index === 1 ? 5_000 : 20_000 + index),
        })),
      ],
    },
    observedTrader,
    {
      '7D': null,
      '30D': null,
      ALL: {
        period: 'ALL',
        source: 'predicting.top',
        winRate: 0.55,
        profitFactor: 3.23,
        sharpeRatio: 1.2,
        totalReturn: 0.4,
        maxDrawdownPercent: 0.5,
        currentDrawdown: 0.1,
        calculatedAt: new Date(),
      },
    },
    {
      ...eligibleV23Options,
      positionPnlStats: buildPositionPnlStats(
        {
          sampleSize: 10,
          marketCount: 10,
          decisiveMarkets: 10,
          winningMarkets: 10,
          losingMarkets: 0,
          marketWinRate: 1,
          topMarketPnlShare: 0.2,
          totalRealizedPnl: 12_345,
          profitFactor: null,
          profitFactorNoLoss: true,
        },
        null
      ),
      closedMarketReturnDistribution: {
        sampledMarketCount: 10,
        meanReturn: 0.2,
        medianReturn: 0.15,
        totalReturnRatio: 0.18,
        totalRealizedPnl: 12_345,
        totalCostBasisUsd: 68_583,
        buckets: [],
      },
    }
  );
  const noLossExplain = noLossDisplay.scoreExplain as {
    displayProfile?: {
      profitFactor?: number | null;
      profitFactorNoLoss?: boolean;
      totalPnl1y?: number | null;
      maxDrawdownPercent?: number | null;
      maxDrawdownUsd?: number | null;
      metricsSource?: { maxDrawdown?: string; profitFactor?: string };
    };
  };
  assert.equal(noLossExplain.displayProfile?.profitFactor, null);
  assert.equal(noLossExplain.displayProfile?.profitFactorNoLoss, true);
  assert.equal(noLossExplain.displayProfile?.totalPnl1y, 12_345);
  assert.equal(noLossExplain.displayProfile?.metricsSource?.profitFactor, 'CLOSED_POSITIONS');
  assert.equal(noLossExplain.displayProfile?.metricsSource?.maxDrawdown, 'PORTFOLIO_PNL_ALL_1Y');
  // 1W 假大回撤不得冒充展示 MDD（1W 从 50k→5k ≈90%）
  assert.ok(
    (noLossExplain.displayProfile?.maxDrawdownPercent ?? 0) < 0.5,
    `display MDD must not use 1W spike, got ${noLossExplain.displayProfile?.maxDrawdownPercent}`
  );

  console.log('smartMoneyScorer.test.ts: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
