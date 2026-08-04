import assert from 'node:assert/strict';
import {
  computeCurveWindowPnlChange,
  computeRecentPnl7d,
  computeTotalPnl1y,
} from './smartMoneyBoardWindowMetrics';

function makeProfile(points: Array<{ period: '1W' | 'ALL'; day: number; value: number }>) {
  return {
    wallet: '0xtest',
    profileSlug: null,
    displayName: null,
    username: null,
    xUsername: null,
    profileImage: null,
    joinedAtText: null,
    viewsText: null,
    holdingsValue: '5000',
    biggestWin: null,
    predictionCount: 20,
    totalPnl: null,
    totalVolume: null,
    sourceUrl: 'https://polymarket.com/profile/test',
    snapshotAt: new Date(),
    curves: points.map((p) => ({
      curveType: p.period === '1W' ? 'PORTFOLIO_PNL_1W' : 'PORTFOLIO_PNL_ALL',
      period: p.period,
      ts: new Date(Date.UTC(2025, 0, p.day)),
      value: String(p.value),
    })),
    profilePnlApiFilledPeriods: [],
    rawSummary: {},
  };
}

assert.equal(computeCurveWindowPnlChange([10, 20, 35]), 25);
assert.equal(computeCurveWindowPnlChange([1]), null);

const recent = computeRecentPnl7d(
  makeProfile([
    { period: '1W', day: 1, value: 100 },
    { period: '1W', day: 7, value: 180 },
  ])
);
assert.equal(recent, 80);

const pnl1y = computeTotalPnl1y(
  makeProfile([
    { period: 'ALL', day: 1, value: 0 },
    { period: 'ALL', day: 100, value: 500 },
    { period: 'ALL', day: 200, value: 1200 },
  ]),
  Date.UTC(2025, 0, 200)
);
assert.ok(pnl1y.totalPnl1y != null && pnl1y.totalPnl1y > 0);
assert.ok(pnl1y.pnlWindowDays != null && pnl1y.pnlWindowDays >= 1);

console.log('smartMoneyBoardWindowMetrics.test.ts: ok');
