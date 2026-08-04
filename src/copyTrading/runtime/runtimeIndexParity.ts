import type { RobotRuntimeState } from './types';
import { normalizeLeaderAddress } from './normalizeLeaderAddress';

export function logRuntimeDbParity(params: {
  leaderAddress: string;
  dbSubscriptionIds: string[];
  runtimeStates: RobotRuntimeState[];
}): void {
  const leaderKey = normalizeLeaderAddress(params.leaderAddress);
  const dbSet = new Set(params.dbSubscriptionIds);
  const runtimeSet = new Set(params.runtimeStates.map((s) => s.subscriptionId));

  const missingSubscriptionIds = params.dbSubscriptionIds.filter((id) => !runtimeSet.has(id));
  const extraSubscriptionIds = [...runtimeSet].filter((id) => !dbSet.has(id));

  const dbCount = dbSet.size;
  const runtimeCount = runtimeSet.size;

  if (
    dbCount === runtimeCount &&
    missingSubscriptionIds.length === 0 &&
    extraSubscriptionIds.length === 0
  ) {
    return;
  }

  console.warn('[copy-runtime-parity] DB vs runtime subscription index mismatch', {
    leaderAddress: leaderKey,
    dbCount,
    runtimeCount,
    missingSubscriptionIds,
    extraSubscriptionIds,
  });
}
