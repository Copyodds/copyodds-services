import assert from 'node:assert/strict';
import {
  buildTradeActivitySeries,
  MAX_DENSE_TRADE_SERIES_DAYS,
  resolveTradeActivityWindow,
} from './smartMoneyTradeActivity';
import type { DataApiTrade } from '../polymarket/polymarketTrades';

function tradeAt(iso: string): DataApiTrade {
  return { timestamp: Math.floor(Date.parse(iso) / 1000) };
}

const windowStart = Date.parse('2026-06-19T12:00:00.000Z');
const windowEnd = Date.parse('2026-06-21T18:00:00.000Z');

const series = buildTradeActivitySeries(
  [
    tradeAt('2026-06-19T15:00:00.000Z'),
    tradeAt('2026-06-19T16:00:00.000Z'),
    tradeAt('2026-06-21T10:00:00.000Z'),
  ],
  windowStart,
  windowEnd
);

assert.equal(series.length, 3);
assert.equal(series[0].date, '2026-06-19');
assert.equal(series[0].count, 2);
assert.equal(series[0].cumulative, 2);
assert.equal(series[1].date, '2026-06-20');
assert.equal(series[1].count, 0);
assert.equal(series[1].cumulative, 2);
assert.equal(series[2].date, '2026-06-21');
assert.equal(series[2].count, 1);
assert.equal(series[2].cumulative, 3);

const sparse = buildTradeActivitySeries(
  [
    tradeAt('2026-06-19T15:00:00.000Z'),
    tradeAt('2026-06-21T10:00:00.000Z'),
  ],
  windowStart,
  windowEnd,
  { fillEmptyDays: false }
);
assert.equal(sparse.length, 2);
assert.equal(sparse[0].date, '2026-06-19');
assert.equal(sparse[0].count, 1);
assert.equal(sparse[0].cumulative, 1);
assert.equal(sparse[1].date, '2026-06-21');
assert.equal(sparse[1].count, 1);
assert.equal(sparse[1].cumulative, 2);

const allWindowStart = Date.parse('1970-01-01T00:00:00.000Z');
const allWindowEnd = Date.parse('2026-06-30T15:00:00.000Z');
const allSpanDays =
  Math.floor((allWindowEnd - allWindowStart) / (24 * 60 * 60 * 1000)) + 1;
assert.ok(allSpanDays > MAX_DENSE_TRADE_SERIES_DAYS);

const allSeries = buildTradeActivitySeries(
  [
    tradeAt('2024-01-10T12:00:00.000Z'),
    tradeAt('2024-01-10T13:00:00.000Z'),
    tradeAt('2025-06-01T08:00:00.000Z'),
  ],
  allWindowStart,
  allWindowEnd
);
assert.equal(
  allSeries.length,
  2,
  'ALL-length windows must not fill empty days from epoch'
);
assert.equal(allSeries[0].date, '2024-01-10');
assert.equal(allSeries[0].count, 2);
assert.equal(allSeries[0].cumulative, 2);
assert.equal(allSeries[1].date, '2025-06-01');
assert.equal(allSeries[1].count, 1);
assert.equal(allSeries[1].cumulative, 3);

const nowMs = Date.parse('2026-06-30T15:00:00.000Z');
const curveCoverage = {
  startTs: '2026-06-29T00:00:00.000Z',
  endTs: '2026-06-30T00:00:00.000Z',
};
const window1D = resolveTradeActivityWindow('1D', curveCoverage, nowMs);
assert.ok(window1D);
assert.equal(window1D.windowEndTs, new Date(nowMs).toISOString());
assert.equal(
  window1D.windowStartTs,
  new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(),
  '1D trade window should be rolling 24h, not curve day-boundary span'
);

const windowAll = resolveTradeActivityWindow('ALL', curveCoverage, nowMs);
assert.ok(windowAll);
assert.equal(windowAll.windowStartTs, new Date(0).toISOString());
assert.equal(
  windowAll.windowEndTs,
  new Date(nowMs).toISOString(),
  'ALL trade fetch window should be full history, not curve coverage'
);

console.log('smartMoneyTradeActivity.test.ts: ok');
