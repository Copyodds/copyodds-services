import assert from 'node:assert/strict';
import {
  assertCopyTradingDispatchPayloadSafe,
  buildCopyTradingDispatchPayload,
} from './copyTradingPayload';

const ADDR = '0x1111111111111111111111111111111111111111';

function testPayloadShape() {
  const payload = buildCopyTradingDispatchPayload({
    leaderTradeId: 'lt-1',
    leaderAddress: ADDR,
    reason: 'leader_signal_create',
    signalSource: 'copy-folder',
    txHash: '0x' + 'a'.repeat(64),
    logIndex: 3,
  });
  assert.equal(payload.leaderTradeId, 'lt-1');
  assert.equal(payload.leaderAddress, ADDR);
  assert.equal(payload.reason, 'leader_signal_create');
  assertCopyTradingDispatchPayloadSafe(payload);
}

function testSensitiveKeyRejected() {
  assert.throws(() => {
    assertCopyTradingDispatchPayloadSafe({
      leaderTradeId: 'lt-1',
      leaderAddress: ADDR,
      occurredAt: new Date().toISOString(),
      apiSecret: 'nope',
    } as never);
  });
}

testPayloadShape();
testSensitiveKeyRejected();
console.log('publishCopyTradingDispatch.test.ts: ok');
