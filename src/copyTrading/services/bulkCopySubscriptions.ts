import { prisma } from '../../db';
import { publishRobotControlEvent } from '../events/publishRobotControlEvent';
import { deleteCopySubscriptionForUser } from './deleteCopySubscription';
import {
  getCopyFundingSnapshot,
  isCopyFundingReady,
} from './copyFundingCheck';
import { clearCopyFundingPause } from './copyFundingMonitor';
import { ensureLeaderAndSubscriptionForUser } from './subscriptionSync';
import { checkSmartMoneyCopyPoolSubscription } from '../../services/smartMoney/smartMoneyCopyPoolSubscribeGate';

export const BULK_COPY_SUBSCRIPTION_MAX = 50;

export type BulkCopySubscriptionAction = 'pause' | 'resume' | 'delete';

export type BulkCopySubscriptionResultItem = {
  leaderAddress: string;
  ok: boolean;
  subscriptionId?: string;
  error?: string;
};

export type BulkCopySubscriptionResponse = {
  action: BulkCopySubscriptionAction;
  total: number;
  succeeded: number;
  failed: number;
  results: BulkCopySubscriptionResultItem[];
};

export class BulkCopyFundingRequiredError extends Error {
  readonly funding: Awaited<ReturnType<typeof getCopyFundingSnapshot>>;

  constructor(funding: Awaited<ReturnType<typeof getCopyFundingSnapshot>>) {
    super('COPY_FUNDING_REQUIRED');
    this.name = 'BulkCopyFundingRequiredError';
    this.funding = funding;
  }
}

function normalizeLeaderAddresses(leaderAddresses: string[]): string[] {
  return [
    ...new Set(
      leaderAddresses
        .map((address) => address.trim().toLowerCase())
        .filter((address) => /^0x[a-f0-9]{40}$/.test(address))
    ),
  ].slice(0, BULK_COPY_SUBSCRIPTION_MAX);
}

async function findUserSubscription(userId: number, leaderAddress: string) {
  return prisma.copySubscription.findFirst({
    where: {
      userId,
      deletedAt: null,
      leader: { address: leaderAddress },
    },
    include: { leader: true },
  });
}

async function pauseCopySubscriptionForUser(
  userId: number,
  leaderAddress: string
): Promise<BulkCopySubscriptionResultItem> {
  const subscription = await findUserSubscription(userId, leaderAddress);
  if (!subscription) {
    return { leaderAddress, ok: false, error: 'NOT_FOUND' };
  }

  if (!subscription.enabled) {
    return {
      leaderAddress,
      ok: true,
      subscriptionId: subscription.id,
    };
  }

  await prisma.copyRelation.updateMany({
    where: { followerUserId: userId, leaderAddress },
    data: { isActive: false },
  });

  const sync = await ensureLeaderAndSubscriptionForUser({
    userId,
    leaderAddress,
    enabled: false,
  });

  await publishRobotControlEvent({
    subscriptionId: sync.subscriptionId,
    event: 'pause',
    userId,
    leaderId: sync.leaderId,
    leaderAddress: sync.leaderAddress,
  });

  return {
    leaderAddress,
    ok: true,
    subscriptionId: sync.subscriptionId,
  };
}

async function resumeCopySubscriptionForUser(
  userId: number,
  leaderAddress: string
): Promise<BulkCopySubscriptionResultItem> {
  const subscription = await findUserSubscription(userId, leaderAddress);
  if (!subscription) {
    return { leaderAddress, ok: false, error: 'NOT_FOUND' };
  }

  const effectiveEnabled = subscription.enabled && subscription.leader.enabled;
  if (effectiveEnabled) {
    return {
      leaderAddress,
      ok: true,
      subscriptionId: subscription.id,
    };
  }

  if (!subscription.leader.enabled) {
    return { leaderAddress, ok: false, error: 'LEADER_DISABLED' };
  }

  const copyPoolCheck = await checkSmartMoneyCopyPoolSubscription(leaderAddress);
  if (!copyPoolCheck.allowed) {
    return { leaderAddress, ok: false, error: copyPoolCheck.warningCode ?? 'NOT_IN_COPY_POOL' };
  }

  const existingRel = await prisma.copyRelation.findUnique({
    where: {
      leaderAddress_followerUserId: {
        leaderAddress,
        followerUserId: userId,
      },
    } as any,
  });

  await prisma.copyRelation.updateMany({
    where: { followerUserId: userId, leaderAddress },
    data: { isActive: true },
  });

  const sync = await ensureLeaderAndSubscriptionForUser({
    userId,
    leaderAddress,
    enabled: true,
  });

  const isActivatingCopy = !existingRel || existingRel.isActive === false;
  await publishRobotControlEvent({
    subscriptionId: sync.subscriptionId,
    event: isActivatingCopy ? 'resume' : 'modify',
    userId,
    leaderId: sync.leaderId,
    leaderAddress: sync.leaderAddress,
  });

  return {
    leaderAddress,
    ok: true,
    subscriptionId: sync.subscriptionId,
  };
}

async function deleteCopySubscriptionItem(
  userId: number,
  leaderAddress: string
): Promise<BulkCopySubscriptionResultItem> {
  const deleted = await deleteCopySubscriptionForUser({ userId, leaderAddress });
  if (!deleted) {
    return { leaderAddress, ok: false, error: 'NOT_FOUND' };
  }
  return {
    leaderAddress: deleted.leaderAddress,
    ok: true,
    subscriptionId: deleted.subscriptionId,
  };
}

async function assertBulkResumeFunding(userId: number, leaderAddresses: string[]): Promise<void> {
  const subscriptions = await prisma.copySubscription.findMany({
    where: {
      userId,
      deletedAt: null,
      leader: { address: { in: leaderAddresses } },
    },
    include: { leader: true },
  });

  const hasActivating = subscriptions.some(
    (subscription) => !(subscription.enabled && subscription.leader.enabled)
  );
  if (!hasActivating) {
    return;
  }

  const funding = await getCopyFundingSnapshot(userId);
  if (!isCopyFundingReady(funding)) {
    throw new BulkCopyFundingRequiredError(funding);
  }
  await clearCopyFundingPause({ userId });
}

export async function bulkCopySubscriptionsForUser(params: {
  userId: number;
  action: BulkCopySubscriptionAction;
  leaderAddresses: string[];
}): Promise<BulkCopySubscriptionResponse> {
  const leaderAddresses = normalizeLeaderAddresses(params.leaderAddresses);
  if (leaderAddresses.length === 0) {
    return {
      action: params.action,
      total: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    };
  }

  if (params.action === 'resume') {
    await assertBulkResumeFunding(params.userId, leaderAddresses);
  }

  const results: BulkCopySubscriptionResultItem[] = [];

  for (const leaderAddress of leaderAddresses) {
    try {
      if (params.action === 'pause') {
        results.push(await pauseCopySubscriptionForUser(params.userId, leaderAddress));
      } else if (params.action === 'resume') {
        results.push(await resumeCopySubscriptionForUser(params.userId, leaderAddress));
      } else {
        results.push(await deleteCopySubscriptionItem(params.userId, leaderAddress));
      }
    } catch (err) {
      results.push({
        leaderAddress,
        ok: false,
        error: err instanceof Error ? err.message : 'UNKNOWN_ERROR',
      });
    }
  }

  const succeeded = results.filter((item) => item.ok).length;

  return {
    action: params.action,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}
