/** Strip internal user identifiers from API responses exposed to browsers. */

export function toPublicGasUser(user: {
  gasBalance?: unknown;
  referralPath?: string | null;
} | null | undefined) {
  if (!user) return null;
  const gasBalance =
    user.gasBalance == null
      ? '0'
      : typeof user.gasBalance === 'object' &&
          user.gasBalance !== null &&
          'toString' in user.gasBalance
        ? String((user.gasBalance as { toString: () => string }).toString())
        : String(user.gasBalance);
  return {
    gasBalance,
    referralPath: user.referralPath ?? null,
  };
}

export function toPublicGasPackageOrder<T extends { userId?: unknown }>(order: T) {
  const { userId: _userId, ...rest } = order;
  void _userId;
  return rest;
}

export type PublicDownlineRow = {
  parentInviteCode: string | null;
  depth: number;
  username: string;
  inviteCode: string;
  affiliateTier: number | null;
};

export function toPublicCopyRelation(relation: {
  id: string;
  leaderAddress: string;
  followerAddress: string;
  isActive: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}) {
  return {
    id: relation.id,
    leaderAddress: relation.leaderAddress,
    followerAddress: relation.followerAddress,
    isActive: relation.isActive,
    createdAt:
      relation.createdAt instanceof Date
        ? relation.createdAt.toISOString()
        : String(relation.createdAt),
    updatedAt:
      relation.updatedAt instanceof Date
        ? relation.updatedAt.toISOString()
        : String(relation.updatedAt),
  };
}
