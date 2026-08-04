import assert from 'node:assert/strict';
import {
  AUTO_UPGRADE_TIER_REQUIREMENTS,
  MAX_AUTO_UPGRADE_TIER,
  MAX_AFFILIATE_TIER,
  resolveNextAutoUpgradeTier,
} from './affiliateTierAutoUpgrade';

assert.equal(
  resolveNextAutoUpgradeTier({
    currentTier: null,
    directAtTier1Count: 99,
    directAtPrevTierCount: 99,
  }),
  null,
  'tier 0 cannot auto-upgrade (T1 requires purchase)',
);

assert.equal(
  resolveNextAutoUpgradeTier({
    currentTier: 1,
    directAtTier1Count: AUTO_UPGRADE_TIER_REQUIREMENTS[2].minDirectAtTier1 - 1,
    directAtPrevTierCount: AUTO_UPGRADE_TIER_REQUIREMENTS[2].minDirectAtPrevTier,
  }),
  null,
  'T1 -> T2 needs 3 direct T1 referrals',
);

assert.equal(
  resolveNextAutoUpgradeTier({
    currentTier: 1,
    directAtTier1Count: AUTO_UPGRADE_TIER_REQUIREMENTS[2].minDirectAtTier1,
    directAtPrevTierCount: AUTO_UPGRADE_TIER_REQUIREMENTS[2].minDirectAtPrevTier,
  }),
  2,
);

assert.equal(
  resolveNextAutoUpgradeTier({
    currentTier: 2,
    directAtTier1Count: AUTO_UPGRADE_TIER_REQUIREMENTS[3].minDirectAtTier1,
    directAtPrevTierCount: AUTO_UPGRADE_TIER_REQUIREMENTS[3].minDirectAtPrevTier - 1,
  }),
  null,
  'T2 -> T3 needs 3 direct T2 referrals among 5 T1+',
);

assert.equal(
  resolveNextAutoUpgradeTier({
    currentTier: 2,
    directAtTier1Count: AUTO_UPGRADE_TIER_REQUIREMENTS[3].minDirectAtTier1 - 1,
    directAtPrevTierCount: AUTO_UPGRADE_TIER_REQUIREMENTS[3].minDirectAtPrevTier,
  }),
  null,
  'T2 -> T3 needs 5 direct T1+ referrals',
);

assert.equal(
  resolveNextAutoUpgradeTier({
    currentTier: 2,
    directAtTier1Count: AUTO_UPGRADE_TIER_REQUIREMENTS[3].minDirectAtTier1,
    directAtPrevTierCount: AUTO_UPGRADE_TIER_REQUIREMENTS[3].minDirectAtPrevTier,
  }),
  3,
);

assert.equal(
  resolveNextAutoUpgradeTier({
    currentTier: 6,
    directAtTier1Count: AUTO_UPGRADE_TIER_REQUIREMENTS[7].minDirectAtTier1,
    directAtPrevTierCount: AUTO_UPGRADE_TIER_REQUIREMENTS[7].minDirectAtPrevTier,
  }),
  7,
);

assert.equal(
  resolveNextAutoUpgradeTier({
    currentTier: MAX_AUTO_UPGRADE_TIER,
    directAtTier1Count: 999,
    directAtPrevTierCount: 999,
  }),
  null,
  'T7 is the highest auto-upgrade tier',
);

assert.equal(
  resolveNextAutoUpgradeTier({
    currentTier: MAX_AFFILIATE_TIER,
    directAtTier1Count: 999,
    directAtPrevTierCount: 999,
  }),
  null,
);

console.log('[affiliate-tier-auto-upgrade-test] ok', {
  maxAutoUpgradeTier: MAX_AUTO_UPGRADE_TIER,
  requirements: AUTO_UPGRADE_TIER_REQUIREMENTS,
});
