import assert from 'node:assert/strict';
import {
  formatSmartMoneyProfileClosedPosition,
  summarizeSmartMoneyProfileClosedPositions,
} from './smartMoneyProfileClosedPositionFormat';
import type { DataApiPosition } from '../polymarket/polymarketData';

const formatted = formatSmartMoneyProfileClosedPosition({
  asset: 'token-a',
  conditionId: 'condition-a',
  title: 'Will X happen?',
  slug: 'will-x-happen',
  eventSlug: 'x-event',
  outcome: 'Yes',
  outcomeIndex: 0,
  totalBought: 100,
  avgPrice: 0.4,
  realizedPnl: 60,
  timestamp: 1_700_000_000,
  endDate: '2023-11-14T00:00:00Z',
} as DataApiPosition);

assert.equal(formatted.totalBought, 100);
assert.equal(formatted.realizedPnl, 60);
assert.equal(formatted.realizedPnlRatio, 1.5);
assert.equal(formatted.closedAt, '2023-11-14T00:00:00.000Z');
assert.equal(formatted.eventSlug, 'x-event');

const explicitPercent = formatSmartMoneyProfileClosedPosition({
  asset: 'token-b',
  conditionId: 'condition-b',
  totalBought: 10,
  avgPrice: 0.5,
  realizedPnl: -2,
  percentRealizedPnl: -40,
} as DataApiPosition);

assert.equal(explicitPercent.realizedPnlRatio, -0.4);

const partialSummary = summarizeSmartMoneyProfileClosedPositions(
  [formatted, explicitPercent],
  true
);
assert.equal(partialSummary.sampleRealizedPnl, 58);
assert.equal(partialSummary.totalRealizedPnl, null);
assert.equal(partialSummary.complete, false);

const completeSummary = summarizeSmartMoneyProfileClosedPositions(
  [formatted, explicitPercent],
  false
);
assert.equal(completeSummary.totalRealizedPnl, 58);
assert.equal(completeSummary.complete, true);
