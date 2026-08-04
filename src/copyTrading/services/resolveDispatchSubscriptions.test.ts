import assert from 'node:assert/strict';
import type { CopySubscription } from '../../generated/prisma/client';
import type { RobotRuntimeState } from '../runtime/types';
import {
  resolveDispatchSubscriptionsForLeader,
  type ResolveDispatchSubscriptionsDeps,
} from './resolveDispatchSubscriptions';

const LEADER_ID = 'leader-uuid-1';
const LEADER_ADDRESS = '0xAbCdEf1234567890123456789012345678901234';

function subscription(id: string, overrides: Partial<CopySubscription> = {}): CopySubscription {
  return {
    id,
    leaderId: LEADER_ID,
    userId: 1,
    enabled: true,
    copyMode: 'RATIO',
    copyRatio: 1,
    fixedAmountUsd: null,
    maxAmount: null,
    minAmount: null,
    slippage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CopySubscription;
}

function runtimeState(subscriptionId: string, leaderAddress = LEADER_ADDRESS): RobotRuntimeState {
  return {
    robotId: subscriptionId,
    subscriptionId,
    userId: 1,
    leaderId: LEADER_ID,
    leaderAddress: leaderAddress.toLowerCase(),
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
    hasClobCredentials: true,
    updatedAt: new Date().toISOString(),
    loadedAt: new Date().toISOString(),
  };
}

class MockRuntimeManager {
  states: RobotRuntimeState[] = [];
  shouldThrow = false;

  getByLeaderAddress(_leaderAddress: string): RobotRuntimeState[] {
    if (this.shouldThrow) {
      throw new Error('runtime boom');
    }
    return this.states;
  }
}

function makeDeps(overrides: Partial<ResolveDispatchSubscriptionsDeps> = {}): ResolveDispatchSubscriptionsDeps {
  const all = [
    subscription('sub-a'),
    subscription('sub-b'),
    subscription('sub-paused', { enabled: false, fundingPausedAt: new Date() } as CopySubscription),
  ];
  const byIds = new Map<string, CopySubscription>([
    ['sub-a', subscription('sub-a')],
    ['sub-b', subscription('sub-b')],
    ['sub-disabled', subscription('sub-disabled', { enabled: false } as CopySubscription)],
    ['sub-paused', subscription('sub-paused', { enabled: false, fundingPausedAt: new Date() } as CopySubscription)],
  ]);
  const includeRow = (row: CopySubscription | undefined, includeFundingPaused?: boolean): row is CopySubscription =>
    Boolean(row?.enabled || (includeFundingPaused && row?.fundingPausedAt));

  return {
    findAllEnabledForLeader: async (_leaderId, options) =>
      all.filter((row) => includeRow(row, options?.includeFundingPaused)),
    findEnabledByIdsForLeader: async (_leaderId, ids, options) =>
      ids.map((id) => byIds.get(id)).filter((row) => includeRow(row, options?.includeFundingPaused)),
    ...overrides,
  };
}

async function runTests() {
  const runtime = new MockRuntimeManager();

  // 1. runtime ids + DB enabled rows
  {
    runtime.shouldThrow = false;
    runtime.states = [runtimeState('sub-a')];
    const result = await resolveDispatchSubscriptionsForLeader({
      leaderId: LEADER_ID,
      leaderAddress: LEADER_ADDRESS,
      runtimeManager: runtime,
      deps: makeDeps(),
    });
    assert.equal(result.source, 'runtime');
    assert.equal(result.runtimeCount, 1);
    assert.equal(result.dbCount, 1);
    assert.equal(result.subscriptions[0]?.id, 'sub-a');
    assert.equal(result.fallbackReason, undefined);
  }

  // 2. runtime empty → fallback DB
  {
    runtime.states = [];
    const result = await resolveDispatchSubscriptionsForLeader({
      leaderId: LEADER_ID,
      leaderAddress: LEADER_ADDRESS,
      runtimeManager: runtime,
      deps: makeDeps(),
    });
    assert.equal(result.source, 'runtime_fallback_db');
    assert.equal(result.fallbackReason, 'runtime_empty');
    assert.equal(result.subscriptions.length, 2);
  }

  // 3. runtime ids but DB enabled empty → fallback DB
  {
    runtime.states = [runtimeState('sub-disabled')];
    const result = await resolveDispatchSubscriptionsForLeader({
      leaderId: LEADER_ID,
      leaderAddress: LEADER_ADDRESS,
      runtimeManager: runtime,
      deps: makeDeps({
        findEnabledByIdsForLeader: async () => [],
      }),
    });
    assert.equal(result.source, 'runtime_fallback_db');
    assert.equal(result.fallbackReason, 'runtime_ids_no_enabled_db_rows');
    assert.equal(result.subscriptions.length, 2);
  }

  // 4. runtime stale disabled id → DB filters enabled only
  {
    runtime.states = [runtimeState('sub-a'), runtimeState('sub-disabled')];
    const result = await resolveDispatchSubscriptionsForLeader({
      leaderId: LEADER_ID,
      leaderAddress: LEADER_ADDRESS,
      runtimeManager: runtime,
      deps: makeDeps(),
    });
    assert.equal(result.source, 'runtime');
    assert.equal(result.runtimeCount, 2);
    assert.equal(result.dbCount, 1);
    assert.equal(result.subscriptions.length, 1);
    assert.equal(result.subscriptions[0]?.id, 'sub-a');
  }

  // 5. runtime throws → fallback DB
  {
    runtime.shouldThrow = true;
    const result = await resolveDispatchSubscriptionsForLeader({
      leaderId: LEADER_ID,
      leaderAddress: LEADER_ADDRESS,
      runtimeManager: runtime,
      deps: makeDeps(),
    });
    assert.equal(result.source, 'runtime_fallback_db');
    assert.equal(result.fallbackReason, 'runtime_error');
    assert.equal(result.subscriptions.length, 2);
    runtime.shouldThrow = false;
  }

  // 6. SELL dispatch can include subscriptions auto-paused for funding.
  {
    runtime.states = [runtimeState('sub-paused')];
    const result = await resolveDispatchSubscriptionsForLeader({
      leaderId: LEADER_ID,
      leaderAddress: LEADER_ADDRESS,
      runtimeManager: runtime,
      includeFundingPaused: true,
      deps: makeDeps(),
    });
    assert.equal(result.source, 'runtime');
    assert.equal(result.subscriptions.length, 1);
    assert.equal(result.subscriptions[0]?.id, 'sub-paused');
  }
}

runTests()
  .then(() => {
    console.log('resolveDispatchSubscriptions.test.ts: ok');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
