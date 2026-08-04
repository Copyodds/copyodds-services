import assert from 'node:assert/strict';
import {
  AUTO_REDEEM_MAX_FAILURES,
  isAutoRedeemDisabledByFailures,
  normalizeRedeemConditionId,
} from './autoRedeemFailureGuard';

assert.equal(AUTO_REDEEM_MAX_FAILURES, 3);
assert.equal(isAutoRedeemDisabledByFailures(0), false);
assert.equal(isAutoRedeemDisabledByFailures(2), false);
assert.equal(isAutoRedeemDisabledByFailures(3), true);
assert.equal(isAutoRedeemDisabledByFailures(10), true);
assert.equal(
  normalizeRedeemConditionId(' 0xAbC '),
  '0xabc'
);

console.log('autoRedeemFailureGuard.test.ts: ok');
