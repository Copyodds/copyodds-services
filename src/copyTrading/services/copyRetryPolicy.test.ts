import assert from 'node:assert/strict';
import {
  COPY_UNKNOWN_ERROR_CODE,
  copyTradeRetryDelayMs,
  isCopyTradeErrorRetryable,
  normalizeCopyTradeErrorCode,
} from './copyRetryPolicy';

async function testClassifyRetryable() {
  process.env.CUSTODY_TREASURY_ADDRESS =
    process.env.CUSTODY_TREASURY_ADDRESS ?? '0x1111111111111111111111111111111111111111';
  const { classifyCopyOrderFailure } = await import('./riskService.js');

  const timeout = classifyCopyOrderFailure('gateway timeout while posting order');
  assert.equal(timeout.errorCode, 'clob_timeout');
  assert.equal(timeout.retryable, true);

  const balance = classifyCopyOrderFailure('insufficient balance for order');
  assert.equal(balance.errorCode, 'user_insufficient_balance');
  assert.equal(balance.retryable, false);

  const gas = classifyCopyOrderFailure('Insufficient gas balance: need 0.5 gas for this order');
  assert.equal(gas.errorCode, 'user_gas_insufficient');
  assert.equal(gas.retryable, false);

  const empty = classifyCopyOrderFailure('');
  assert.equal(empty.errorCode, 'unknown_error');
  assert.equal(empty.retryable, true);

  const unknown = classifyCopyOrderFailure('something completely unexpected xyz');
  assert.equal(unknown.errorCode, 'unknown_error');
  assert.equal(unknown.retryable, true);

  const generic400 = classifyCopyOrderFailure('HTTP 400 Bad Request from upstream');
  assert.equal(generic400.errorCode, 'unknown_error');
  assert.equal(generic400.retryable, true);

  const orderRejected = classifyCopyOrderFailure('order rejected by matching engine');
  assert.equal(orderRejected.errorCode, 'clob_rejected');
  assert.equal(orderRejected.retryable, false);

  const noLiquidity = classifyCopyOrderFailure('CLOB_MARKET_SELL_NOT_FILLED: no match');
  assert.equal(noLiquidity.errorCode, 'clob_no_liquidity');
  assert.equal(noLiquidity.retryable, false);

  const invalidPrice = classifyCopyOrderFailure('invalid order: price out of range');
  assert.equal(invalidPrice.errorCode, 'clob_rejected');
  assert.equal(invalidPrice.retryable, false);

  const invalidVague = classifyCopyOrderFailure('invalid order');
  assert.equal(invalidVague.errorCode, 'unknown_error');
  assert.equal(invalidVague.retryable, true);

  const nonce = classifyCopyOrderFailure('nonce too low');
  assert.equal(nonce.errorCode, 'unknown_error');
  assert.equal(nonce.retryable, true);
}

function testNormalizeUnknown() {
  assert.equal(normalizeCopyTradeErrorCode(null), COPY_UNKNOWN_ERROR_CODE);
  assert.equal(normalizeCopyTradeErrorCode(''), COPY_UNKNOWN_ERROR_CODE);
  assert.equal(normalizeCopyTradeErrorCode('clob_timeout'), 'clob_timeout');
}

function testRetryableCodes() {
  assert.equal(isCopyTradeErrorRetryable(null), true);
  assert.equal(isCopyTradeErrorRetryable(COPY_UNKNOWN_ERROR_CODE), true);
  assert.equal(isCopyTradeErrorRetryable('stale_submitting'), true);
  assert.equal(isCopyTradeErrorRetryable('clob_timeout'), true);
  assert.equal(isCopyTradeErrorRetryable('clob_rate_limit'), true);
  assert.equal(isCopyTradeErrorRetryable('clob_partial_fill'), true);
  assert.equal(isCopyTradeErrorRetryable('user_insufficient_balance'), false);
  assert.equal(isCopyTradeErrorRetryable('user_allowance_required'), false);
  assert.equal(isCopyTradeErrorRetryable('clob_rejected'), false);
}

function testBackoff() {
  const bounds = { base: 1000, max: 120_000 };
  assert.equal(copyTradeRetryDelayMs(0, bounds), 1000);
  assert.equal(copyTradeRetryDelayMs(1, bounds), 1000);
  assert.equal(copyTradeRetryDelayMs(2, bounds), 2000);
  assert.equal(copyTradeRetryDelayMs(3, bounds), 4000);
}

async function run() {
  testNormalizeUnknown();
  testRetryableCodes();
  await testClassifyRetryable();
  testBackoff();
  console.log('copyRetryPolicy.test.ts: all passed');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
