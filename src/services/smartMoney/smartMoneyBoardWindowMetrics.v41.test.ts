import assert from 'node:assert/strict';
import type { PolymarketProfileFetchResult } from '../polymarket/polymarketProfile';
import { computeBoardPnlWindowMetrics } from './smartMoneyBoardWindowMetrics';

const now = Date.UTC(2026, 6, 17);
const day = 24 * 60 * 60 * 1000;
const points = Array.from({ length: 366 }, (_, index) => ({
  period: 'ALL' as const,
  curveType: 'PORTFOLIO_PNL_ALL',
  ts: new Date(now - (365 - index) * day),
  value: String(index * 10 - (index === 340 ? 500 : 0)),
}));
const week = Array.from({ length: 8 }, (_, index) => ({
  period: '1W' as const,
  curveType: 'PORTFOLIO_PNL_1W',
  ts: new Date(now - (7 - index) * day),
  value: String(index * 20 - (index === 7 ? 200 : 0)),
}));
const profile = { curves: [...points, ...week] } as PolymarketProfileFetchResult;

const result = computeBoardPnlWindowMetrics(profile, 10_000, now);
assert.equal(result.pnl1y.actualWindowDays, 365);
assert.equal(result.pnl1y.pnlUsd, 3650);
assert.equal(result.pnl1y.returnRatio, 0.365);
assert.ok((result.pnl1y.maxDrawdownUsd ?? 0) > 0);
assert.equal(result.pnl30d.actualWindowDays, 30);
assert.equal(result.pnl30d.pnlUsd, 300);
assert.equal(result.pnl7d.actualWindowDays, 7);
assert.ok((result.pnl7d.pnlUsd ?? 0) < 0);

console.log('smartMoneyBoardWindowMetrics.v41.test.ts: ok');
