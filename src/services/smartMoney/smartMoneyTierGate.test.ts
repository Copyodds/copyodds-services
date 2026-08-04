import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
// 本文件测「可选硬门开启」时的 L1 行为；比例尺 MDD 在此显式打开；美元门保持默认 true
process.env.SMART_MONEY_L1_MAX_DD_LE_RETURN = 'true';
process.env.SMART_MONEY_L1_MAX_DD_USD_LT_PNL = 'true';
process.env.SMART_MONEY_L1_REQUIRE_LIFETIME_VOLUME = 'true';
process.env.SMART_MONEY_L1_REQUIRE_WIN_RATE = 'true';
process.env.SMART_MONEY_SCORE_POOL_MIN_PNL_1Y = '1000';
process.env.SMART_MONEY_SCORE_POOL_MIN_WIN_RATE = '0.10';
process.env.SMART_MONEY_SCORE_POOL_MIN_PROFIT_FACTOR = '1.2';
process.env.SMART_MONEY_SCORE_POOL_MIN_TRADES_7D = '1';
process.env.SMART_MONEY_SCORE_POOL_MIN_CLOSED_MARKETS = '3';
process.env.SMART_MONEY_SCORE_POOL_MIN_LIFETIME_VOLUME = '10000';
process.env.SMART_MONEY_L1_DUST_MIN_SAMPLE_COUNT = '20';

