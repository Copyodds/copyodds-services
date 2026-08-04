/**
 * 本地无 DB：按排行榜 Deep-Gate 主路径逐步跑单地址，输出资金与表现 / 档位 / 类型。
 *
 * Usage:
 *   npx tsx scripts/run-leaderboard-pipeline-wallet-live.ts --wallet=0x...
 */
process.env.CUSTODY_TREASURY_ADDRESS ??=
  '0x0000000000000000000000000000000000000001';
process.env.DATABASE_URL ??= 'postgresql://u:p@127.0.0.1:5432/unused';
process.env.JWT_SECRET ??= 'pipeline-wallet-live-not-for-prod';
process.env.RPC_URL ??= 'http://127.0.0.1:8545';
process.env.SMART_MONEY_SCORE_VERSION ??= 'v4.0';

function walletArg(): string {
  const raw = process.argv.find((a) => a.startsWith('--wallet='))?.slice('--wallet='.length);
  const wallet = raw?.trim().toLowerCase() ?? '';
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error('valid --wallet=0x... is required');
  return wallet;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const x = Math.abs(v) <= 5 ? v * 100 : v;
  return `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`;
}

function usd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function step(title: string, data?: unknown): void {
  console.log(`\n======== ${title} ========`);
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  const wallet = walletArg();
  const t0 = Date.now();

  const { CONFIG } = await import('../src/config/env.js');
  const { fetchPolymarketProfile } = await import('../src/services/polymarket/polymarketProfile.js');
  const { fetchDataApiTradesInWindow, normalizeTradeTimestampMs } = await import(
    '../src/services/polymarket/polymarketTrades.js'
  );
  const {
    fetchPositionPnlContext,
    buildClosedMarketReturnDistribution,
  } = await import('../src/services/smartMoney/smartMoneyPositionStats.js');
  const { hasCopyPoolHardFlag, buildCopyPoolHardElimReason, extractL1DisplayAlignedMetrics, extractResolvedTotalPnl, evaluateTier1L, evaluateL1CurveEarlyReject, evaluateL1CandidateGate } = await import('../src/services/smartMoney/smartMoneyTierGate.js');
  const { scoreObservedTraderProfile } = await import(
    '../src/services/smartMoney/smartMoneyScorer.js'
  );
  const {
    buildDefaultCopyabilitySimOptions,
    simulateCopyabilityFromTrades,
  } = await import('../src/services/smartMoney/smartMoneyCopyabilitySim.js');
  const { extractLeaderboardDisplayColumns } = await import(
    '../src/services/smartMoney/smartMoneyLeaderboardWriter.js'
  );
  const { resolveCopyPoolMetricScore } = await import(
    '../src/services/smartMoney/smartMoneyPoolScore.js'
  );
  const { CLOSED_POSITIONS_DEFAULT_MAX_PAGES } = await import(
    '../src/services/polymarket/polymarketData.js'
  );

  step('0) 输入', {
    wallet,
    scoreVersion: CONFIG.smartMoneyScoreVersion,
    closedMaxPages: CLOSED_POSITIONS_DEFAULT_MAX_PAGES,
    enterScore: CONFIG.smartMoneyCopyPoolEnterScore,
    exitScore: CONFIG.smartMoneyCopyPoolExitScore,
  });

  // ---- 1) Profile（对应 Deep: resolvePolymarketProfile forceLive）----
  const tProfile = Date.now();
  const profile = await fetchPolymarketProfile(wallet, {
    pnlPeriods: ['1D', '1W', '1M', 'ALL'],
    cacheTtlMs: 0,
  });
  step('1) 拉取 Polymarket Profile（live）', {
    elapsedMs: Date.now() - tProfile,
    displayName: profile.displayName,
    holdingsValue: profile.holdingsValue,
    predictionCount: profile.predictionCount,
    totalVolume: profile.totalVolume,
    totalPnl: profile.totalPnl,
    curveCount: profile.curves.length,
    curveTypes: [...new Set(profile.curves.map((c) => `${c.curveType}:${c.period}`))],
  });

  // ---- 2) Tier1L ----
  const tier1l = evaluateTier1L(profile);
  step('2) Light/Deep 共用 Tier1L', tier1l);
  if (!tier1l.passed) {
    step('结果', { stop: 'T1L_FAIL', failReason: tier1l.failReason });
    return;
  }

  // ---- 3) 曲线早杀 ----
  const early = evaluateL1CurveEarlyReject(profile);
  step('3) L1 曲线早杀（不拉 closed/trades）', early);
  if (!early.passed) {
    step('结果', { stop: 'L1-EARLY', failReason: early.failReason });
    return;
  }

  // ---- 4) closed-positions（80 页窗）+ trades 30d ----
  const now = Date.now();
  const start30d = now - 30 * 24 * 60 * 60 * 1000;
  const start7d = now - 7 * 24 * 60 * 60 * 1000;
  const tFetch = Date.now();
  const [tradesWindow, positionContext] = await Promise.all([
    fetchDataApiTradesInWindow(wallet, start30d, now),
    fetchPositionPnlContext(wallet),
  ]);
  const trades = tradesWindow.trades;
  const start1d = now - 24 * 60 * 60 * 1000;
  const trades1d = trades.filter((t) => {
    const ms = normalizeTradeTimestampMs(t.timestamp);
    return ms != null && ms >= start1d;
  }).length;
  const trades7d = trades.filter((t) => {
    const ms = normalizeTradeTimestampMs(t.timestamp);
    return ms != null && ms >= start7d;
  }).length;
  const trades30d = trades.length;
  const distribution = buildClosedMarketReturnDistribution(positionContext.closedRows);
  step('4) 采集 closed-positions + trades(30d)', {
    elapsedMs: Date.now() - tFetch,
    closedFetchOk: positionContext.closedFetchOk,
    closedFetchError: positionContext.closedFetchError,
    closedSample: positionContext.closedSample ?? null,
    closedRows: positionContext.closedRows.length,
    trades1d,
    trades7d,
    trades30d,
    maxTradesPerDay: CONFIG.smartMoneyMaxTradesPerDay,
    closedStats: positionContext.stats.closed
      ? {
          decisiveMarkets: positionContext.stats.closed.decisiveMarkets,
          winRate: positionContext.stats.closed.marketWinRate,
          profitFactor: positionContext.stats.closed.profitFactor,
          profitFactorNoLoss: positionContext.stats.closed.profitFactorNoLoss,
          winMarketCount: positionContext.stats.closed.winningMarkets,
          lossMarketCount:
            positionContext.stats.closed.decisiveMarkets -
            positionContext.stats.closed.winningMarkets,
        }
      : null,
    distribution: distribution
      ? {
          totalReturnRatio: distribution.totalReturnRatio,
          meanReturn: distribution.meanReturn,
          totalCostBasisUsd: distribution.totalCostBasisUsd,
          totalRealizedPnl: distribution.totalRealizedPnl,
          sampledMarketCount: distribution.sampledMarketCount,
        }
      : null,
  });

  // ---- 5) copyability 仿真 + 打分 ----
  const copyability = simulateCopyabilityFromTrades(
    trades,
    buildDefaultCopyabilitySimOptions(),
    now
  );
  const observed = {
    wallet,
    sourceRankWeek: null as number | null,
    sourceRankMonth: null as number | null,
    sourceRankAll: null as number | null,
    officialSourceRankWeek: null as number | null,
    officialSourceRankMonth: null as number | null,
    officialSourceRankAll: null as number | null,
    externalSourceRankWeek: null as number | null,
    externalSourceRankMonth: null as number | null,
    externalSourceRankAll: null as number | null,
    candidatePeriods: [] as string[],
    candidateCategories: ['OVERALL'],
    blacklisted: false,
    noiseTags: [] as string[],
  };
  const tScore = Date.now();
  const score = scoreObservedTraderProfile(
    profile,
    observed,
    { '7D': null, '30D': null, ALL: null },
    {
      trades7d,
      trades30d,
      tradesPerDay1D: trades1d,
      positionPnlStats: positionContext.stats,
      closedMarketReturnDistribution: distribution,
      closedRows: positionContext.closedRows,
      marketLiquidityProfile: null,
      copyabilityScore: copyability.copyabilityScore,
    }
  );
  const displayCols = extractLeaderboardDisplayColumns(score.scoreExplain);
  const explain = score.scoreExplain as Record<string, unknown>;
  const displayProfile = (explain.displayProfile ?? {}) as Record<string, unknown>;
  const traderProfile = (explain.traderProfile ?? {}) as Record<string, unknown>;
  const card = (traderProfile.card ?? {}) as Record<string, unknown>;

  step('5) 评分 scoreObservedTraderProfile', {
    elapsedMs: Date.now() - tScore,
    score: score.score,
    traderScore: score.traderScore,
    tier: score.tier,
    traderType: score.traderType,
    edgeScore: score.edgeScore,
    riskFlags: score.riskFlags,
    totalPnl: score.totalPnl,
    externalWinRate: score.externalWinRate,
    externalTotalReturn: score.externalTotalReturn,
    maxDrawdownPercent: score.maxDrawdownPercent,
    copyabilityScore: copyability.copyabilityScore,
    card: {
      tier: card.tier ?? traderProfile.tier ?? score.tier,
      traderScore: card.traderScore ?? score.traderScore,
      traderType: card.traderType ?? score.traderType,
    },
  });

  // ---- 6) L1（与 Deep 一致：accountPnl1y 等）----
  const aligned = extractL1DisplayAlignedMetrics(score);
  const closed = positionContext.stats.closed;
  const closedFetchOk = positionContext.closedFetchOk;
  const closedMarketDataMissing =
    closedFetchOk === false ||
    score.riskFlags.includes('CLOSED_POSITIONS_FETCH_FAILED') ||
    score.riskFlags.includes('CLOSED_RETURN_DATA_MISSING');
  const closedMarketCountRaw =
    closed?.decisiveMarkets ?? distribution?.sampledMarketCount ?? null;
  const closedMarketCount = closedMarketDataMissing ? null : (closedMarketCountRaw ?? 0);
  const profitFactorNoLoss = Boolean(closed?.profitFactorNoLoss);
  const winMarketCount = closed?.winningMarkets ?? null;
  const lossMarketCount =
    closed != null ? closed.decisiveMarkets - closed.winningMarkets : null;
  const totalVolume =
    score.metrics.totalVolume ?? (profile.totalVolume != null ? Number(profile.totalVolume) : null);

  const l1 = evaluateL1CandidateGate({
    profile,
    resolvedTotalPnl: extractResolvedTotalPnl(score),
    totalVolume,
    effectiveTotalReturn: aligned.effectiveTotalReturn,
    effectiveMaxDrawdown: aligned.effectiveMaxDrawdown,
    winRate: closed?.marketWinRate ?? num(displayProfile.winRate),
    profitFactor: closed?.profitFactor ?? num(displayProfile.profitFactor),
    profitFactorNoLoss,
    trades7d,
    trades30d,
    closedMarketCount,
    closedMarketDataMissing,
    totalPnl1y: displayCols.accountPnl1y,
    pnlWindowDays: displayCols.pnlWindowDays,
    totalReturn1y: displayCols.totalReturn1y,
    maxDrawdown1y: displayCols.maxDrawdown1y,
    maxDrawdownUsd1y: displayCols.maxDrawdownUsd1y,
    medianNotionalUsd: num(displayProfile.medianNotionalUsd),
    dustShare: num(displayProfile.dustShare),
  });
  step('6) L1 Candidate Gate', {
    passed: l1.passed,
    failReason: l1.failReason,
    aligned,
    accountPnl1y: displayCols.accountPnl1y,
    closedPnl1y: displayCols.totalPnl1y,
    closedMarketDataMissing,
  });

  const hardFlag = hasCopyPoolHardFlag(score.riskFlags);
  const hardReason = hardFlag ? buildCopyPoolHardElimReason(score.riskFlags) : null;
  const poolScore = resolveCopyPoolMetricScore({
    traderScore: score.traderScore,
    score: score.score,
  });
  const canEnter =
    l1.passed && !hardFlag && poolScore >= CONFIG.smartMoneyCopyPoolEnterScore;

  step('7) CopyPool 入池判定', {
    hardFlag,
    hardReason,
    trades1d,
    maxTradesPerDay: CONFIG.smartMoneyMaxTradesPerDay,
    poolScore,
    enterScore: CONFIG.smartMoneyCopyPoolEnterScore,
    canEnterCopyPool: canEnter,
    riskFlags: score.riskFlags,
  });

  // ---- 资金与表现（详情 KPI）----
  const capitalPerformance = {
    总盈亏_账户曲线: usd(num(profile.totalPnl) ?? score.totalPnl),
    已平仓盈亏_近一年样本: usd(num(displayProfile.totalPnl1y) ?? displayCols.totalPnl1y),
    账户曲线盈亏_近一年_L1用: usd(displayCols.accountPnl1y),
    未实现盈亏: usd(num(displayProfile.unrealizedPnl)),
    总成交量: usd(num(profile.totalVolume) ?? score.metrics.totalVolume),
    持仓价值: usd(num(profile.holdingsValue)),
    胜率: pct(closed?.marketWinRate ?? num(displayProfile.winRate)),
    盈亏比: closed?.profitFactorNoLoss
      ? '∞（无亏损）'
      : closed?.profitFactor != null
        ? closed.profitFactor.toFixed(2)
        : '—',
    盈亏次数: `${winMarketCount ?? '—'} / ${lossMarketCount ?? '—'}`,
    总盈利率: pct(num(displayProfile.totalReturnRatio) ?? distribution?.totalReturnRatio),
    平均盈利率: pct(num(displayProfile.avgClosedReturnRate) ?? distribution?.meanReturn),
    最大回撤率: pct(num(displayProfile.maxDrawdownPercent) ?? score.maxDrawdownPercent),
    最大回撤金额: usd(num(displayProfile.maxDrawdownUsd) ?? displayCols.maxDrawdownUsd1y),
    近7日盈亏: usd(num(displayProfile.recentPnl7d)),
    近7日笔数: num(displayProfile.trades7d) ?? trades7d,
    近30日盈亏: usd(num(displayProfile.recentPnl30d)),
    近30日笔数: num(displayProfile.trades30d) ?? trades30d,
    最大投入: usd(num(displayProfile.maxInvestedCostUsd)),
    closed样本: positionContext.closedSample ?? null,
  };

  step('8) 资金与表现（详情 KPI）', capitalPerformance);
  step('9) 档位 / 类型 / 分数', {
    tier: score.tier,
    traderType: score.traderType,
    traderScore: score.traderScore,
    compositeScore: score.score,
    edgeScore: score.edgeScore,
    riskFlags: score.riskFlags,
    copyabilityScore: copyability.copyabilityScore,
  });

  step('10) 最终结论', {
    pipeline: 'Deep-Gate 等价本地跑（无写库）',
    tier1l: tier1l.passed,
    l1Early: early.passed,
    l1: l1.passed,
    hardFlag,
    canEnterCopyPool: canEnter,
    totalElapsedMs: Date.now() - t0,
  });

  // 便于复制的摘要块
  console.log('\n======== SUMMARY ========');
  console.log(
    JSON.stringify(
      {
        wallet,
        displayName: profile.displayName,
        tier: score.tier,
        traderType: score.traderType,
        traderScore: score.traderScore,
        score: score.score,
        capitalPerformance,
        gates: {
          tier1l: tier1l.passed,
          l1Early: early.passed,
          l1Passed: l1.passed,
          l1FailReason: l1.failReason,
          hardFlag,
          canEnterCopyPool: canEnter,
        },
        riskFlags: score.riskFlags,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('[run-leaderboard-pipeline-wallet-live] failed', err);
  process.exitCode = 1;
});
