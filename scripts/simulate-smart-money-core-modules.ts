/**
 * 无 DB 的 Smart Money 核心链路模拟：用真实模块 + 合成数据，检查卡点/口径 bug。
 *
 * Usage:
 *   npx tsx scripts/simulate-smart-money-core-modules.ts
 */
import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.SMART_MONEY_SCORE_VERSION = process.env.SMART_MONEY_SCORE_VERSION ?? 'v4.1';
process.env.SMART_MONEY_COPYABILITY_ENABLED =
  process.env.SMART_MONEY_COPYABILITY_ENABLED ?? 'true';
process.env.SMART_MONEY_MAX_TRADES_PER_DAY =
  process.env.SMART_MONEY_MAX_TRADES_PER_DAY ?? '50';

type Issue = { severity: 'bug' | 'stuck' | 'warn'; area: string; detail: string };
const issues: Issue[] = [];

function bug(area: string, detail: string): void {
  issues.push({ severity: 'bug', area, detail });
  console.error(`[BUG] ${area}: ${detail}`);
}
function stuck(area: string, detail: string): void {
  issues.push({ severity: 'stuck', area, detail });
  console.error(`[STUCK] ${area}: ${detail}`);
}
function warn(area: string, detail: string): void {
  issues.push({ severity: 'warn', area, detail });
  console.warn(`[WARN] ${area}: ${detail}`);
}
function ok(msg: string): void {
  console.log(`[OK] ${msg}`);
}

