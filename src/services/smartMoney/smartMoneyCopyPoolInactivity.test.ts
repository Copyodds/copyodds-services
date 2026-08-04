import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldExitCopyPoolForInactivity } from './smartMoneyCopyPoolInactivity';

test('shouldExitCopyPoolForInactivity: flat + stale lastTrade', () => {
  const now = new Date('2026-07-23T00:00:00.000Z');
  assert.equal(
    shouldExitCopyPoolForInactivity({
      holdingsValueUsd: 0,
      trades7d: 0,
      lastTradeAt: new Date('2026-07-10T00:00:00.000Z'),
      now,
      exitDays: 7,
      maxHoldingsUsd: 1,
    }),
    true
  );
  assert.equal(
    shouldExitCopyPoolForInactivity({
      holdingsValueUsd: 500,
      trades7d: 0,
      lastTradeAt: new Date('2026-07-10T00:00:00.000Z'),
      now,
      exitDays: 7,
      maxHoldingsUsd: 1,
    }),
    false
  );
  assert.equal(
    shouldExitCopyPoolForInactivity({
      holdingsValueUsd: 0,
      trades7d: 0,
      lastTradeAt: new Date('2026-07-20T00:00:00.000Z'),
      now,
      exitDays: 7,
      maxHoldingsUsd: 1,
    }),
    false
  );
});

test('shouldExitCopyPoolForInactivity: trades7d fallback without lastTradeAt', () => {
  assert.equal(
    shouldExitCopyPoolForInactivity({
      holdingsValueUsd: 0,
      trades7d: 0,
      lastTradeAt: null,
      exitDays: 7,
      maxHoldingsUsd: 1,
    }),
    true
  );
  assert.equal(
    shouldExitCopyPoolForInactivity({
      holdingsValueUsd: 0,
      trades7d: 3,
      lastTradeAt: null,
      exitDays: 7,
      maxHoldingsUsd: 1,
    }),
    false
  );
});
