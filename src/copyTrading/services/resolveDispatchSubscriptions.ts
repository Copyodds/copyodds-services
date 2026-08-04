import type { CopySubscription } from '../../generated/prisma/client';
import { prisma } from '../../db';
import type { RobotRuntimeManager } from '../runtime/RobotRuntimeManager';

/**
 * Runtime 优先选 subscriptionId；真实下单数据必须经 DB 二次过滤（enabled=true + leaderId）。
 * Runtime 空 / 异常 / DB 无 enabled 行时 fallback 全量 DB，避免漏单；mismatch 仅 warn 不阻断。
 */
export type DispatchSubscriptionSource = 'runtime' | 'runtime_fallback_db';

export type ResolveDispatchSubscriptionsResult = {
  subscriptions: CopySubscription[];
  source: DispatchSubscriptionSource;
  runtimeCount: number;
  dbCount: number;
  fallbackReason?: string;
};

export type ResolveDispatchSubscriptionsDeps = {
  findAllEnabledForLeader: (
    leaderId: string,
    options?: { includeFundingPaused?: boolean }
  ) => Promise<CopySubscription[]>;
  findEnabledByIdsForLeader: (
    leaderId: string,
    subscriptionIds: string[],
    options?: { includeFundingPaused?: boolean }
  ) => Promise<CopySubscription[]>;
};

const defaultDeps: ResolveDispatchSubscriptionsDeps = {
  findAllEnabledForLeader: (leaderId, options) =>
    prisma.copySubscription.findMany({
      where: {
        leaderId,
        deletedAt: null,
        leader: { enabled: true },
        OR: [
          { enabled: true },
          ...(options?.includeFundingPaused
            ? [{ enabled: false, fundingPausedAt: { not: null } }]
            : []),
        ],
      },
    }),
  findEnabledByIdsForLeader: (leaderId, subscriptionIds, options) =>
    prisma.copySubscription.findMany({
      where: {
        id: { in: subscriptionIds },
        leaderId,
        deletedAt: null,
        leader: { enabled: true },
        OR: [
          { enabled: true },
          ...(options?.includeFundingPaused
            ? [{ enabled: false, fundingPausedAt: { not: null } }]
            : []),
        ],
      },
    }),
};

function logRuntimeDispatchMismatch(params: {
  leaderAddress: string;
  runtimeCount: number;
  dbCount: number;
  runtimeSubscriptionIds: string[];
  dbSubscriptionIds: string[];
  reason: string;
}): void {
  const dbSet = new Set(params.dbSubscriptionIds);
  const runtimeSet = new Set(params.runtimeSubscriptionIds);
  const missingSubscriptionIds = params.runtimeSubscriptionIds.filter((id) => !dbSet.has(id));
  const extraSubscriptionIds = params.dbSubscriptionIds.filter((id) => !runtimeSet.has(id));

  console.warn('[copy-runtime-dispatch-mismatch]', {
    leaderAddress: params.leaderAddress,
    runtimeCount: params.runtimeCount,
    dbCount: params.dbCount,
    missingSubscriptionIds,
    extraSubscriptionIds,
    reason: params.reason,
  });
}

async function fetchAllEnabledForLeader(
  leaderId: string,
  deps: ResolveDispatchSubscriptionsDeps,
  fallbackReason: string,
  runtimeCount: number,
  options?: { includeFundingPaused?: boolean }
): Promise<ResolveDispatchSubscriptionsResult> {
  const subscriptions = await deps.findAllEnabledForLeader(leaderId, options);
  return {
    subscriptions,
    source: 'runtime_fallback_db',
    runtimeCount,
    dbCount: subscriptions.length,
    fallbackReason,
  };
}

export async function resolveDispatchSubscriptionsForLeader(params: {
  leaderId: string;
  leaderAddress: string;
  runtimeManager: Pick<RobotRuntimeManager, 'getByLeaderAddress'>;
  includeFundingPaused?: boolean;
  deps?: ResolveDispatchSubscriptionsDeps;
}): Promise<ResolveDispatchSubscriptionsResult> {
  const deps = params.deps ?? defaultDeps;
  const { leaderId, leaderAddress, runtimeManager } = params;

  try {
    const runtimeStates = runtimeManager.getByLeaderAddress(leaderAddress);
    const runtimeSubscriptionIds = runtimeStates.map((s) => s.subscriptionId);
    const runtimeCount = runtimeSubscriptionIds.length;

    if (runtimeCount === 0) {
      return fetchAllEnabledForLeader(leaderId, deps, 'runtime_empty', 0, {
        includeFundingPaused: params.includeFundingPaused,
      });
    }

    const subscriptions = await deps.findEnabledByIdsForLeader(leaderId, runtimeSubscriptionIds, {
      includeFundingPaused: params.includeFundingPaused,
    });

    if (subscriptions.length === 0) {
      return fetchAllEnabledForLeader(leaderId, deps, 'runtime_ids_no_enabled_db_rows', runtimeCount, {
        includeFundingPaused: params.includeFundingPaused,
      });
    }

    if (runtimeCount !== subscriptions.length) {
      logRuntimeDispatchMismatch({
        leaderAddress,
        runtimeCount,
        dbCount: subscriptions.length,
        runtimeSubscriptionIds,
        dbSubscriptionIds: subscriptions.map((s) => s.id),
        reason: 'runtime_db_count_mismatch',
      });
    }

    return {
      subscriptions,
      source: 'runtime',
      runtimeCount,
      dbCount: subscriptions.length,
    };
  } catch (error) {
    console.warn('[copy-runtime-dispatch-fallback]', {
      leaderAddress,
      reason: 'runtime_error',
      runtimeCount: 0,
      dbCount: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    return fetchAllEnabledForLeader(leaderId, deps, 'runtime_error', 0, {
      includeFundingPaused: params.includeFundingPaused,
    });
  }
}
