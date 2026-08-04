import assert from 'node:assert/strict';
import {
  COPY_COLLATERAL_INSUFFICIENT_WARNING_CODE,
  COPY_FUNDS_EMPTY_ERROR_CODE,
  COPY_GAS_INSUFFICIENT_ERROR_CODE,
  isCopyBuyFundingWarningCode,
  shouldPauseCopyTradingForOrderError,
  subscriptionHasBuyFundingWarning,
} from './copyFundingMonitor';

assert.equal(shouldPauseCopyTradingForOrderError('user_gas_insufficient'), false);
assert.equal(shouldPauseCopyTradingForOrderError('user_allowance_required'), false);
assert.equal(shouldPauseCopyTradingForOrderError('user_collateral_insufficient'), false);
assert.equal(shouldPauseCopyTradingForOrderError('user_insufficient_balance'), false);
assert.equal(shouldPauseCopyTradingForOrderError('clob_timeout'), false);
assert.equal(shouldPauseCopyTradingForOrderError(null), false);

assert.equal(isCopyBuyFundingWarningCode(COPY_GAS_INSUFFICIENT_ERROR_CODE), true);
assert.equal(isCopyBuyFundingWarningCode(COPY_COLLATERAL_INSUFFICIENT_WARNING_CODE), true);
assert.equal(isCopyBuyFundingWarningCode(COPY_FUNDS_EMPTY_ERROR_CODE), true);
assert.equal(isCopyBuyFundingWarningCode('user_allowance_required'), false);

assert.equal(
  subscriptionHasBuyFundingWarning({
    fundingWarningAt: new Date(),
    fundingWarningCode: COPY_COLLATERAL_INSUFFICIENT_WARNING_CODE,
  }),
  true
);
assert.equal(subscriptionHasBuyFundingWarning({ fundingWarningAt: null, fundingWarningCode: null }), false);

console.log('copyFundingMonitor.test.ts: ok');
