import assert from 'node:assert/strict';
import {
  isClosedSnapshotFresh,
  isClosedSnapshotGateReady,
  shouldMarkClosedSnapshotReady,
} from './smartMoneyClosedSnapshot.js';

{
  assert.equal(
    shouldMarkClosedSnapshotReady({ windowComplete: true, nextPage: 3, targetMaxPages: 30 }),
    true
  );
  assert.equal(
    shouldMarkClosedSnapshotReady({ windowComplete: false, nextPage: 30, targetMaxPages: 30 }),
    true
  );
  assert.equal(
    shouldMarkClosedSnapshotReady({ windowComplete: false, nextPage: 12, targetMaxPages: 30 }),
    false
  );
  // 不满上限但已扫尽 → READY（新地址少量 closed 可入池）
  assert.equal(
    shouldMarkClosedSnapshotReady({ windowComplete: true, nextPage: 1, targetMaxPages: 30 }),
    true
  );
}

{
  const now = Date.now();
  assert.equal(isClosedSnapshotFresh(new Date(now + 60_000), now), true);
  assert.equal(isClosedSnapshotFresh(new Date(now - 1), now), false);
  assert.equal(isClosedSnapshotFresh(null, now), false);
}

{
  const now = Date.now();
  assert.equal(
    isClosedSnapshotGateReady({
      status: 'READY',
      windowComplete: true,
      pageCount: 2,
      targetMaxPages: 30,
      expiresAt: new Date(now + 3_600_000),
      nowMs: now,
    }),
    true
  );
  assert.equal(
    isClosedSnapshotGateReady({
      status: 'READY',
      windowComplete: false,
      pageCount: 30,
      targetMaxPages: 30,
      expiresAt: new Date(now + 3_600_000),
      nowMs: now,
    }),
    true
  );
  assert.equal(
    isClosedSnapshotGateReady({
      status: 'FETCHING',
      windowComplete: false,
      pageCount: 10,
      targetMaxPages: 30,
      expiresAt: null,
      nowMs: now,
    }),
    false
  );
  assert.equal(
    isClosedSnapshotGateReady({
      status: 'READY',
      windowComplete: false,
      pageCount: 10,
      targetMaxPages: 30,
      expiresAt: new Date(now + 3_600_000),
      nowMs: now,
    }),
    false
  );
  assert.equal(
    isClosedSnapshotGateReady({
      status: 'READY',
      windowComplete: true,
      pageCount: 2,
      targetMaxPages: 30,
      expiresAt: new Date(now - 1),
      nowMs: now,
    }),
    false
  );
}

console.log('smartMoneyClosedSnapshot.test: OK');
