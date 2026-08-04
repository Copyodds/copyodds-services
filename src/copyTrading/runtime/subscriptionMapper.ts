import type { CopySubscription, CopyLeader } from '../../generated/prisma/client';
import { normalizeLeaderAddress } from './normalizeLeaderAddress';
import { normalizeCopyMinNotionalMode } from '../services/subscriptionSync';
import type { RobotRuntimeState, UserWalletRuntimeSnapshot } from './types';

function decimalToNumber(value: { toString(): string } | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

export function mapSubscriptionToRuntimeState(
  sub: CopySubscription & { leader: Pick<CopyLeader, 'address'> },
  wallet: UserWalletRuntimeSnapshot | null,
  loadedAt: string = new Date().toISOString()
): RobotRuntimeState {
  const leaderAddress = normalizeLeaderAddress(sub.leader.address);
  return {
    robotId: sub.id,
    subscriptionId: sub.id,
    userId: sub.userId,
    leaderId: sub.leaderId,
    leaderAddress,
    enabled: true,
    copyMode: sub.copyMode,
    copyRatio: Number(sub.copyRatio.toString()),
    fixedAmountUsd: decimalToNumber(sub.fixedAmountUsd),
    minNotionalMode: normalizeCopyMinNotionalMode(sub.minNotionalMode, sub.copyMode),
    maxAmount: decimalToNumber(sub.maxAmount),
    minAmount: decimalToNumber(sub.minAmountUsd),
    slippage: decimalToNumber(sub.slippage),
    walletId: wallet?.walletId ?? null,
    executionAddress: wallet?.executionAddress ?? null,
    depositFunderAddress: wallet?.depositFunderAddress ?? null,
    hasClobCredentials: wallet?.hasClobCredentials ?? false,
    updatedAt: sub.updatedAt.toISOString(),
    loadedAt,
  };
}
