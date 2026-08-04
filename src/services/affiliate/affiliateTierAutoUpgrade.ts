import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { AFFILIATE_TIER_RATES } from '../../config/gas';

type PrismaClientLike = Prisma.TransactionClient | typeof prisma;

export const MAX_AFFILIATE_TIER = Math.max(...Object.keys(AFFILIATE_TIER_RATES).map(Number));

/** Auto-upgrade stops at T7; T8 remains purchase-only. */
export const MAX_AUTO_UPGRADE_TIER = 7;

export type AutoUpgradeTierRequirement = {
  minDirectAtTier1: number;
  minDirectAtPrevTier: number;
};

/**
 * Requirements to reach each tier (T2–T7), aligned with membership upgrade table:
 * - T2: 3 direct referrals at T1+
 * - T3: 5 at T1+, at least 3 at T2+
 * - T4: 8 at T1+, at least 3 at T3+
 * - T5: 12 at T1+, at least 3 at T4+
 * - T6: 20 at T1+, at least 3 at T5+
 * - T7: 30 at T1+, at least 3 at T6+
 */
export const AUTO_UPGRADE_TIER_REQUIREMENTS: Record<number, AutoUpgradeTierRequirement> = {
  2: { minDirectAtTier1: 3, minDirectAtPrevTier: 3 },
  3: { minDirectAtTier1: 5, minDirectAtPrevTier: 3 },
  4: { minDirectAtTier1: 8, minDirectAtPrevTier: 3 },
  5: { minDirectAtTier1: 12, minDirectAtPrevTier: 3 },
  6: { minDirectAtTier1: 20, minDirectAtPrevTier: 3 },
  7: { minDirectAtTier1: 30, minDirectAtPrevTier: 3 },
};

function normalizeUserTier(tier: number | null | undefined): number {
  if (tier == null || tier <= 0) return 0;
  return tier;
}

function countDirectAtMinTier(tiers: number[], minTier: number): number {
  return tiers.filter((tier) => tier >= minTier).length;
}

export function resolveNextAutoUpgradeTier(options: {
  currentTier: number | null | undefined;
  directAtTier1Count: number;
  directAtPrevTierCount: number;
}): number | null {
  const currentTier = normalizeUserTier(options.currentTier);
  if (currentTier <= 0) {
    return null;
  }

  const nextTier = currentTier + 1;
  if (nextTier > MAX_AUTO_UPGRADE_TIER) {
    return null;
  }

  const requirement = AUTO_UPGRADE_TIER_REQUIREMENTS[nextTier];
  if (!requirement) {
    return null;
  }

  if (
    options.directAtTier1Count >= requirement.minDirectAtTier1 &&
    options.directAtPrevTierCount >= requirement.minDirectAtPrevTier
  ) {
    return nextTier;
  }

  return null;
}

async function fetchDirectReferralTiers(
  userId: number,
  client: PrismaClientLike,
): Promise<number[]> {
  const rows = await (client as any).user.findMany({
    where: { referrerId: userId },
    select: { affiliateTier: true },
  });
  return rows.map((row: { affiliateTier: number | null }) => normalizeUserTier(row.affiliateTier));
}

export async function applyAffiliateTierAutoUpgradeForUser(
  userId: number,
  client: PrismaClientLike = prisma,
): Promise<{
  userId: number;
  previousTier: number;
  currentTier: number;
  upgraded: boolean;
  referrerId: number | null;
}> {
  const user = await (client as any).user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      referrerId: true,
      affiliateTier: true,
    },
  });
  if (!user) {
    throw new Error('User not found');
  }

  const previousTier = normalizeUserTier((user as any).affiliateTier);
  let currentTier = previousTier;

  if (currentTier > 0) {
    const directReferralTiers = await fetchDirectReferralTiers(userId, client);
    const directAtTier1Count = countDirectAtMinTier(directReferralTiers, 1);

    while (currentTier < MAX_AUTO_UPGRADE_TIER) {
      const directAtPrevTierCount = countDirectAtMinTier(directReferralTiers, currentTier);
      const nextTier = resolveNextAutoUpgradeTier({
        currentTier,
        directAtTier1Count,
        directAtPrevTierCount,
      });
      if (nextTier == null) {
        break;
      }
      currentTier = nextTier;
    }
  }

  if (currentTier === previousTier) {
    return {
      userId,
      previousTier,
      currentTier,
      upgraded: false,
      referrerId: (user as any).referrerId ?? null,
    };
  }

  await (client as any).user.update({
    where: { id: userId },
    data: {
      affiliateTier: currentTier,
      affiliateNote: `Auto-upgraded by referral rules to V${currentTier}`,
    },
  });

  return {
    userId,
    previousTier,
    currentTier,
    upgraded: true,
    referrerId: (user as any).referrerId ?? null,
  };
}

export async function applyAffiliateTierAutoUpgradeCascade(
  startUserId: number | null | undefined,
  client: PrismaClientLike = prisma,
): Promise<
  Array<{
    userId: number;
    previousTier: number;
    currentTier: number;
  }>
> {
  if (!startUserId) {
    return [];
  }

  const upgrades: Array<{
    userId: number;
    previousTier: number;
    currentTier: number;
  }> = [];
  const visited = new Set<number>();
  let currentUserId: number | null = startUserId;

  while (currentUserId != null && !visited.has(currentUserId)) {
    visited.add(currentUserId);
    const result = await applyAffiliateTierAutoUpgradeForUser(currentUserId, client);
    if (!result.upgraded) {
      break;
    }
    upgrades.push({
      userId: result.userId,
      previousTier: result.previousTier,
      currentTier: result.currentTier,
    });
    currentUserId = result.referrerId;
  }

  return upgrades;
}