async function main(): Promise<void> {
  const { evaluateTier1L, evaluateTier1F, hasCopyPoolHardFlag, buildCopyPoolHardElimReason, evaluateLightCheapReject } =
    await import('./smartMoneyTierGate');

  const failProfile = {
    wallet: '0x0000000000000000000000000000000000000001',
    profileSlug: null,
    displayName: null,
    username: null,
    xUsername: null,
    profileImage: null,
    joinedAtText: null,
    viewsText: null,
    holdingsValue: '100',
    biggestWin: null,
    predictionCount: 5,
    totalPnl: null,
    totalVolume: null,
    sourceUrl: 'https://polymarket.com/profile/test',
    snapshotAt: new Date(),
    curves: [],
    profilePnlApiFilledPeriods: [],
    rawSummary: {},
  };

  const passProfile = {
    ...failProfile,
    holdingsValue: '100',
    predictionCount: 50,
    curves: Array.from({ length: 25 }, (_, index) => ({
      curveType: 'PORTFOLIO_PNL_ALL',
      period: 'ALL' as const,
      ts: new Date(Date.UTC(2026, 0, index + 1)),
      value: String(100 + index),
    })),
  };

  // 持仓不再硬拦；预测数/曲线不足仍失败（可能只报 T1L-2 或 T1L-3）
  assert.equal(evaluateTier1L(failProfile).passed, false);
  const failReason = evaluateTier1L(failProfile).failReason ?? '';
  assert.ok(
    failReason.includes('T1L-2') || failReason.includes('T1L-3'),
    `expected T1L-2 or T1L-3, got ${failReason}`
  );
  assert.equal(failReason.includes('T1L-1'), false);
  assert.equal(evaluateTier1L(passProfile).passed, true);
  assert.equal(
    evaluateTier1F({ tradeCount30d: 0, riskFlags: [], dataConfidence: 80 }).passed,
    false
  );
  assert.equal(
    evaluateTier1F({
      tradeCount30d: 5,
      riskFlags: ['HEDGED_PAIR_EXPOSURE'],
      dataConfidence: 80,
    }).passed,
    false
  );
  assert.equal(hasCopyPoolHardFlag(['BLACKLISTED']), true);
  assert.equal(hasCopyPoolHardFlag(['EXCESSIVE_DRAWDOWN']), false);
  assert.equal(hasCopyPoolHardFlag(['LOW_AVG_CLOSED_RETURN_RATE']), true);
  assert.equal(hasCopyPoolHardFlag(['HIGH_TRADE_FREQUENCY']), false);
  assert.equal(hasCopyPoolHardFlag(['SHORT_HORIZON_MARKET']), false);
  assert.equal(hasCopyPoolHardFlag(['LOW_HOLDINGS']), false);
  assert.equal(hasCopyPoolHardFlag(['DATA_MISMATCH']), false);
  assert.equal(buildCopyPoolHardElimReason(['LOW_HOLDINGS']), null);
  assert.equal(
    buildCopyPoolHardElimReason(['LIKELY_BOT', 'HIGH_TRADE_FREQUENCY']),
    null
  );
  assert.equal(
    buildCopyPoolHardElimReason(['LIKELY_BOT', 'SHORT_HORIZON_MARKET']),
    null
  );
  assert.equal(
    buildCopyPoolHardElimReason(['SHORT_HORIZON_MARKET', 'HEDGED_PAIR_EXPOSURE']),
    'COPY_HARD|HEDGED_PAIR_EXPOSURE'
  );
  assert.equal(hasCopyPoolHardFlag(['LIKELY_BOT']), false);
  assert.equal(buildCopyPoolHardElimReason(['LIKELY_BOT']), null);

  assert.equal(
    evaluateLightCheapReject({
      ...failProfile,
      holdingsValue: '10',
      predictionCount: 12,
      curves: passProfile.curves,
    }).passed,
    false
  );
  assert.ok(
    evaluateLightCheapReject({
      ...failProfile,
      holdingsValue: '10',
      predictionCount: 12,
      curves: passProfile.curves,
    }).failReason?.includes('T1L-SPARSE')
  );
  // 空仓大户：生涯 PnL/成交额豁免稀疏门
  assert.equal(
    evaluateLightCheapReject({
      ...failProfile,
      holdingsValue: '0',
      predictionCount: 12,
      totalPnl: '50000',
      totalVolume: '200000',
      curves: passProfile.curves,
    }).passed,
    true
  );
  assert.equal(
    evaluateLightCheapReject({
      ...passProfile,
      holdingsValue: '5000',
      predictionCount: 80,
    }).passed,
    true
  );

  const { evaluateL1CandidateGate } = await import('./smartMoneyTierGate');
  const l1Base = {
    ...passProfile,
    holdingsValue: '200000',
    totalVolume: '2000000',
    totalPnl: '50000',
  };

  const qualityExtras = {
    winRate: 0.55,
    profitFactor: 1.8,
    trades7d: 12,
    trades30d: 12,
    closedMarketCount: 20,
  };

  // MDD > return → L1-DD
  const ddGtReturnCurve = [100, 120, 140, 160, 180, 200, 130].map((value, index) => ({
    curveType: 'PORTFOLIO_PNL_ALL',
    period: 'ALL' as const,
    ts: new Date(Date.UTC(2026, 0, index + 1)),
    value: String(value),
  }));
  const l1DdGtReturn = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddGtReturnCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.25,
    effectiveMaxDrawdown: 0.5,
    ...qualityExtras,
  });
  assert.equal(l1DdGtReturn.passed, false);
  assert.ok(l1DdGtReturn.failReason?.includes('L1-DD'));

  // MDD ≤ return（即使 MDD>35%）→ 相对规则可通过
  const ddLeReturnHighCurve = Array.from({ length: 20 }, (_, index) => ({
    curveType: 'PORTFOLIO_PNL_ALL',
    period: 'ALL' as const,
    ts: new Date(Date.UTC(2026, 0, index + 1)),
    value: String(index < 15 ? 100 + index * 60 : 400),
  }));

  // MDD=100% 如实保留；比例尺开启且 MDD>回报 → L1-DD（默认生产环境比例尺关闭）
  const l1SaturatedMdd = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    totalPnl1y: 50_000,
    totalReturn1y: 0.19,
    maxDrawdown1y: 1,
    ...qualityExtras,
  });
  assert.equal(l1SaturatedMdd.passed, false);
  assert.ok(l1SaturatedMdd.failReason?.includes('L1-DD'));
  assert.equal(l1SaturatedMdd.failReason?.includes('L1-MDD-PCT') ?? false, false);

  // 真回撤偏大（可测算）仍 L1-DD
  const l1RealDd = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    totalPnl1y: 50_000,
    totalReturn1y: 0.26,
    maxDrawdown1y: 0.48,
    ...qualityExtras,
  });
  assert.equal(l1RealDd.passed, false);
  assert.ok(l1RealDd.failReason?.includes('L1-DD'));

  const l1DdLeReturn = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.6,
    ...qualityExtras,
  });
  assert.equal(l1DdLeReturn.passed, true);

  const l1Pass = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
  });
  assert.equal(l1Pass.passed, true);

  // Gate 为活跃度仅早停抓少量 trades；样本不足时不得用 dustShare 硬杀。
  const l1DustInsufficientSample = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    medianNotionalUsd: 2,
    dustShare: 0.5,
    tradeNotionalSampleCount: 2,
  });
  assert.equal(l1DustInsufficientSample.passed, true);

  // 样本达到门槛后，粉尘占比过高不再硬杀 L1（改为评分侧 HIGH_DUST_SHARE 软扣分）。
  const l1DustEnoughSample = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    medianNotionalUsd: 2,
    dustShare: 0.5,
    tradeNotionalSampleCount: 20,
  });
  assert.equal(l1DustEnoughSample.passed, true);
  assert.equal(l1DustEnoughSample.failReason?.includes('L1-DUST') ?? false, false);

  // 曲线存在即可；不足 90 天只影响置信度，不再作为 L1 硬门。
  const l1ShortWindow = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    totalPnl1y: 50_000,
    pnlWindowDays: 20,
    totalReturn1y: 0.8,
    maxDrawdown1y: 0.2,
    ...qualityExtras,
  });
  assert.equal(l1ShortWindow.passed, true);

  // 足够平仓样本且没有亏损时 PF 为正无穷，展示 null 但 L1 应通过。
  const l1NoLoss = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    winRate: 1,
    profitFactor: null,
    profitFactorNoLoss: true,
  });
  assert.equal(l1NoLoss.passed, true);

  // MDD ≤ return（Calmar≈1.33）应通过；不再要求 Calmar≥2
  const l1OkCalmar = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.2,
    effectiveMaxDrawdown: 0.15,
    ...qualityExtras,
  });
  assert.equal(l1OkCalmar.passed, true);

  // MDD > return → L1-DD
  const l1DdAboveReturn = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.2,
    effectiveMaxDrawdown: 0.25,
    ...qualityExtras,
  });
  assert.equal(l1DdAboveReturn.passed, false);
  assert.ok(l1DdAboveReturn.failReason?.includes('L1-DD'));

  // 与列表同源：展示回报 3.3%、回撤 82% → 必须 L1-DD（不能因本地曲线高回报放行）
  const l1DisplayAligned = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.033,
    effectiveMaxDrawdown: 0.823,
    ...qualityExtras,
  });
  assert.equal(l1DisplayAligned.passed, false);
  assert.ok(l1DisplayAligned.failReason?.includes('L1-DD'));
  assert.equal(l1DisplayAligned.failReason?.includes('L1-RET') ?? false, false);

  // 生涯成交额作为低强度成熟度硬门（默认 $1万）
  const l1LowVolume = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve, totalVolume: '100' },
    resolvedTotalPnl: 50_000,
    totalVolume: 100,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
  });
  assert.equal(l1LowVolume.passed, false);
  assert.equal(l1LowVolume.failReason?.includes('L1-VOLUME') ?? false, true);

  // C1：总盈利不足 1000
  const l1LowPnl = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 500,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
  });
  assert.equal(l1LowPnl.passed, false);
  assert.ok(l1LowPnl.failReason?.includes('L1-PNL'));

  // C4：胜率过低
  const l1LowWr = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    winRate: 0.05,
  });
  assert.equal(l1LowWr.passed, false);
  assert.ok(l1LowWr.failReason?.includes('L1-WR'));

  // C5：盈亏比不足
  const l1LowPf = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    profitFactor: 1.0,
  });
  assert.equal(l1LowPf.passed, false);
  assert.ok(l1LowPf.failReason?.includes('L1-PF'));

  // closed HTTP 失败：跳过 L1-PF（与 Deep data_fetch 重试配合；样本空仍应 L1-PF）
  const l1PfSkippedWhenClosedFetchFailed = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    profitFactor: null,
    profitFactorNoLoss: false,
    closedMarketCount: null,
    closedMarketDataMissing: true,
    closedFetchFailed: true,
  });
  assert.equal(l1PfSkippedWhenClosedFetchFailed.failReason?.includes('L1-PF') ?? false, false);
  assert.equal(l1PfSkippedWhenClosedFetchFailed.failReason?.includes('L1-CLOSED') ?? false, false);

  // 拉成功但无 PF / 样本空：仍应 L1-PF（防放水）
  const l1PfWhenSampleEmpty = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    profitFactor: null,
    profitFactorNoLoss: false,
    closedMarketCount: null,
    closedMarketDataMissing: true,
    closedFetchFailed: false,
  });
  assert.ok(l1PfWhenSampleEmpty.failReason?.includes('L1-PF'));

  // C6：近 30 日不足 2 笔
  const l1NoTrades = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    trades30d: 1,
  });
  assert.equal(l1NoTrades.passed, false);
  assert.ok(l1NoTrades.failReason?.includes('L1-TRADES30D'));

  // trades 抓取失败：跳过 L1-TRADES30D（null 不当 0）
  const l1TradesFetchFail = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    trades30d: null,
    tradesFetchOk: false,
  });
  assert.equal(l1TradesFetchFail.failReason?.includes('L1-TRADES30D') ?? false, false);
  // C8：平仓样本不足（默认 ≥3）
  const l1FewClosed = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    closedMarketCount: 2,
  });
  assert.equal(l1FewClosed.passed, false);
  assert.ok(l1FewClosed.failReason?.includes('L1-CLOSED'));

  const l1ClosedOk = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    closedMarketCount: 3,
  });
  assert.equal(l1ClosedOk.passed, true);

  // 已平仓数据缺失：禁止按 closedCount=0 误杀（上游瞬时失败）
  const l1ClosedDataMissing = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    closedMarketCount: 0,
    closedMarketDataMissing: true,
  });
  assert.equal(l1ClosedDataMissing.passed, true);
  assert.equal(l1ClosedDataMissing.failReason?.includes('L1-CLOSED') ?? false, false);

  const l1ClosedCountUnknown = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
    closedMarketCount: null,
  });
  assert.equal(l1ClosedCountUnknown.passed, true);

  // 缺 curves 不得抛异常
  const l1NoCurves = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: undefined as never },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.8,
    effectiveMaxDrawdown: 0.2,
    ...qualityExtras,
  });
  assert.equal(l1NoCurves.passed, false);
  assert.ok(l1NoCurves.failReason?.includes('L1-DATA'));

  // 美元同窗门：MDD$ >= PnL$ → L1-DD（比例已过关也杀）
  const l1UsdDdFail = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    totalPnl1y: 10_000,
    totalReturn1y: 0.8,
    maxDrawdown1y: 0.1,
    maxDrawdownUsd1y: 12_000,
    ...qualityExtras,
  });
  assert.equal(l1UsdDdFail.passed, false);
  assert.ok(l1UsdDdFail.failReason?.includes('L1-DD'));

  // 美元同窗门：MDD$ < PnL$ → 通过
  const l1UsdDdPass = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    totalPnl1y: 50_000,
    totalReturn1y: 0.8,
    maxDrawdown1y: 0.1,
    maxDrawdownUsd1y: 12_000,
    ...qualityExtras,
  });
  assert.equal(l1UsdDdPass.passed, true);

  // 有窗 PnL 但 MDD$ 不可测 → 跳过美元门（不误杀）
  const l1UsdDdSkip = evaluateL1CandidateGate({
    profile: { ...l1Base, curves: ddLeReturnHighCurve },
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    totalPnl1y: 50_000,
    totalReturn1y: 0.8,
    maxDrawdown1y: 0.1,
    maxDrawdownUsd1y: null,
    ...qualityExtras,
  });
  assert.equal(l1UsdDdSkip.passed, true);

  // Light 预杀：同窗 MDD$ >= PnL$ → T1L-DD
  const lightDdHeavyCurve = Array.from({ length: 30 }, (_, index) => ({
    curveType: 'PORTFOLIO_PNL_ALL',
    period: 'ALL' as const,
    ts: new Date(Date.UTC(2026, 0, index + 1)),
    value: String(index < 20 ? index * 500 : 10_000 - (index - 19) * 800),
  }));
  const lightDd = evaluateLightCheapReject({
    ...passProfile,
    holdingsValue: '5000',
    predictionCount: 80,
    curves: lightDdHeavyCurve,
  });
  assert.equal(lightDd.passed, false);
  assert.ok(lightDd.failReason?.includes('T1L-DD'));

  const { evaluateL1CurveEarlyReject } = await import('./smartMoneyTierGate');
  // Deep 早杀：单调上涨且盈利足够 → 通过（不拦 PF/成交）
  const earlyPass = evaluateL1CurveEarlyReject({
    ...l1Base,
    curves: Array.from({ length: 30 }, (_, index) => ({
      curveType: 'PORTFOLIO_PNL_ALL',
      period: 'ALL' as const,
      ts: new Date(Date.UTC(2026, 0, index + 1)),
      value: String(1000 + index * 200),
    })),
  });
  assert.equal(earlyPass.passed, true);
  assert.ok((earlyPass.totalPnl1y ?? 0) > 1000);

  // Deep 早杀：窗口净盈不足 → L1-PNL（零 HTTP）
  const earlyLowPnl = evaluateL1CurveEarlyReject({
    ...l1Base,
    curves: Array.from({ length: 10 }, (_, index) => ({
      curveType: 'PORTFOLIO_PNL_ALL',
      period: 'ALL' as const,
      ts: new Date(Date.UTC(2026, 0, index + 1)),
      value: String(100 + index),
    })),
  });
  assert.equal(earlyLowPnl.passed, false);
  assert.ok(earlyLowPnl.failReason?.includes('L1-PNL'));

  // Deep 早杀：大回撤相对净盈 → L1-DD
  const earlyDd = evaluateL1CurveEarlyReject({
    ...l1Base,
    curves: lightDdHeavyCurve,
  });
  assert.equal(earlyDd.passed, false);
  assert.ok(
    earlyDd.failReason?.includes('L1-DD') || earlyDd.failReason?.includes('L1-PNL'),
    `expected L1-DD or L1-PNL, got ${earlyDd.failReason}`
  );

  console.log('smartMoneyTierGate.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
