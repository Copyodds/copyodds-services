import assert from 'node:assert/strict';
import { COPY_UNKNOWN_ERROR_CODE, copyTradeRetryDelayMs } from './copyRetryPolicy';
import {
  allowNoRowsRedispatch,
  shouldReenqueueFromCounts,
} from './leaderTradeReenqueueLogic';
import { isEligibleForRetrySweep, type CopyRetrySweepConfig } from './retrySweepLogic';

const SWEEP_CFG: CopyRetrySweepConfig = {
  copyMaxRetries: 3,
  copyRetryBaseDelayMs: 2000,
  copyRetryMaxDelayMs: 120_000,
};

function row(partial: {
  errorCode: string | null;
  retryCount: number;
  updatedAtMs: number;
}) {
  return {
    errorCode: partial.errorCode,
    retryCount: partial.retryCount,
    updatedAt: new Date(partial.updatedAtMs),
  };
}

function testSweepNonRetryable() {
  const now = 100_000;
  assert.equal(
    isEligibleForRetrySweep(
      row({ errorCode: 'user_insufficient_balance', retryCount: 1, updatedAtMs: 0 }),
      now,
      SWEEP_CFG
    ),
    false
  );
}

function testSweepUnknownWithBackoff() {
  const now = 100_000;
  const delay = copyTradeRetryDelayMs(1, { base: 2000, max: 120_000 });
  assert.equal(delay, 2000);

  assert.equal(
    isEligibleForRetrySweep(
      row({ errorCode: COPY_UNKNOWN_ERROR_CODE, retryCount: 1, updatedAtMs: now - delay - 1 }),
      now,
      SWEEP_CFG
    ),
    true
  );

  assert.equal(
    isEligibleForRetrySweep(
      row({ errorCode: COPY_UNKNOWN_ERROR_CODE, retryCount: 1, updatedAtMs: now - delay + 100 }),
      now,
      SWEEP_CFG
    ),
    false
  );
}

function testSweepMaxRetries() {
  const now = 100_000;
  assert.equal(
    isEligibleForRetrySweep(
      row({ errorCode: COPY_UNKNOWN_ERROR_CODE, retryCount: 3, updatedAtMs: 0 }),
      now,
      SWEEP_CFG
    ),
    false
  );
}

function testSweepBackoffExponents() {
  assert.equal(copyTradeRetryDelayMs(1, { base: 1000, max: 120_000 }), 1000);
  assert.equal(copyTradeRetryDelayMs(2, { base: 1000, max: 120_000 }), 2000);
  assert.equal(copyTradeRetryDelayMs(3, { base: 1000, max: 120_000 }), 4000);
}

function testReenqueueQueued() {
  assert.equal(
    shouldReenqueueFromCounts({
      noRowsWithEnabledSubs: false,
      queuedCount: 1,
      submittingStaleCount: 0,
      hasRetryableFailedUnderMax: false,
    }),
    true
  );
}

function testReenqueueSubmittingNotStale() {
  assert.equal(
    shouldReenqueueFromCounts({
      noRowsWithEnabledSubs: false,
      queuedCount: 0,
      submittingStaleCount: 0,
      hasRetryableFailedUnderMax: false,
    }),
    false
  );
}

function testReenqueueSubmittingStale() {
  assert.equal(
    shouldReenqueueFromCounts({
      noRowsWithEnabledSubs: false,
      queuedCount: 0,
      submittingStaleCount: 1,
      hasRetryableFailedUnderMax: false,
    }),
    true
  );
}

function testReenqueueRetryableFailed() {
  assert.equal(
    shouldReenqueueFromCounts({
      noRowsWithEnabledSubs: false,
      queuedCount: 0,
      submittingStaleCount: 0,
      hasRetryableFailedUnderMax: true,
    }),
    true
  );
}

function testReenqueueTerminalOnly() {
  assert.equal(
    shouldReenqueueFromCounts({
      noRowsWithEnabledSubs: false,
      queuedCount: 0,
      submittingStaleCount: 0,
      hasRetryableFailedUnderMax: false,
    }),
    false
  );
}

function testReenqueueNoRowsWithSubs() {
  assert.equal(
    shouldReenqueueFromCounts({
      noRowsWithEnabledSubs: true,
      queuedCount: 0,
      submittingStaleCount: 0,
      hasRetryableFailedUnderMax: false,
    }),
    true
  );
}

function testAllowNoRowsRedispatch() {
  assert.equal(allowNoRowsRedispatch({ processed: false, side: 'BUY' }), true);
  assert.equal(allowNoRowsRedispatch({ processed: false, side: 'SELL' }), true);
  assert.equal(allowNoRowsRedispatch({ processed: true, side: 'BUY' }), false);
  assert.equal(allowNoRowsRedispatch({ processed: true, side: 'SELL' }), true);
  assert.equal(allowNoRowsRedispatch({ processed: true, side: null }), false);
}

function run() {
  testSweepNonRetryable();
  testSweepUnknownWithBackoff();
  testSweepMaxRetries();
  testSweepBackoffExponents();
  testReenqueueQueued();
  testReenqueueSubmittingNotStale();
  testReenqueueSubmittingStale();
  testReenqueueRetryableFailed();
  testReenqueueTerminalOnly();
  testReenqueueNoRowsWithSubs();
  testAllowNoRowsRedispatch();
  console.log('copyRetryBehavior.test.ts: all passed');
}

run();
