import assert from 'node:assert/strict';
import {
  assertRobotControlPayloadSafe,
  buildRobotControlPayload,
} from './robotControlPayload';

function testPayloadShape() {
  const payload = buildRobotControlPayload({
    subscriptionId: 'sub-1',
    event: 'modify',
    userId: 42,
    leaderId: 'leader-1',
    leaderAddress: '0xAbC',
  });

  assert.equal(payload.subscriptionId, 'sub-1');
  assert.equal(payload.event, 'modify');
  assert.equal(payload.userId, 42);
  assert.equal(payload.leaderAddress, '0xabc');
  assert.ok(payload.occurredAt);

  const keys = Object.keys(payload).map((k) => k.toLowerCase());
  for (const forbidden of ['apikey', 'apisecret', 'passphrase', 'privatekey', 'encrypted']) {
    assert.ok(!keys.some((k) => k.includes(forbidden)), `unexpected key containing ${forbidden}`);
  }

  assertRobotControlPayloadSafe(payload);
}

function testSensitiveKeyRejected() {
  assert.throws(() => {
    assertRobotControlPayloadSafe({
      subscriptionId: 'sub-1',
      event: 'modify',
      userId: 1,
      leaderId: 'l',
      leaderAddress: '0x1',
      occurredAt: new Date().toISOString(),
      apiSecret: 'nope',
    } as never);
  });
}

testPayloadShape();
testSensitiveKeyRejected();
console.log('publishRobotControlEvent.test.ts: ok');
