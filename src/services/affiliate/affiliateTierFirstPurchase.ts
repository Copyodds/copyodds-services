import { AFFILIATE_TIER_RATES } from '../../config/gas';

function normalizeUserTier(tier: number | null | undefined): number {
  if (tier == null || tier <= 0) return 0;
  return tier;
}

function isValidAffiliateTier(tier: number): boolean {
  return Number.isInteger(tier) && tier >= 1 && tier <= 8 && tier in AFFILIATE_TIER_RATES;
}

/**
 * Resolve affiliate tier to grant on a Gas package (or equivalent) purchase.
 *
 * Rules:
 * - Inactive users (tier 0 / null): any purchase activates at least L1.
 * - Package `bonusAffiliateTier`, when set and higher, still upgrades further.
 * - Never downgrade: e.g. L3 + L1/L2 package bonus → no change.
 */
export function resolvePurchaseAffiliateTierGrant(options: {
  currentTier: number | null | undefined;
  packageBonusTier?: number | null;
}): number | null {
  const currentTier = normalizeUserTier(options.currentTier);
  let grantTo: number | null = null;

  // L1 activation only for inactive users; never rewrite an existing tier down to L1.
  if (currentTier <= 0) {
    grantTo = 1;
  }

  const bonus = options.packageBonusTier;
  if (bonus != null && isValidAffiliateTier(bonus) && bonus > currentTier) {
    if (grantTo == null || bonus > grantTo) {
      grantTo = bonus;
    }
  }

  // Hard floor: only return a strictly higher tier than the user already has.
  if (grantTo == null || grantTo <= currentTier) {
    return null;
  }
  return grantTo;
}
