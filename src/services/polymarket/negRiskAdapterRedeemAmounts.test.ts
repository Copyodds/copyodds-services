import assert from 'node:assert/strict';
import {
  buildNegRiskAdapterRedeemAmounts,
  encodeNegRiskAdapterRedeemCall,
  sharesToConditionalTokenRaw,
} from './negRiskAdapterRedeemEncode';

assert.equal(sharesToConditionalTokenRaw(1.2658).toString(), '1265800');
assert.equal(sharesToConditionalTokenRaw(0).toString(), '0');

assert.deepEqual(buildNegRiskAdapterRedeemAmounts({ outcomeIndex: 0, size: 2 }), [
  2_000_000n,
  0n,
]);
assert.deepEqual(buildNegRiskAdapterRedeemAmounts({ outcomeIndex: 1, size: 1.5 }), [
  0n,
  1_500_000n,
]);

const data = encodeNegRiskAdapterRedeemCall({
  conditionId: '0x' + '11'.repeat(32),
  amounts: [100n, 0n],
});
assert.equal(data.slice(0, 10), '0xdbeccb23');

console.log('negRiskAdapterRedeemAmounts.test.ts: ok');
