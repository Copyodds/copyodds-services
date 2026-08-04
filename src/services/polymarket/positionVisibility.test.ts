import assert from 'node:assert/strict';
import {
  isExpiredWorthlessPosition,
  isWorthlessRedeemablePosition,
  isWorthlessForLotAutoSettle,
  isConfirmedExpiredLoserPosition,
  shouldAutoSettleCopyLotAsWorthless,
  shouldForceAutoSettleOpenCopyLot,
  shouldHideLedgerSettledStalePosition,
  isActiveValuedApiPosition,
} from './positionVisibility';
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

assert.equal(isExpiredWorthlessPosition(basePosition({ curPrice: 0, currentValue: 0 })), true);
assert.equal(
  isExpiredWorthlessPosition(basePosition({ redeemable: true, curPrice: 0, currentValue: 0 })),
  false
);

assert.equal(
  isWorthlessRedeemablePosition(basePosition({ redeemable: true, curPrice: 0, currentValue: 0 })),
  true
);
assert.equal(
  isWorthlessRedeemablePosition(basePosition({ redeemable: true, curPrice: 0.5, currentValue: 5 })),
  false
);

assert.equal(
  isWorthlessForLotAutoSettle(basePosition({ redeemable: true, curPrice: 0, currentValue: 0 })),
  true
);

const recentEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const oldEnd = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

// Leader redeemed; API lag: not redeemable yet but price already 0 — do not zero copy lots.
assert.equal(
  shouldAutoSettleCopyLotAsWorthless(
    basePosition({ redeemable: false, curPrice: 0, currentValue: 0, endDate: recentEnd }),
    true
  ),
  false
);
assert.equal(
  shouldAutoSettleCopyLotAsWorthless(
    basePosition({ redeemable: true, curPrice: 0, currentValue: 0 }),
    true
  ),
  true
);
assert.equal(
  shouldAutoSettleCopyLotAsWorthless(
    basePosition({ redeemable: false, curPrice: 0, currentValue: 0 }),
    false
  ),
  true
);

// Confirmed loser: resolvedPrice 0 or market ended long ago.
assert.equal(
  isConfirmedExpiredLoserPosition(
    basePosition({ curPrice: 0, currentValue: 0, resolvedPrice: 0 })
  ),
  true
);
assert.equal(
  shouldAutoSettleCopyLotAsWorthless(
    basePosition({ curPrice: 0, currentValue: 0, resolvedPrice: 0 }),
    true
  ),
  true
);
assert.equal(
  shouldAutoSettleCopyLotAsWorthless(
    basePosition({ redeemable: false, curPrice: 0, currentValue: 0, endDate: oldEnd }),
    true
  ),
  true
);
assert.equal(
  isConfirmedExpiredLoserPosition(
    basePosition({ curPrice: 0, currentValue: 0, resolvedPrice: 1 })
  ),
  false
);

// France vs Senegal style: ledger already manual_expired, chain still shows 7.5 shares @ $0.
assert.equal(
  shouldHideLedgerSettledStalePosition(
    basePosition({ size: 7.5, curPrice: 0, currentValue: 0 }),
    { hasOpenLots: false, isLedgerSettled: true }
  ),
  true
);
assert.equal(
  shouldHideLedgerSettledStalePosition(
    basePosition({ size: 7.5, curPrice: 0, currentValue: 0 }),
    { hasOpenLots: true, isLedgerSettled: true }
  ),
  false
);

// Valued redeemable after mistaken manual_expired must stay visible (FC Dallas).
assert.equal(
  shouldHideLedgerSettledStalePosition(
    basePosition({
      size: 3.18,
      curPrice: 1,
      currentValue: 3.18,
      redeemable: true,
      avgPrice: 0.34,
    }),
    { hasOpenLots: false, isLedgerSettled: true }
  ),
  false,
  'valued redeemable winner must not hide after false ledger settle'
);
assert.equal(
  shouldHideLedgerSettledStalePosition(
    basePosition({
      size: 3.18,
      curPrice: 1,
      currentValue: 3.18,
      redeemable: true,
    }),
    { hasOpenLots: true, isLedgerSettled: true }
  ),
  false,
  'meaningful open lots keep redeemable visible'
);
// Worthless redeemable lag after real settle may still list size > 0 — hide.
assert.equal(
  shouldHideLedgerSettledStalePosition(
    basePosition({
      size: 3.18,
      curPrice: 0,
      currentValue: 0,
      redeemable: true,
    }),
    { hasOpenLots: false, isLedgerSettled: true }
  ),
  true
);

assert.equal(shouldForceAutoSettleOpenCopyLot(null), false);
assert.equal(
  shouldForceAutoSettleOpenCopyLot(null, new Date(), { chainFlatWhenMissing: true }),
  true
);
assert.equal(
  shouldForceAutoSettleOpenCopyLot(
    basePosition({ curPrice: 0, currentValue: 0, endDate: undefined as unknown as string })
  ),
  true
);
assert.equal(
  shouldForceAutoSettleOpenCopyLot(
    basePosition({ redeemable: true, curPrice: 0.95, currentValue: 9.5 })
  ),
  false
);

assert.equal(
  isActiveValuedApiPosition(
    basePosition({ size: 1.34, curPrice: 0.78, currentValue: 1.05 })
  ),
  true
);
assert.equal(
  isActiveValuedApiPosition(basePosition({ size: 2, curPrice: 0, currentValue: 0 })),
  false
);

console.log('positionVisibility.test.ts: ok');
