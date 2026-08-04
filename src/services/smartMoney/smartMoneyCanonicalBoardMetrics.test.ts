import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
// 本用例验证「开启比例尺 L1-DD 时，展示对齐的 MDD>回报会硬杀」；美元门另测
process.env.SMART_MONEY_L1_MAX_DD_LE_RETURN = 'true';
process.env.SMART_MONEY_L1_MAX_DD_USD_LT_PNL = 'false';

async function main(): Promise<void> {
  const {
    resolveCanonicalBoardMetrics,
    readCanonicalBoardMetrics,
    computeCapitalReturnRatio,
    computeTurnoverReturnRatio,
    computeDollarMaxDrawdown,
    computeCapitalNormalizedDrawdown,
    computePeakEquityMaxDrawdown,
  } = await import('./smartMoneyCanonicalBoardMetrics');
  const { evaluateL1CandidateGate } = await import('./smartMoneyTierGate');

  // 成本优先于权益：取较大占用
  const capital = computeCapitalReturnRatio({
    totalPnl: 5_000,
    costBasis: 20_000,
    holdingsValue: 8_000,
  });
  assert.equal(capital.principalSource, 'COST_BASIS');
  assert.ok(capital.ratio != null && Math.abs(capital.ratio - 0.25) < 1e-6);

  // 仅权益
  const holdingsOnly = computeCapitalReturnRatio({
    totalPnl: 50_000,
    costBasis: null,
    holdingsValue: 200_000,
  });
  assert.equal(holdingsOnly.principalSource, 'HOLDINGS');
  assert.ok(holdingsOnly.ratio != null && Math.abs(holdingsOnly.ratio - 0.25) < 1e-6);

  // 成交量不进总回报
  const noCapital = computeCapitalReturnRatio({
    totalPnl: 50_000,
    costBasis: null,
    holdingsValue: null,
  });
  assert.equal(noCapital.ratio, null);

  const turnover = computeTurnoverReturnRatio({
    totalPnl: 50_000,
    totalVolume: 2_000_000,
  });
  assert.ok(turnover != null && Math.abs(turnover - 0.025) < 1e-6);

  // 美元回撤（辅）
  const ddUsd = computeDollarMaxDrawdown([100, 200, 50, 180]);
  assert.equal(ddUsd, 150);

  // 峰权益 MDD：(200-50)/200 = 0.75；忽略早期小峰值噪声
  const peakTiny = computePeakEquityMaxDrawdown([0.5, 0, 1000, 900]);
  assert.ok(peakTiny.maxDrawdownPercent != null);
  assert.ok(Math.abs((peakTiny.maxDrawdownPercent ?? 0) - 0.1) < 1e-6);
  assert.ok(peakTiny.maxDrawdownUsd != null && Math.abs((peakTiny.maxDrawdownUsd ?? 0) - 100) < 1e-6);

  const peakNone = computePeakEquityMaxDrawdown([0, -100, -50]);
  assert.equal(peakNone.maxDrawdownPercent, null);
  assert.equal(peakNone.maxDrawdownUsd, null);

  // 美元最大跌 vs 比率最大：可不属于同一段
  // 小峰 1200→0 → 比率 100% / $1200；大峰 16800→6200 → 比率~63% / $10600
  const split = computePeakEquityMaxDrawdown([1200, 0, 16800, 6200]);
  assert.ok(split.maxDrawdownPercent != null && Math.abs((split.maxDrawdownPercent ?? 0) - 1) < 1e-6);
  assert.ok(split.maxDrawdownUsd != null && Math.abs((split.maxDrawdownUsd ?? 0) - 10600) < 1e-6);
  assert.ok(split.peakEquityUsd != null && Math.abs((split.peakEquityUsd ?? 0) - 1200) < 1e-6);

  const normDd = computeCapitalNormalizedDrawdown({
    maxDrawdownUsd: 150,
    holdingsValue: 1_000,
  });
  assert.ok(normDd.ratio != null && Math.abs(normDd.ratio - 0.15) < 1e-6);

  // 本金相对回撤过小 → null（旧资本归一化仍保留行为）
  const tiny = computeCapitalNormalizedDrawdown({
    maxDrawdownUsd: 50_000,
    holdingsValue: 200,
  });
  assert.equal(tiny.ratio, null);

  const board = resolveCanonicalBoardMetrics({
    totalPnl: 50_000,
    totalVolume: 2_000_000,
    holdingsValue: 200_000,
    closedWindowReturn: {
      totalReturnRatio: 0.25,
      returnPrincipalUsd: 200_000,
    },
    pnlCurveValues: [100_000, 150_000, 80_000, 120_000],
    metricsSource: 'LOCAL_FALLBACK',
  });
  assert.ok(board.totalReturnRatio != null);
  assert.ok(Math.abs((board.totalReturnRatio ?? 0) - 0.25) < 1e-6);
  assert.equal(board.returnPrincipalSource, 'CLOSED_COST');
  assert.ok(board.turnoverReturnRatio != null);
  assert.equal(board.maxDrawdownUsd, 70_000);
  // 峰权益 MDD：(150k-80k)/150k ≈ 0.4667（不再用 70k/200k=0.35）
  assert.ok(
    board.maxDrawdownPercent != null && Math.abs(board.maxDrawdownPercent - 0.4667) < 1e-4,
    `expected peak-equity MDD ~0.4667, got ${board.maxDrawdownPercent}`
  );

  // 外部夸张值不得污染总回报；须显式传入 closedWindowReturn
  const ignoreExternal = resolveCanonicalBoardMetrics({
    totalPnl: 50_000,
    totalVolume: 2_000_000,
    holdingsValue: 200_000,
    closedWindowReturn: {
      totalReturnRatio: 0.25,
      returnPrincipalUsd: 200_000,
    },
    primaryTotalReturn: 7.5,
    effectiveMaxDrawdown: 0.99,
    pnlCurveValues: [100_000, 120_000],
    metricsSource: 'PREDICTING_TOP',
  });
  assert.ok(Math.abs((ignoreExternal.totalReturnRatio ?? 0) - 0.25) < 1e-6);

  // 无已平仓窗口回报 → 总回报 null；成交利润率仍可单独存在，禁止静默回退
  const mismatched = resolveCanonicalBoardMetrics({
    totalPnl: 37_990,
    totalVolume: 341_641,
    costBasis: 17_456,
    holdingsValue: 9_976,
    pnlCurveValues: [10_000, 40_000, 36_000],
    metricsSource: 'LOCAL_FALLBACK',
  });
  assert.equal(mismatched.totalReturnRatio, null);
  assert.equal(mismatched.returnPrincipalSource, null);
  assert.ok(
    mismatched.turnoverReturnRatio != null &&
      Math.abs(mismatched.turnoverReturnRatio - 0.1112) < 0.01,
    `expected turnover ~11% as side metric, got ${mismatched.turnoverReturnRatio}`
  );

  const profile = {
    wallet: '0x0000000000000000000000000000000000000001',
    profileSlug: null,
    displayName: null,
    username: null,
    xUsername: null,
    profileImage: null,
    joinedAtText: null,
    viewsText: null,
    holdingsValue: '200000',
    biggestWin: null,
    predictionCount: 50,
    totalPnl: '50000',
    totalVolume: '2000000',
    sourceUrl: 'https://polymarket.com/profile/test',
    snapshotAt: new Date(),
    curves: Array.from({ length: 25 }, (_, index) => ({
      curveType: 'PORTFOLIO_PNL_ALL',
      period: 'ALL' as const,
      ts: new Date(Date.UTC(2026, 0, index + 1)),
      value: String(100_000 + index * 1000),
    })),
    profilePnlApiFilledPeriods: [],
    rawSummary: {},
  };

  const l1Quality = {
    winRate: 0.55,
    profitFactor: 1.8,
    trades30d: 12,
    closedMarketCount: 20,
  };

  const l1 = evaluateL1CandidateGate({
    profile,
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.25,
    effectiveMaxDrawdown: 0.5,
    ...l1Quality,
  });
  assert.equal(l1.passed, false);
  assert.ok(l1.failReason?.includes('L1-DD'));

  // MDD=100% 如实保留；本文件开启比例尺时 MDD>回报 → L1-DD
  const l1Saturated = evaluateL1CandidateGate({
    profile,
    resolvedTotalPnl: 50_000,
    totalVolume: 2_000_000,
    effectiveTotalReturn: 0.25,
    effectiveMaxDrawdown: 1,
    ...l1Quality,
  });
  assert.equal(l1Saturated.passed, false);
  assert.ok(l1Saturated.failReason?.includes('L1-DD'));
  assert.equal(l1Saturated.failReason?.includes('L1-MDD-PCT') ?? false, false);

  const readBack = readCanonicalBoardMetrics({ canonicalBoardMetrics: board });
  assert.equal(readBack?.returnPrincipalSource, 'CLOSED_COST');
  assert.equal(readBack?.turnoverReturnRatio, board.turnoverReturnRatio);

  console.log('smartMoneyCanonicalBoardMetrics.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
