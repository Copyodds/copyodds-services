import assert from 'node:assert/strict';
import { RobotRuntimeManager } from './RobotRuntimeManager';
import { normalizeLeaderAddress } from './normalizeLeaderAddress';
import type { RobotRuntimeState } from './types';

const LEADER_A = '0x1111111111111111111111111111111111111111';
const LEADER_B = '0x2222222222222222222222222222222222222222';
const SUB_1 = 'sub-00000000-0000-0000-0000-000000000001';
const SUB_2 = 'sub-00000000-0000-0000-0000-000000000002';

function baseState(input: {
  subscriptionId: string;
  userId: number;
  leaderId: string;
  leaderAddress: string;
}): RobotRuntimeState {
  const id = input.subscriptionId;
  return {
    robotId: id,
    subscriptionId: id,
    userId: input.userId,
    leaderId: input.leaderId,
    leaderAddress: input.leaderAddress,
    enabled: true,
    copyMode: 'RATIO',
    copyRatio: 1,
    fixedAmountUsd: null,
    maxAmount: null,
    minAmount: null,
    slippage: null,
    walletId: null,
    executionAddress: null,
    depositFunderAddress: null,
    hasClobCredentials: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    loadedAt: '2026-01-01T00:00:00.000Z',
  };
}

function testUpsertAndGetByLeader() {
  const mgr = new RobotRuntimeManager();
  mgr.upsert(
    baseState({
      subscriptionId: SUB_1,
      userId: 1,
      leaderId: 'leader-a',
      leaderAddress: LEADER_A,
    })
  );
  const found = mgr.getByLeaderAddress(LEADER_A);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.subscriptionId, SUB_1);
}

function testLeaderAddressCaseInsensitive() {
  const mgr = new RobotRuntimeManager();
  const lower = LEADER_A;
  const mixed = `0X${LEADER_A.slice(2).toUpperCase()}`;
  mgr.upsert(
    baseState({
      subscriptionId: SUB_1,
      userId: 1,
      leaderId: 'l1',
      leaderAddress: mixed,
    })
  );
  assert.equal(mgr.getByLeaderAddress(lower).length, 1);
  assert.equal(mgr.getBySubscriptionId(SUB_1)?.leaderAddress, lower);
}

function testLeaderAddressChangeClearsOldIndex() {
  const mgr = new RobotRuntimeManager();
  mgr.upsert(
    baseState({
      subscriptionId: SUB_1,
      userId: 1,
      leaderId: 'la',
      leaderAddress: LEADER_A,
    })
  );
  assert.equal(mgr.getByLeaderAddress(LEADER_A).length, 1);
  assert.equal(mgr.getByLeaderAddress(LEADER_B).length, 0);

  mgr.upsert(
    baseState({
      subscriptionId: SUB_1,
      userId: 1,
      leaderId: 'lb',
      leaderAddress: LEADER_B,
    })
  );
  assert.equal(mgr.getByLeaderAddress(LEADER_A).length, 0);
  assert.equal(mgr.getByLeaderAddress(LEADER_B).length, 1);
  assert.equal(mgr.getBySubscriptionId(SUB_1)?.leaderAddress, normalizeLeaderAddress(LEADER_B));
}

function testRemoveClearsBothMaps() {
  const mgr = new RobotRuntimeManager();
  mgr.upsert(
    baseState({
      subscriptionId: SUB_1,
      userId: 1,
      leaderId: 'la',
      leaderAddress: LEADER_A,
    })
  );
  assert.equal(mgr.remove(SUB_1), true);
  assert.equal(mgr.size(), 0);
  assert.equal(mgr.getByLeaderAddress(LEADER_A).length, 0);
  assert.equal(mgr.getBySubscriptionId(SUB_1), undefined);
}

function testDisabledReloadSemanticsViaRemove() {
  const mgr = new RobotRuntimeManager();
  mgr.upsert(
    baseState({
      subscriptionId: SUB_1,
      userId: 1,
      leaderId: 'la',
      leaderAddress: LEADER_A,
    })
  );
  // reloadSubscriptionFromDb on disabled/missing calls remove — same outcome
  mgr.remove(SUB_1);
  assert.equal(mgr.getBySubscriptionId(SUB_1), undefined);
  assert.equal(mgr.getByLeaderAddress(LEADER_A).length, 0);
}

function testStats() {
  const mgr = new RobotRuntimeManager();
  mgr.upsert(
    baseState({
      subscriptionId: SUB_1,
      userId: 1,
      leaderId: 'la',
      leaderAddress: LEADER_A,
    })
  );
  mgr.upsert(
    baseState({
      subscriptionId: SUB_2,
      userId: 2,
      leaderId: 'la',
      leaderAddress: LEADER_A,
    })
  );
  const stats = mgr.stats();
  assert.equal(stats.totalRobots, 2);
  assert.equal(stats.leaderCount, 1);
  assert.equal(stats.uniqueUserCount, 2);
  assert.equal(stats.topLeaders[0]?.leaderAddress, normalizeLeaderAddress(LEADER_A));
  assert.equal(stats.topLeaders[0]?.robotCount, 2);
}

testUpsertAndGetByLeader();
testLeaderAddressCaseInsensitive();
testLeaderAddressChangeClearsOldIndex();
testRemoveClearsBothMaps();
testDisabledReloadSemanticsViaRemove();
testStats();

console.log('RobotRuntimeManager.test.ts: ok');
