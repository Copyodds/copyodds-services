import assert from 'node:assert/strict';
import { handleRobotControlEvent, resolveSubscriptionIdForRobotEvent } from './robotControlHandler';
import type { RobotControlEventPayload } from './robotControlTypes';

const SUB_ID = 'sub-test-001';

type ReloadResult = 'upsert' | 'remove' | 'missing';

class MockRuntime {
  reloadCalls: string[] = [];
  removeCalls: string[] = [];
  private reloadResults = new Map<string, ReloadResult>();
  sizeValue = 0;

  setReloadResult(id: string, result: ReloadResult) {
    this.reloadResults.set(id, result);
  }

  async reloadSubscriptionFromDb(subscriptionId: string): Promise<ReloadResult> {
    this.reloadCalls.push(subscriptionId);
    return this.reloadResults.get(subscriptionId) ?? 'upsert';
  }

  remove(subscriptionId: string): boolean {
    this.removeCalls.push(subscriptionId);
    return true;
  }

  size(): number {
    return this.sizeValue;
  }
}

function payload(event: RobotControlEventPayload['event']): RobotControlEventPayload {
  return {
    subscriptionId: SUB_ID,
    event,
    userId: 1,
    leaderId: 'leader-1',
    leaderAddress: '0xabc',
    occurredAt: '2026-01-01T00:00:00.000Z',
  };
}

async function testModifyReloadResume() {
  const runtime = new MockRuntime();
  for (const event of ['modify', 'reload', 'resume'] as const) {
    runtime.reloadCalls = [];
    const result = await handleRobotControlEvent(runtime, {
      subject: `robot.${event}.${SUB_ID}`,
      rawPayload: payload(event),
    });
    assert.equal(result.ok, true);
    assert.equal(runtime.reloadCalls.join(','), SUB_ID);
    assert.match(result.action, /^reload_/);
  }
}

async function testPauseRemoveWhenDisabled() {
  const runtime = new MockRuntime();
  runtime.setReloadResult(SUB_ID, 'remove');
  const result = await handleRobotControlEvent(runtime, {
    subject: `robot.pause.${SUB_ID}`,
    rawPayload: payload('pause'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'pause_remove');
  assert.equal(runtime.reloadCalls.length, 1);
}

async function testResumeUpsert() {
  const runtime = new MockRuntime();
  runtime.setReloadResult(SUB_ID, 'upsert');
  const result = await handleRobotControlEvent(runtime, {
    subject: `robot.resume.${SUB_ID}`,
    rawPayload: payload('resume'),
  });
  assert.equal(result.action, 'reload_upsert');
}

async function testInvalidPayloadNoThrow() {
  const runtime = new MockRuntime();
  const result = await handleRobotControlEvent(runtime, {
    subject: `robot.modify.${SUB_ID}`,
    rawPayload: { bad: true },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ignored, true);
  assert.equal(runtime.reloadCalls.length, 0);
}

async function testSubjectPayloadMismatchUsesPayload() {
  const runtime = new MockRuntime();
  const otherId = 'sub-from-payload';
  const result = await handleRobotControlEvent(runtime, {
    subject: `robot.modify.${SUB_ID}`,
    rawPayload: { ...payload('modify'), subscriptionId: otherId },
  });
  assert.equal(result.subscriptionId, otherId);
  assert.equal(runtime.reloadCalls[0], otherId);
}

function testResolveMismatchHelper() {
  const resolved = resolveSubscriptionIdForRobotEvent({
    subject: `robot.pause.${SUB_ID}`,
    payload: { ...payload('pause'), subscriptionId: 'payload-id' },
  });
  assert.equal(resolved.subscriptionId, 'payload-id');
  assert.equal(resolved.subjectMismatch, true);
}

async function run() {
  await testModifyReloadResume();
  await testPauseRemoveWhenDisabled();
  await testResumeUpsert();
  await testInvalidPayloadNoThrow();
  await testSubjectPayloadMismatchUsesPayload();
  testResolveMismatchHelper();
  console.log('robotControlHandler.test.ts: ok');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
