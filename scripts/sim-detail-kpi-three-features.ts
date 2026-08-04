/**
 * Offline E2E check for detail KPIs:
 * 1) keep total profit % + avgClosedReturnRate
 * 2) profitFactor win/loss counts
 * 3) max invested closed market
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import assert from 'node:assert/strict';
import {
  buildClosedMarketReturnDistribution,
  buildPositionPnlStats,
  findMaxInvestedClosedMarket,
  summarizeClosedPositionPnlStats,
  summarizeOpenPositionPnlStats,
} from '../src/services/smartMoney/smartMoneyPositionStats';
import { scoreObservedTraderProfile } from '../src/services/smartMoney/smartMoneyScorer';

const nowMs = Date.UTC(2026, 6, 25);
const within = Math.floor(nowMs / 1000) - 30 * 24 * 60 * 60;
const closedRows = [
  {
    conditionId: 'm1',
    avgPrice: 0.5,
    totalBought: 200,
    realizedPnl: 40,
    title: 'Market A',
    timestamp: within,
    percentPnl: 0.4,
  },
  {
    conditionId: 'm2',
    avgPrice: 0.4,
    totalBought: 1000,
    realizedPnl: -120,
    title: 'Market Big',
    timestamp: within,
    percentPnl: -0.3,
  },
  {
    conditionId: 'm3',
    avgPrice: 0.6,
    totalBought: 100,
    realizedPnl: 30,
    title: 'Market C',
    timestamp: within,
    percentPnl: 0.5,
  },
  {
    conditionId: 'm4',
    avgPrice: 0.55,
    totalBought: 80,
    realizedPnl: -10,
    title: 'Market D',
    timestamp: within,
    percentPnl: -0.227,
  },
] as never[];

const closed = summarizeClosedPositionPnlStats(closedRows);
assert.equal(closed.winningMarkets, 2, `winningMarkets=${closed.winningMarkets}`);
assert.equal(closed.losingMarkets, 2, `losingMarkets=${closed.losingMarkets}`);
assert.ok(closed.profitFactor != null && closed.profitFactor > 0, `pf=${closed.profitFactor}`);

const dist = buildClosedMarketReturnDistribution(closedRows);
assert.ok(dist && dist.meanReturn != null, 'meanReturn missing');

const maxInv = findMaxInvestedClosedMarket(closedRows, 365, nowMs);
assert.ok(maxInv, 'maxInvested missing');
assert.equal(maxInv!.conditionId, 'm2');
assert.equal(maxInv!.costBasisUsd, 400);
assert.equal(maxInv!.realizedPnl, -120);
assert.equal(maxInv!.title, 'Market Big');

const positionPnlStats = buildPositionPnlStats(closed, summarizeOpenPositionPnlStats([]));
const observed = {
  wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  displayName: 'sim',
  profileSlug: null,
  profileImage: null,
  xUsername: null,
  sourceRankWeek: null,
  sourceRankMonth: null,
  sourceRankAll: 1,
  officialSourceRankWeek: null,
  officialSourceRankMonth: null,
  officialSourceRankAll: 1,
  externalSourceRankWeek: null,
  externalSourceRankMonth: null,
  externalSourceRankAll: null,
  candidatePeriods: ['ALL'],
  candidateCategories: ['OVERALL'],
  noiseTags: [] as string[],
};
const profile = {
  wallet: observed.wallet,
  displayName: 'sim',
  profileSlug: null,
  joinedAtText: '1 year ago',
  profileImage: null,
  xUsername: null,
  predictionCount: 40,
  holdingsValue: '5000',
  totalPnl: '2000',
  totalVolume: '50000',
  biggestWin: null,
  curves: Array.from({ length: 30 }, (_, i) => ({
    curveType: 'PORTFOLIO_PNL_ALL',
    period: 'ALL',
    ts: new Date(Date.UTC(2026, 0, i + 1)),
    value: String(1000 + i * 30),
  })),
  snapshotAt: new Date(nowMs),
};

const scored = scoreObservedTraderProfile(
  profile as never,
  observed as never,
  { '7D': null, '30D': null, ALL: null },
  {
    positionPnlStats,
    closedMarketReturnDistribution: dist,
    closedRows,
    closedFetchOk: true,
    copyabilityScore: 55,
  }
);

const dp = (scored.scoreExplain as { displayProfile?: Record<string, unknown> }).displayProfile;
assert.ok(dp, 'displayProfile missing');

const snippet = {
  avgClosedReturnRate: dp.avgClosedReturnRate,
  winMarketCount: dp.winMarketCount,
  lossMarketCount: dp.lossMarketCount,
  profitFactor: dp.profitFactor,
  maxInvestedCostUsd: dp.maxInvestedCostUsd,
  maxInvestedRealizedPnl: dp.maxInvestedRealizedPnl,
  maxInvestedTitle: dp.maxInvestedTitle,
  externalTotalReturn: scored.externalTotalReturn,
};
console.log('displayProfile snippet:', JSON.stringify(snippet, null, 2));

assert.equal(dp.winMarketCount, 2);
assert.equal(dp.lossMarketCount, 2);
assert.ok(dp.avgClosedReturnRate != null);
assert.equal(dp.maxInvestedCostUsd, 400);
assert.equal(dp.maxInvestedRealizedPnl, -120);
assert.equal(dp.maxInvestedTitle, 'Market Big');
assert.ok(scored.externalTotalReturn != null, 'total profit % should remain');

console.log('E2E sim: all three features OK');