async function main(): Promise<void> {
  console.log('\n=== 1) CopyPool / cached 出榜线（§15 TraderScore 优先）===');
  const { CONFIG } = await import('../src/config/env');
  const {
    smartMoneyCachedDisplayWhere,
    smartMoneyLeaderboardRankWhere,
  } = await import('../src/services/smartMoney/smartMoneyCachedQuery');
  const exit = CONFIG.smartMoneyCopyPoolExitScore;
  const displayWhere = smartMoneyCachedDisplayWhere();
  const rankWhere = smartMoneyLeaderboardRankWhere();
  if (displayWhere.inCopyPool !== true || displayWhere.rank == null) {
    bug('cachedDisplayWhere', `期望 inCopyPool+rank，实际 ${JSON.stringify(displayWhere)}`);
  } else {
    ok(`cached display: CopyPool + rank + 池分 > ${exit}`);
  }
  if (rankWhere.inCopyPool !== true) {
    bug('rankWhere', `期望 inCopyPool，实际 ${JSON.stringify(rankWhere)}`);
  } else {
    ok(`rank where: CopyPool + 池分 > ${exit}`);
  }
  if (!CONFIG.smartMoneyTraderScoreAsPrimary) {
    warn('poolScore', 'TraderScore 主轨关闭，仍走 v4 score');
  } else {
    ok('TraderScore 为主池分');
  }

  console.log('\n=== 2) 胜率：禁止 CURVE_PROXY 作主展示 ===');
  const { resolveLeaderboardWinRateMeta } = await import(
    '../src/services/smartMoney/smartMoneyScorer'
  );
  const emptyExternal = { WEEK: null, MONTH: null, ALL: null };
  const sourceByPeriod = {
    WEEK: 'LOCAL_FALLBACK' as const,
    MONTH: 'LOCAL_FALLBACK' as const,
    ALL: 'LOCAL_FALLBACK' as const,
  };
  // 仅曲线、无已平仓 → 主字段必须 null，不得 CURVE_PROXY
  const curveOnly = resolveLeaderboardWinRateMeta({
    externalMetrics: emptyExternal,
    sourceByPeriod,
    positionPnlStats: null,
    resolvedTotalPnl: 5000,
    preferredCurveValues: [100, 110, 105, 120, 115, 130],
  });
  if (curveOnly.winRateSource === 'CURVE_PROXY') {
    bug('winRate', '无 closed 样本时仍返回 CURVE_PROXY 作为主源');
  } else if (curveOnly.winRate != null) {
    bug('winRate', `无 closed 时主 winRate 应为 null，实际=${curveOnly.winRate}`);
  } else {
    ok('无 closed 时主胜率为 null（曲线仅作 proxy 字段）');
  }
  if (curveOnly.curveWinRateProxy == null) {
    warn('winRate', 'curveWinRateProxy 为空，内部打分可能缺回退');
  } else {
    ok(`curveWinRateProxy=${curveOnly.curveWinRateProxy} 仅内部使用`);
  }

  const closedMeta = resolveLeaderboardWinRateMeta({
    externalMetrics: emptyExternal,
    sourceByPeriod,
    positionPnlStats: {
      closed: {
        sampleSize: 20,
        marketCount: 12,
        decisiveMarkets: 12,
        winningMarkets: 8,
        losingMarkets: 4,
        marketWinRate: 8 / 12,
        topMarketPnlShare: 0.25,
        totalRealizedPnl: 4000,
        profitFactor: 1.8,
        profitFactorNoLoss: false,
      },
      open: {
        sampleSize: 0,
        marketCount: 0,
        decisiveMarkets: 0,
        winningMarkets: 0,
        marketWinRate: null,
        underwaterMarketShare: null,
        totalUnrealizedPnl: null,
        totalCostBasis: null,
      },
      compositeMarketWinRate: 8 / 12,
      hedgedPairExposure: null,
    },
    resolvedTotalPnl: 4000,
    preferredCurveValues: [100, 50, 40], // 曲线很差，旧逻辑可能覆盖成 CURVE_PROXY
  });
  if (closedMeta.winRateSource !== 'MARKET_CLOSED') {
    bug('winRate', `空 open 时应为 MARKET_CLOSED，实际=${closedMeta.winRateSource}`);
  } else {
    ok(`空 open 胜率主源 MARKET_CLOSED winRate=${closedMeta.winRate}`);
  }

  const compositeMeta = resolveLeaderboardWinRateMeta({
    externalMetrics: emptyExternal,
    sourceByPeriod,
    positionPnlStats: {
      closed: {
        sampleSize: 20,
        marketCount: 12,
        decisiveMarkets: 12,
        winningMarkets: 8,
        losingMarkets: 4,
        marketWinRate: 8 / 12,
        topMarketPnlShare: 0.25,
        totalRealizedPnl: 4000,
        profitFactor: 1.8,
        profitFactorNoLoss: false,
      },
      open: {
        sampleSize: 10,
        marketCount: 10,
        decisiveMarkets: 8,
        winningMarkets: 2,
        marketWinRate: 2 / 8,
        underwaterMarketShare: 0.5,
        totalUnrealizedPnl: -100,
        totalCostBasis: null,
      },
      compositeMarketWinRate: 10 / 20,
      hedgedPairExposure: null,
    },
    resolvedTotalPnl: 4000,
    preferredCurveValues: [100, 50, 40],
  });
  if (compositeMeta.winRateSource !== 'MARKET_CLOSED') {
    bug('winRate', `有 open 时主源仍应为 MARKET_CLOSED，实际=${compositeMeta.winRateSource}`);
  } else if (compositeMeta.winRate == null || Math.abs(compositeMeta.winRate - 8 / 12) > 0.01) {
    bug('winRate', `主胜率应为已平仓 8/12，实际=${compositeMeta.winRate}`);
  } else {
    ok(`统一已平仓胜率 MARKET_CLOSED winRate=${compositeMeta.winRate}（忽略 open/composite）`);
  }

  console.log('\n=== 3) L1/C* 闸门：合格 vs 卡住 ===');
  const { evaluateL1CandidateGate } = await import('../src/services/smartMoney/smartMoneyTierGate');

  function mockProfile(pnlCurve: number[], holdings = 8000) {
    const now = Date.now();
    return {
      wallet: '0xsim',
      snapshotAt: new Date(now),
      displayName: 'sim',
      profileSlug: null,
      profileImage: null,
      xUsername: null,
      joinedAtText: null,
      viewsText: null,
      holdingsValue: String(holdings),
      biggestWin: null,
      predictionCount: 40,
      totalPnl: String(pnlCurve[pnlCurve.length - 1]! - pnlCurve[0]!),
      totalVolume: '200000',
      realizedPnl: null,
      unrealizedPnl: null,
      curves: pnlCurve.map((value, i) => ({
        period: 'ALL' as const,
        curveType: 'PORTFOLIO_PNL_ALL',
        ts: new Date(now - (pnlCurve.length - i) * 86_400_000),
        value,
      })),
    };
  }

  const goodCurve = [1000, 1500, 2000, 2800, 3500, 4200, 5000];
  const passL1 = evaluateL1CandidateGate({
    profile: mockProfile(goodCurve) as never,
    resolvedTotalPnl: 4000,
    totalVolume: 200_000,
    effectiveTotalReturn: 0.4,
    effectiveMaxDrawdown: 0.15,
    winRate: 0.25,
    profitFactor: 1.5,
    trades7d: 8,
    trades30d: 8,
    closedMarketCount: 12,
  });
  if (!passL1.passed) {
    bug('L1', `合格样本未过门: ${passL1.failReason}`);
  } else {
    ok('合格样本过 L1');
  }

  // 缺 profile.curves 不得抛异常（Deep 外误用时也应 L1-DATA）
  let threw = false;
  try {
    const noCurves = evaluateL1CandidateGate({
      profile: { curves: undefined } as never,
      resolvedTotalPnl: 4000,
      totalVolume: 200_000,
      effectiveTotalReturn: 0.4,
      effectiveMaxDrawdown: 0.15,
      winRate: 0.25,
      profitFactor: 1.5,
      trades7d: 8,
      trades30d: 8,
      closedMarketCount: 12,
    });
    if (noCurves.passed) bug('L1', '缺曲线不应通过');
    else ok(`缺曲线安全失败: ${noCurves.failReason}`);
  } catch (e) {
    threw = true;
    bug('L1', `缺 curves 时抛异常（会卡住 Deep 批）: ${e instanceof Error ? e.message : e}`);
  }
  if (!threw) {
    /* already ok or bug above */
  }

  const failWr = evaluateL1CandidateGate({
    profile: mockProfile(goodCurve) as never,
    resolvedTotalPnl: 4000,
    totalVolume: 200_000,
    effectiveTotalReturn: 0.4,
    effectiveMaxDrawdown: 0.15,
    winRate: 0.05,
    profitFactor: 1.5,
    trades7d: 8,
    trades30d: 8,
    closedMarketCount: 12,
  });
  // §15：默认不硬拦胜率
  if (CONFIG.smartMoneyL1RequireWinRate) {
    if (failWr.passed) bug('L1', '胜率门开启时 5% 不应过');
    else ok(`胜率不足被拒: ${failWr.failReason}`);
  } else if (!failWr.passed && failWr.failReason?.includes('L1-WR')) {
    bug('L1', '胜率门默认关闭却仍 L1-WR');
  } else {
    ok('§15 默认不硬拦胜率（5% 可过 WR 门）');
  }

  const failPf = evaluateL1CandidateGate({
    profile: mockProfile(goodCurve) as never,
    resolvedTotalPnl: 4000,
    totalVolume: 200_000,
    effectiveTotalReturn: 0.4,
    effectiveMaxDrawdown: 0.15,
    winRate: 0.25,
    profitFactor: 1.0,
    trades7d: 8,
    trades30d: 8,
    closedMarketCount: 12,
  });
  // 默认 min PF=1.0 → 比较为 <，1.0 不杀；0.9 应杀
  if (failPf.passed) {
    ok(`盈亏比=1.0 在默认门槛(${CONFIG.smartMoneyScorePoolMinProfitFactor})下可通过`);
  } else {
    ok(`盈亏比不足被拒: ${failPf.failReason}`);
  }
  const failPfLow = evaluateL1CandidateGate({
    profile: mockProfile(goodCurve) as never,
    resolvedTotalPnl: 4000,
    totalVolume: 200_000,
    effectiveTotalReturn: 0.4,
    effectiveMaxDrawdown: 0.15,
    winRate: 0.25,
    profitFactor: 0.9,
    trades7d: 8,
    trades30d: 8,
    closedMarketCount: 12,
  });
  if (failPfLow.passed || !failPfLow.failReason?.includes('L1-PF')) {
    bug('L1', `盈亏比 0.9 应 L1-PF，实际=${failPfLow.failReason}`);
  } else {
    ok(`盈亏比 0.9 被拒: ${failPfLow.failReason}`);
  }

  const failTrades = evaluateL1CandidateGate({
    profile: mockProfile(goodCurve) as never,
    resolvedTotalPnl: 4000,
    totalVolume: 200_000,
    effectiveTotalReturn: 0.4,
    effectiveMaxDrawdown: 0.15,
    winRate: 0.25,
    profitFactor: 1.5,
    trades7d: 0,
    trades30d: 1,
    closedMarketCount: 12,
  });
  if (failTrades.passed) {
    bug('L1', 'trades30d=1 不应过 C6');
  } else {
    ok(`近30日成交不足被拒: ${failTrades.failReason}`);
  }

  // 同窗美元回撤门
  const { failsMaxDrawdownUsdLtPnl } = await import('../src/services/smartMoney/smartMoneyTierGate');
  if (!CONFIG.smartMoneyL1MaxDdUsdLtPnl) {
    warn('L1-DD', '美元门关闭，跳过同窗 MDD$ 断言');
  } else {
    const usdFail = evaluateL1CandidateGate({
      profile: mockProfile(goodCurve) as never,
      resolvedTotalPnl: 4000,
      totalVolume: 200_000,
      totalPnl1y: 4000,
      maxDrawdownUsd1y: 5000,
      totalReturn1y: 0.4,
      maxDrawdown1y: 0.1,
      winRate: 0.25,
      profitFactor: 1.5,
      trades7d: 8,
      trades30d: 8,
      closedMarketCount: 12,
    });
    if (usdFail.passed || !usdFail.failReason?.includes('L1-DD')) {
      bug('L1-DD', `MDD$>=PnL$ 应杀，实际=${usdFail.failReason}`);
    } else {
      ok('同窗 MDD$ >= PnL$ → L1-DD');
    }
    if (
      failsMaxDrawdownUsdLtPnl({ maxDrawdownUsd: 4000, totalPnlUsd: 4000 }) !== true ||
      failsMaxDrawdownUsdLtPnl({ maxDrawdownUsd: 3999, totalPnlUsd: 4000 }) !== false
    ) {
      bug('L1-DD', '严格 < 边界断言失败');
    } else {
      ok('美元门严格 <（相等也杀）');
    }
  }

  console.log('\n=== 4) §6 评分：权重 / 频率 / copyability 缺失 ===');
  const {
    computeSmartMoneyScoreV40,
    computeActivityFreqFactor,
    sumSmartMoneyScoreV40Weights,
    SMART_MONEY_COPYABILITY_MISSING_DEFAULT,
  } = await import('../src/services/smartMoney/smartMoneyScoreV40');
  if (Math.abs(sumSmartMoneyScoreV40Weights() - 1) > 1e-9) {
    bug('scoreV40', `权重和=${sumSmartMoneyScoreV40Weights()} 应为 1`);
  } else {
    ok('v4.1 权重和=1');
  }
  if (computeActivityFreqFactor(7 * 250) !== 0) {
    bug('activity_freq', 't>200 应为 0');
  } else {
    ok('高频 t>200 → 0');
  }
  const missing = computeSmartMoneyScoreV40({
    dataConfidence: 70,
    sampleSize: 30,
    totalReturn: 0.3,
    sharpeRatio: 1,
    maxDrawdownPercent: 0.2,
    winRate: 0.4,
    profitFactor: 1.5,
    maxSpikeRatio: 0.2,
    copyabilityScore: null,
    recentPnl7d: 200,
    totalPnl1y: 8000,
    trades7d: 14,
    consistencyScore: 60,
    highReturnMarketShare: 0.3,
    top1MarketPnlShare: 0.3,
    tradesPerDay1D: 3,
    hasHighTradeFrequencyFlag: false,
  });
  if (!missing.copyabilityMissing) {
    bug('scoreV40', 'copyability=null 应标 copyabilityMissing');
  }
  if (missing.factors.S_copyability !== SMART_MONEY_COPYABILITY_MISSING_DEFAULT) {
    bug('scoreV40', `缺失默认分应为 ${SMART_MONEY_COPYABILITY_MISSING_DEFAULT}`);
  } else {
    ok(`copyability 缺失用明确默认 ${SMART_MONEY_COPYABILITY_MISSING_DEFAULT} + flag`);
  }
  if (missing.score < 40) {
    warn(
      'scoreV40',
      `合成「可过 L1」样本综合分=${missing.score} < 40，冷启动可能长期进不了展示榜（非必 bug，但吞吐卡点）`
    );
  } else {
    ok(`合成合格样本 score=${missing.score} ≥40 可入榜`);
  }

  console.log('\n=== 5) 仿真跟单（copyabilitySim）空样本 vs 有成交 ===');
  const {
    simulateCopyabilityFromTrades,
    buildDefaultCopyabilitySimOptions,
  } = await import('../src/services/smartMoney/smartMoneyCopyabilitySim');
  const emptySim = simulateCopyabilityFromTrades([], buildDefaultCopyabilitySimOptions(), Date.now());
  if (emptySim.roundTripCount !== 0) {
    bug('copyabilitySim', '空 trades 不应有 roundTrip');
  } else {
    ok(`空样本 copyabilityScore=${emptySim.copyabilityScore} roundTrip=0（可进评分但仿真字段应 null/弱）`);
  }
  if (emptySim.backtestPnlUsd != null && emptySim.roundTripCount === 0) {
    warn('copyabilitySim', '无 roundTrip 仍有 backtestPnlUsd，前端可能展示假精确');
  }

  const nowMs = Date.now();
  const fakeTrades = [
    {
      side: 'BUY' as const,
      asset: 'yes-a',
      conditionId: 'cond-a',
      price: 0.4,
      size: 200,
      timestamp: Math.floor((nowMs - 5 * 86_400_000) / 1000),
    },
    {
      side: 'SELL' as const,
      asset: 'yes-a',
      conditionId: 'cond-a',
      price: 0.6,
      size: 200,
      timestamp: Math.floor((nowMs - 4 * 86_400_000) / 1000),
    },
    {
      side: 'BUY' as const,
      asset: 'yes-b',
      conditionId: 'cond-b',
      price: 0.35,
      size: 200,
      timestamp: Math.floor((nowMs - 3 * 86_400_000) / 1000),
    },
    {
      side: 'SELL' as const,
      asset: 'yes-b',
      conditionId: 'cond-b',
      price: 0.5,
      size: 200,
      timestamp: Math.floor((nowMs - 2 * 86_400_000) / 1000),
    },
  ];
  const withTrades = simulateCopyabilityFromTrades(
    fakeTrades,
    buildDefaultCopyabilitySimOptions(),
    nowMs
  );
  ok(
    `有成交仿真 score=${withTrades.copyabilityScore} backtest=${withTrades.backtestPnlUsd} lossRate=${withTrades.copyLossRate} slips=${withTrades.slippageBpsEffective}`
  );
  if (withTrades.copyabilityScore == null) {
    stuck('copyabilitySim', '有合成成交仍无 copyabilityScore，Deep 进分会退回默认 45');
  }

  console.log('\n=== 6) 火花图 / Recent 降采样（纯函数） ===');
  const { computeBiggestWinRecentFromCurve } = await import(
    '../src/services/smartMoney/smartMoneyDisplayEnrich'
  );
  const dayMs = 86_400_000;
  const curvePts = [
    { ts: new Date(nowMs - 3 * dayMs), value: 100 },
    { ts: new Date(nowMs - 2 * dayMs), value: 120 },
    { ts: new Date(nowMs - 1 * dayMs), value: 110 },
    { ts: new Date(nowMs), value: 150 },
  ];
  const biggest = computeBiggestWinRecentFromCurve(curvePts);
  if (biggest == null || biggest <= 0) {
    bug('displayEnrich', `biggestWinRecent 异常: ${biggest}`);
  } else {
    ok(`biggestWinRecent=${biggest}`);
  }

  console.log('\n=== 7) 真实跟单反馈 ready 门槛 ===');
  const { buildCopierFeedbackSnapshot } = await import(
    '../src/services/smartMoney/smartMoneyCopierFeedbackMetrics'
  );
  const low = buildCopierFeedbackSnapshot({
    lookbackDays: 30,
    closeCount: 1,
    tradeCount: 1,
    subscriberCount: 1,
    totalPnlUsd: 10,
    totalNotionalUsd: 100,
    minCloses: 5,
    minSubscribers: 3,
  });
  const ready = (low.sampleWeight ?? 0) >= 1 && !low.washSuspect;
  if (ready) {
    bug('copierFeedback', '低样本 sampleWeight 不应 ready');
  } else {
    ok(`低样本 ready=false sampleWeight=${low.sampleWeight}`);
  }
  const enough = buildCopierFeedbackSnapshot({
    lookbackDays: 30,
    closeCount: 20,
    tradeCount: 40,
    subscriberCount: 10,
    totalPnlUsd: 500,
    totalNotionalUsd: 5000,
    minCloses: 5,
    minSubscribers: 3,
  });
  if ((enough.sampleWeight ?? 0) < 1) {
    bug('copierFeedback', '充足样本仍 sampleWeight<1');
  } else {
    ok(`充足样本 sampleWeight=${enough.sampleWeight} roi=${enough.copierRoi}`);
  }

  console.log('\n=== 汇总 ===');
  const bugs = issues.filter((i) => i.severity === 'bug');
  const stucks = issues.filter((i) => i.severity === 'stuck');
  const warns = issues.filter((i) => i.severity === 'warn');
  console.log(
    JSON.stringify(
      {
        bugs: bugs.length,
        stuck: stucks.length,
        warns: warns.length,
        issues,
      },
      null,
      2
    )
  );
  if (bugs.length > 0 || stucks.length > 0) {
    process.exitCode = 1;
    console.error('\n模拟发现阻塞级问题，请修后再部署。');
  } else {
    console.log('\n无阻塞级 bug；warn 项建议关注冷启动吞吐。');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
