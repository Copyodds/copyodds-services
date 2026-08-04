import assert from 'node:assert/strict';
import { resolveFeedLeaderAddresses } from './copyTradeFeedQuery';

const SUB_A = '11111111-1111-4111-8111-111111111111';
const SUB_B = '22222222-2222-4222-8222-222222222222';
const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const subscriptions = [
  { id: SUB_A, leader: { address: ADDR_A } },
  { id: SUB_B, leader: { address: ADDR_B } },
];

function testAllLeadersWhenNoFilter(): void {
  const result = resolveFeedLeaderAddresses({ subscriptions });
  assert.deepEqual(result.sort(), [ADDR_A, ADDR_B].sort());
}

function testSubscriptionIdFilter(): void {
  const result = resolveFeedLeaderAddresses({
    subscriptions,
    subscriptionId: SUB_A,
  });
  assert.deepEqual(result, [ADDR_A]);
}

function testSubscriptionIdNotSubscribed(): void {
  const result = resolveFeedLeaderAddresses({
    subscriptions,
    subscriptionId: '99999999-9999-4999-8999-999999999999',
  });
  assert.deepEqual(result, []);
}

function testLeaderAddressFilter(): void {
  const result = resolveFeedLeaderAddresses({
    subscriptions,
    leaderAddress: ADDR_B,
  });
  assert.deepEqual(result, [ADDR_B]);
}

function testLeaderAddressNotSubscribed(): void {
  const result = resolveFeedLeaderAddresses({
    subscriptions,
    leaderAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
  });
  assert.deepEqual(result, []);
}

function testSubscriptionIdTakesPrecedenceOverLeaderAddress(): void {
  const result = resolveFeedLeaderAddresses({
    subscriptions,
    subscriptionId: SUB_A,
    leaderAddress: ADDR_B,
  });
  assert.deepEqual(result, [ADDR_A]);
}

/** Paused subscriptions (enabled=false) remain in the caller's list and must resolve. */
function testPausedSubscriptionStillResolves(): void {
  const pausedOnly = [{ id: SUB_A, leader: { address: ADDR_A } }];
  const byId = resolveFeedLeaderAddresses({
    subscriptions: pausedOnly,
    subscriptionId: SUB_A,
  });
  assert.deepEqual(byId, [ADDR_A]);
  const all = resolveFeedLeaderAddresses({ subscriptions: pausedOnly });
  assert.deepEqual(all, [ADDR_A]);
}

function run(): void {
  testAllLeadersWhenNoFilter();
  testSubscriptionIdFilter();
  testSubscriptionIdNotSubscribed();
  testLeaderAddressFilter();
  testLeaderAddressNotSubscribed();
  testSubscriptionIdTakesPrecedenceOverLeaderAddress();
  testPausedSubscriptionStillResolves();
  console.log('copyTrade.feed.test: ok');
}

run();
