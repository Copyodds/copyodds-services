/**
 * 本地模拟：拉 Data API closed-positions → 新口径分布 → 评分 displayProfile
 * npx tsx scripts/sim-closed-return-metrics.ts --wallet=0x...
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import assert from 'node:assert/strict';

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length).trim();
  }
  return null;
}

function pct(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(2)}%`;
}

async function main() {
  const { fetchDataApiClosedPositions } = await import('../src/services/polymarket/polymarketData.js');
  const {
    buildClosedMarketReturnDistribution,
    findMaxInvestedClosedMarket,
  } = await import('../src/services/smartMoney/smartMoneyPositionStats.js');
  const { resolveCanonicalBoardMetrics } = await import(
    '../src/services/smartMoney/smartMoneyCanonicalBoardMetrics.js'
  );
  const { scoreObservedTraderProfile } = await import('../src/services/smartMoney/smartMoneyScorer.js');

  const wallet = (
    getArg('wallet') ?? '0x56687bf447db6ffa42ffe2204a05edaa20f55839'
  ).toLowerCase();

  console.log(`\n=== sim closed-return metrics: ${wallet} ===\n`);

  // —— 1) 合成样本：自检聚合与无 volume 回退 ——
  const nowMs = Date.now();
  const ts = Math.floor(nowMs / 1000) - 5 * 24 * 3600;
  const synthetic = [
    { conditionId: 'a', initialValue: 1000, realizedPnl: 200, timestamp: ts },
    { conditionId: 'b', initialValue: 100, realizedPnl: 300, timestamp: ts },
    { conditionId: 'c', initialValue: 400, realizedPnl: -50, timestamp: ts },
    { conditionId: 'c', initialValue: 100, realizedPnl: -50, timestamp: ts },
  ] as never[];
  const synDist = buildClosedMarketReturnDistribution(synthetic, 365, nowMs);
  assert.ok(synDist);
  // markets: a 20%, b 300%, c (500 cost, -100 pnl) = -20%
  // total: (200+300-100)/(1000+100+500)=400/1600=0.25
  // mean: (0.2+3+(-0.2))/3 = 1
  assert.ok(Math.abs((synDist!.totalReturnRatio ?? -1) - 0.25) < 1e-6, 'synthetic total');
  assert.ok(Math.abs((synDist!.meanReturn ?? -1) - 1) < 1e-6, 'synthetic mean');
  const synBoard = resolveCanonicalBoardMetrics({
    totalPnl: 999_999,
    totalVolume: 10_000_000,
    closedWindowReturn: {
      totalReturnRatio: synDist!.totalReturnRatio,
      returnPrincipalUsd: synDist!.totalCostBasisUsd,
    },
    metricsSource: 'LOCAL_FALLBACK',
  });
  assert.equal(synBoard.returnPrincipalSource, 'CLOSED_COST');
  assert.equal(synBoard.totalReturnRatio, 0.25);
  // 无 closedWindow → 不得用 volume
  const noClosed = resolveCanonicalBoardMetrics({
    totalPnl: 50_000,
    totalVolume: 1_000_000,
    holdingsValue: 10_000,
    metricsSource: 'LOCAL_FALLBACK',
  });
  assert.equal(noClosed.totalReturnRatio, null);
  console.log('synthetic self-check: OK');
  console.log(
    `  total=${pct(synDist!.totalReturnRatio)} mean=${pct(synDist!.meanReturn)} n=${synDist!.sampledMarketCount}`
  );

  // —— 2) 实盘 closed-positions ——
  let closedRows: Awaited<ReturnType<typeof fetchDataApiClosedPositions>>['rows'] = [];
  try {
    const fetched = await fetchDataApiClosedPositions(wallet, { maxPages: 20 });
    closedRows = fetched.rows;
  } catch (e) {
    console.warn('live fetch failed (network?), skip live section:', e);
    console.log('\nsim-closed-return-metrics: partial OK (synthetic only)');
    return;
  }
  console.log(`\nlive closed rows: ${closedRows.length}`);
  const dist = buildClosedMarketReturnDistribution(closedRows);
  const maxInv = findMaxInvestedClosedMarket(closedRows);
  console.log('distribution:', {
    markets: dist?.sampledMarketCount ?? null,
    totalReturn: pct(dist?.totalReturnRatio),
    meanReturn: pct(dist?.meanReturn),
    medianReturn: pct(dist?.medianReturn),
    sumPnl: dist?.totalRealizedPnl ?? null,
    sumCost: dist?.totalCostBasisUsd ?? null,
  });
  console.log('max invested:', maxInv);

  if (dist?.totalReturnRatio != null && dist.totalCostBasisUsd != null) {
    const manual = (dist.totalRealizedPnl ?? 0) / dist.totalCostBasisUsd;
    assert.ok(
      Math.abs(manual - dist.totalReturnRatio) < 0.0002,
      `totalReturn should equal Σpnl/Σcost: ${manual} vs ${dist.totalReturnRatio}`
    );
  }

  const board = resolveCanonicalBoardMetrics({
    totalPnl: dist?.totalRealizedPnl ?? null,
    totalVolume: 1_000_000,
    closedWindowReturn: dist
      ? {
          totalReturnRatio: dist.totalReturnRatio,
          returnPrincipalUsd: dist.totalCostBasisUsd,
        }
      : null,
    metricsSource: 'LOCAL_FALLBACK',
  });
  assert.equal(board.totalReturnRatio, dist?.totalReturnRatio ?? null);
  assert.equal(
    board.returnPrincipalSource,
    dist?.totalReturnRatio != null ? 'CLOSED_COST' : null
  );

  // —— 3) 打分链路 displayProfile ——
  const curve = Array.from({ length: 30 }, (_, i) => ({
    curveType: 'PORTFOLIO_PNL_ALL' as const,
    period: 'ALL' as const,
    ts: new Date(Date.UTC(2026, 0, i + 1)),
    value: String(10_000 + i * 100),
  }));
  const score = scoreObservedTraderProfile(
    {
      wallet,
      profileSlug: null,
      displayName: 'sim',
      username: null,
      xUsername: null,
      profileImage: null,
      joinedAtText: null,
      viewsText: null,
      holdingsValue: '50000',
      biggestWin: null,
      predictionCount: 100,
      totalPnl: String(dist?.totalRealizedPnl ?? 1000),
      totalVolume: '500000',
      sourceUrl: 'https://polymarket.com',
      snapshotAt: new Date(),
      profilePnlApiFilledPeriods: [],
      rawSummary: {},
      curves: curve,
    },
    {
      wallet,
      sourceRankWeek: 10,
      sourceRankMonth: 10,
      sourceRankAll: 10,
      officialSourceRankWeek: 10,
      officialSourceRankMonth: 10,
      officialSourceRankAll: 10,
      externalSourceRankWeek: 10,
      externalSourceRankMonth: 10,
      externalSourceRankAll: 10,
      candidatePeriods: ['ALL'],
      candidateCategories: ['OVERALL'],
      blacklisted: false,
      noiseTags: [],
    },
    { '7D': null, '30D': null, ALL: null },
    {
      closedMarketReturnDistribution: dist,
      closedRows,
    }
  );

  const explain = score.scoreExplain as {
    displayProfile?: Record<string, unknown>;
    canonicalBoardMetrics?: Record<string, unknown>;
  };
  const dp = explain.displayProfile ?? {};
  console.log('\nscore displayProfile:', {
    totalReturnRatio: dp.totalReturnRatio,
    avgClosedReturnRate: dp.avgClosedReturnRate,
    returnPrincipalSource: dp.returnPrincipalSource,
    totalPnl1y: dp.totalPnl1y,
    metricsReturn: (dp.metricsSource as { return?: string } | undefined)?.return,
  });
  console.log('leaderboard externalTotalReturn (display points):', score.externalTotalReturn);

  assert.equal(dp.totalReturnRatio ?? null, dist?.totalReturnRatio ?? null);
  assert.equal(dp.avgClosedReturnRate ?? null, dist?.meanReturn ?? null);
  if (dist?.totalReturnRatio != null) {
    assert.equal(dp.returnPrincipalSource, 'CLOSED_COST');
    assert.ok(
      score.externalTotalReturn != null &&
        Math.abs(score.externalTotalReturn - dist.totalReturnRatio * 100) < 0.15
    );
  } else {
    assert.equal(score.externalTotalReturn, null);
  }

  console.log('\nsim-closed-return-metrics: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
