import assert from 'node:assert/strict';
import {
  extractClosedPositionAtMs,
  isClosedPositionsPageBeforeWindow,
  type DataApiPosition,
} from './polymarketData.js';

function row(partial: Record<string, unknown>): DataApiPosition {
  return {
    asset: 'a',
    conditionId: 'c',
    size: 0,
    redeemable: true,
    ...partial,
  };
}

{
  const ms = extractClosedPositionAtMs(row({ timestamp: 1_700_000_000 }));
  assert.ok(ms != null && ms > 1e12);
}

{
  const cutoff = Date.parse('2025-01-01T00:00:00.000Z');
  const before = [
    row({ endDate: '2024-06-01T00:00:00.000Z' }),
    row({ endDate: '2024-12-01T00:00:00.000Z' }),
  ];
  const mixed = [
    row({ endDate: '2025-06-01T00:00:00.000Z' }),
    row({ endDate: '2024-06-01T00:00:00.000Z' }),
  ];
  assert.equal(isClosedPositionsPageBeforeWindow(before, cutoff), true);
  assert.equal(isClosedPositionsPageBeforeWindow(mixed, cutoff), false);
  assert.equal(isClosedPositionsPageBeforeWindow([row({})], cutoff), false);
}

console.log('polymarketData.closedPositions.test: OK');
