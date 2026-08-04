import assert from 'node:assert/strict';
import {
  deriveSettlementStatus,
  deriveSettlementStatusFromApiPosition,
  suggestedActionForStatus,
} from './settlementStatus';
import type { DataApiPosition } from './polymarketData';

function basePosition(overrides: Partial<DataApiPosition> = {}): DataApiPosition {
  return {
    asset: 'token-1',
    conditionId: '0xabc',
    size: 10,
    curPrice: 0.5,
    currentValue: 5,
    redeemable: false,
    endDate: '2020-01-01T00:00:00.000Z',
    ...overrides,
  } as DataApiPosition;
}

assert.equal(
  deriveSettlementStatus({
    apiPos: basePosition(),
    hasOpenLots: true,
    inDisplayRaw: true,
    isWorthlessHidden: false,
    isStaleHidden: false,
    isDustHidden: false,
  }),
  'active'
);

assert.equal(
  deriveSettlementStatus({
    apiPos: basePosition({ redeemable: true, currentValue: 5, curPrice: 0.5 }),
    hasOpenLots: true,
    inDisplayRaw: true,
    isWorthlessHidden: false,
    isStaleHidden: false,
    isDustHidden: false,
  }),
  'redeemable'
);

assert.equal(
  deriveSettlementStatus({
    apiPos: basePosition({ curPrice: 0, currentValue: 0 }),
    hasOpenLots: true,
    inDisplayRaw: false,
    isWorthlessHidden: true,
    isStaleHidden: false,
    isDustHidden: false,
  }),
  'settled_loss'
);

const recentEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString();
assert.equal(
  deriveSettlementStatus({
    apiPos: basePosition({ curPrice: 0, currentValue: 0, endDate: recentEnd }),
    hasOpenLots: true,
    inDisplayRaw: false,
    isWorthlessHidden: true,
    isStaleHidden: false,
    isDustHidden: false,
  }),
  'pending_settlement'
);

assert.equal(
  deriveSettlementStatus({
    apiPos: null,
    hasOpenLots: true,
    inDisplayRaw: false,
    isWorthlessHidden: false,
    isStaleHidden: false,
    isDustHidden: false,
  }),
  'pending_settlement'
);

assert.equal(
  deriveSettlementStatusFromApiPosition(null, true),
  'pending_settlement'
);

assert.equal(suggestedActionForStatus('pending_settlement'), 'wait');
assert.equal(suggestedActionForStatus('redeemable'), 'redeem');

console.log('settlementStatus.test.ts: ok');
