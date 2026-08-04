import assert from 'node:assert/strict';
import { resolvePurchaseAffiliateTierGrant } from './affiliateTierFirstPurchase';

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: null, packageBonusTier: null }),
  1,
  'inactive user: any gas purchase activates L1',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 0, packageBonusTier: undefined }),
  1,
  'tier 0: any gas purchase activates L1',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: null, packageBonusTier: 1 }),
  1,
  'inactive + L1 bonus still grants L1',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: null, packageBonusTier: 2 }),
  2,
  'inactive + L2 package bonus grants L2 (includes activation)',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 1, packageBonusTier: null }),
  null,
  'already L1: plain gas purchase does not change tier',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 1, packageBonusTier: 1 }),
  null,
  'already L1: L1 bonus is a no-op',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 1, packageBonusTier: 3 }),
  3,
  'already L1: higher package bonus still upgrades',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 3, packageBonusTier: 2 }),
  null,
  'never downgrade via package bonus',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 2, packageBonusTier: 9 }),
  null,
  'invalid bonus tier ignored; already active stays put',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: null, packageBonusTier: 9 }),
  1,
  'invalid bonus ignored but first-purchase L1 still applies',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 3, packageBonusTier: null }),
  null,
  'L3 + plain gas package: no tier change',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 3, packageBonusTier: 1 }),
  null,
  'L3 + L1 package bonus: never downgrade to L1',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 3, packageBonusTier: 2 }),
  null,
  'L3 + L2 package bonus: never downgrade to L2',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 3, packageBonusTier: 3 }),
  null,
  'L3 + L3 package bonus: no-op',
);

assert.equal(
  resolvePurchaseAffiliateTierGrant({ currentTier: 3, packageBonusTier: 4 }),
  4,
  'L3 + L4 package bonus: upgrade only',
);

console.log('affiliateTierFirstPurchase.test.ts: ok');
