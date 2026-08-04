/**
 * 本地模拟：验证排行榜需求文档 P0 改动是否生效（无外部 HTTP / 可无真实 DB）。
 * 运行：npx tsx scripts/sim-leaderboard-p0-changes.ts
 */
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://u:p@127.0.0.1:5432/sim_unused';
process.env.CUSTODY_TREASURY_ADDRESS ??= '0x0000000000000000000000000000000000000001';
process.env.RPC_URL ??= 'http://127.0.0.1:8545';
process.env.JWT_SECRET ??= 'sim-test-jwt-secret-not-for-prod';

async function main() {
  const { CONFIG } = await import('../src/config/env');
  const { resolveLeaderboardWinRateMeta, scoreObservedTraderProfile } = await import(
    '../src/services/smartMoney/smartMoneyScorer'
  );
  const { shouldExitCopyPoolForInactivity } = await import(
    '../src/services/smartMoney/smartMoneyCopyPoolInactivity'
  );
  const { buildPositionPnlStats, EMPTY_OPEN_POSITION_STATS } = await import(
    '../src/services/smartMoney/smartMoneyPositionStats'
  );

  const failures: string[] = [];
  const ok = (name: string, cond: boolean, detail?: string) => {
    if (cond) {
      console.log(`  PASS  ${name}`);
    } else {
      const msg = detail ? `${name}: ${detail}` : name;
      failures.push(msg);
      console.log(`  FAIL  ${msg}`);
    }
  };

  console.log('\n=== P0-1 RAW 活跃 cap 默认 1 万 ===');
  ok(
    'SMART_MONEY_RAW_POOL_MAX_ACTIVE default === 10000',
    CONFIG.smartMoneyRawPoolMaxActive === 10_000,
    `got ${CONFIG.smartMoneyRawPoolMaxActive}`
  );

  console.log('\n=== P0-2 停交易出榜配置默认 ===');
  ok(
    'inactive exit days default === 7',
    CONFIG.smartMoneyCopyPoolInactiveExitDays === 7,
    `got ${CONFIG.smartMoneyCopyPoolInactiveExitDays}`
  );
  ok(
    'inactive max holdings default === 1',
    CONFIG.smartMoneyCopyPoolInactiveMaxHoldingsUsd === 1,
    `got ${CONFIG.smartMoneyCopyPoolInactiveMaxHoldingsUsd}`
  );

  console.log('\n=== P0-3 胜率只看已平仓（高 closed + 差 open）===');
  const gapStats = buildPositionPnlStats(
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
  const meta = resolveLeaderboardWinRateMeta({
    externalMetrics: { '7D': null, '30D': null, ALL: null },
    sourceByPeriod: { '7D': 'none', '30D': 'none', ALL: 'none' } as never,
    positionPnlStats: gapStats,
    resolvedTotalPnl: 580,
    preferredCurveValues: [100, 110, 120],
  });
  ok('winRateSource === MARKET_CLOSED', meta.winRateSource === 'MARKET_CLOSED');
  ok(
    'winRate ≈ closed（已平仓市场）',
    meta.winRate != null &&
      Math.abs(meta.winRate - (gapStats.closed?.marketWinRate ?? -1)) < 0.01,
    `got ${meta.winRate}`
  );
  ok(
    'composite 仍低于仅 closed（诊断字段保留）',
    (gapStats.compositeMarketWinRate ?? 1) < 0.5,
    `composite=${gapStats.compositeMarketWinRate}`
  );

  console.log('\n=== P0-4 scoreObservedTraderProfile 写入一致 ===');
  const baseProfile = {
    wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    displayName: null,
    profileImage: null,
    xUsername: null,
    bio: null,
    joinedAt: null,
    joinedAtText: null,
    profileSlug: null,
    snapshotAt: new Date('2026-07-01T00:00:00Z'),
    predictionCount: 40,
    holdingsValue: '8000',
    totalPnl: '1200',
    totalVolume: '50000',
    curves: Array.from({ length: 30 }, (_, i) => ({
      curveType: 'PORTFOLIO_PNL_ALL' as const,
      period: 'ALL' as const,
      ts: new Date(Date.UTC(2026, 0, i + 1)),
      value: String(1000 + i * 10),
    })),
  };
  const observed = {
    wallet: baseProfile.wallet,
    sourceRankWeek: null,
    sourceRankMonth: null,
    sourceRankAll: null,
    officialSourceRankWeek: null,
    officialSourceRankMonth: null,
    officialSourceRankAll: null,
    externalSourceRankWeek: null,
    externalSourceRankMonth: null,
    externalSourceRankAll: null,
    candidatePeriods: ['ALL'],
    candidateCategories: ['OVERALL'],
    blacklisted: false,
    noiseTags: [] as string[],
  };

  const closedDist = {
    sampledMarketCount: 20,
    meanReturn: 0.1,
    medianReturn: 0.08,
    buckets: [],
  };
  const liq = {
    classificationShare: 0.8,
    highVolumeMarketShare: 0.5,
    sampledMarketCount: 20,
    meanVolume: 10000,
  };

  const scored = scoreObservedTraderProfile(
    baseProfile as never,
    observed as never,
    { '7D': null, '30D': null, ALL: null },
    {
      positionPnlStats: gapStats,
      closedMarketReturnDistribution: closedDist as never,
      marketLiquidityProfile: liq as never,
      trades7d: 0,
      trades30d: 2,
      tradesPerDay1D: 0,
    } as never
  );
  ok(
    'externalWinRate ≈ closed',
    scored.externalWinRate != null &&
      Math.abs(scored.externalWinRate - (gapStats.closed?.marketWinRate ?? -1)) < 0.01,
    `got ${scored.externalWinRate}`
  );
  ok('winRateSource MARKET_CLOSED', scored.winRateSource === 'MARKET_CLOSED');
  const displayWr = (scored.scoreExplain as { displayProfile?: { winRate?: number | null } })
    ?.displayProfile?.winRate;
  ok(
    'displayProfile.winRate === closed',
    displayWr != null &&
      Math.abs(displayWr - (gapStats.closed?.marketWinRate ?? -1)) < 0.01,
    `got ${displayWr}`
  );
  ok(
    'OPEN_EXPOSURE_UNDERWATER 风险旗仍在',
    scored.riskFlags.includes('OPEN_EXPOSURE_UNDERWATER'),
    scored.riskFlags.join(',')
  );

  console.log('\n=== P0-5 仅 closed、无 open 时仍可用胜率 ===');
  const closedOnly = buildPositionPnlStats(
    {
      sampleSize: 20,
      marketCount: 20,
      decisiveMarkets: 20,
      winningMarkets: 14,
      losingMarkets: 6,
      marketWinRate: 0.7,
      topMarketPnlShare: 0.2,
      totalRealizedPnl: 5000,
      profitFactor: 1.8,
      profitFactorNoLoss: false,
    },
    EMPTY_OPEN_POSITION_STATS
  );
  const closedMeta = resolveLeaderboardWinRateMeta({
    externalMetrics: { '7D': null, '30D': null, ALL: null },
    sourceByPeriod: { '7D': 'none', '30D': 'none', ALL: 'none' } as never,
    positionPnlStats: closedOnly,
    resolvedTotalPnl: 5000,
    preferredCurveValues: [],
  });
  ok(
    '空 open 时 winRate=0.7',
    closedMeta.winRate != null && Math.abs(closedMeta.winRate - 0.7) < 0.01,
    `got ${closedMeta.winRate}`
  );
  ok('空 open 时 winRateSource=MARKET_CLOSED', closedMeta.winRateSource === 'MARKET_CLOSED');

  console.log('\n=== P0-6 停交易出榜判定 ===');
  const now = new Date('2026-07-23T00:00:00Z');
  ok(
    '空仓+8天无成交 → 出榜',
    shouldExitCopyPoolForInactivity({
      holdingsValueUsd: 0,
      trades7d: 0,
      lastTradeAt: new Date('2026-07-14T00:00:00Z'),
      now,
      exitDays: 7,
      maxHoldingsUsd: 1,
    })
  );
  ok(
    '有持仓 → 不出榜',
    !shouldExitCopyPoolForInactivity({
      holdingsValueUsd: 200,
      trades7d: 0,
      lastTradeAt: new Date('2026-07-01T00:00:00Z'),
      now,
      exitDays: 7,
      maxHoldingsUsd: 1,
    })
  );
  ok(
    '刚停 2 天 → 不出榜',
    !shouldExitCopyPoolForInactivity({
      holdingsValueUsd: 0,
      trades7d: 0,
      lastTradeAt: new Date('2026-07-21T00:00:00Z'),
      now,
      exitDays: 7,
      maxHoldingsUsd: 1,
    })
  );
  ok(
    'exitDays=0 关闭规则',
    !shouldExitCopyPoolForInactivity({
      holdingsValueUsd: 0,
      trades7d: 0,
      lastTradeAt: new Date('2026-01-01T00:00:00Z'),
      now,
      exitDays: 0,
      maxHoldingsUsd: 1,
    })
  );

  console.log('\n=== 汇总 ===');
  if (failures.length) {
    console.error(`FAILED ${failures.length}:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('ALL PASS\n');
  assert.ok(true);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
