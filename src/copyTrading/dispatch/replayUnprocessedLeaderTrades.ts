import { CopyTradeStatus } from '../../generated/prisma/enums';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { dispatchLeaderTrade } from '../services/dispatchLeaderTrade';
import { shouldRedispatchLeaderTrade } from '../services/leaderTradeDispatchGate';
import { computeReplayPlanLimits } from './replayPlanning';

export type ReplayUnprocessedResult = {
  scanned: number;
  dispatched: number;
  errors: number;
  archivedNoRow: number;
};

type ReplayBucket = 'hot' | 'stale_submitting' | 'queued' | 'backfill' | 'processed_sell_without_rows';

type ReplayCandidate = {
  id: string;
  bucket: ReplayBucket;
};

type ReplayCollection = {
  candidates: ReplayCandidate[];
  archivedNoRow: number;
  backlog: {
    unprocessedCount: number;
    oldestUnprocessed: Date | null;
    newestUnprocessed: Date | null;
  };
  buckets: Record<ReplayBucket, number>;
};

async function archiveExpiredNoRowLeaderTrades(now: Date): Promise<number> {
  const ttl = CONFIG.copyDispatchReplayArchiveNoRowAfterMs;
  if (ttl <= 0) {
    return 0;
  }
  const archiveBefore = new Date(now.getTime() - ttl);
  const res = await prisma.leaderTrade.updateMany({
    where: {
      processed: false,
      createdAt: { lt: archiveBefore },
      copyTrades: { none: {} },
      OR: [
        { leaderId: null },
        { leader: { enabled: false } },
        {
          side: 'BUY',
          leader: {
            subscriptions: {
              none: { enabled: true, deletedAt: null },
            },
          },
        },
        {
          side: 'SELL',
          leader: {
            subscriptions: {
              none: {
                deletedAt: null,
                OR: [{ enabled: true }, { fundingPausedAt: { not: null } }],
              },
            },
          },
        },
      ],
    },
    data: { processed: true },
  });
  return res.count;
}

async function collectLeaderTradeIdsForReplay(limit: number): Promise<ReplayCollection> {
  const now = new Date();
  const since = new Date(Date.now() - CONFIG.copyDispatchReplayLookbackHours * 3600_000);
  const hotCutoff = new Date(now.getTime() - CONFIG.copyDispatchReplayHotWindowMs);
  const { hotLimit, backfillReserve } = computeReplayPlanLimits(
    limit,
    CONFIG.copyDispatchReplayBackfillRatio
  );
  const candidates: ReplayCandidate[] = [];
  const ids = new Set<string>();
  const buckets: Record<ReplayBucket, number> = {
    hot: 0,
    stale_submitting: 0,
    queued: 0,
    backfill: 0,
    processed_sell_without_rows: 0,
  };

  const archivedNoRow = await archiveExpiredNoRowLeaderTrades(now);

  const backlogAgg = await prisma.leaderTrade.aggregate({
    where: {
      processed: false,
      createdAt: { gte: since },
    },
    _count: { _all: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
  });

  const add = (id: string, bucket: ReplayBucket) => {
    if (ids.has(id) || ids.size >= limit) return;
    ids.add(id);
    candidates.push({ id, bucket });
    buckets[bucket] += 1;
  };

  const hotUnprocessed = await prisma.leaderTrade.findMany({
    where: {
      processed: false,
      createdAt: { gte: hotCutoff },
    },
    orderBy: { createdAt: 'desc' },
    take: hotLimit,
    select: { id: true },
  });
  for (const row of hotUnprocessed) {
    add(row.id, 'hot');
  }

  if (ids.size >= limit) {
    return {
      candidates,
      archivedNoRow,
      backlog: {
        unprocessedCount: backlogAgg._count._all,
        oldestUnprocessed: backlogAgg._min.createdAt,
        newestUnprocessed: backlogAgg._max.createdAt,
      },
      buckets,
    };
  }

  const staleBefore = new Date(Date.now() - CONFIG.copyStaleSubmittingMs);
  const staleSubmitting = await prisma.copyTradeRow.findMany({
    where: {
      status: CopyTradeStatus.submitting,
      updatedAt: { lt: staleBefore },
      leaderTrade: { createdAt: { gte: since } },
    },
    distinct: ['leaderTradeId'],
    take: limit - ids.size,
    select: { leaderTradeId: true },
  });
  for (const row of staleSubmitting) {
    add(row.leaderTradeId, 'stale_submitting');
  }

  if (ids.size >= limit) {
    return {
      candidates,
      archivedNoRow,
      backlog: {
        unprocessedCount: backlogAgg._count._all,
        oldestUnprocessed: backlogAgg._min.createdAt,
        newestUnprocessed: backlogAgg._max.createdAt,
      },
      buckets,
    };
  }

  /** retry sweep 置回 queued 后若 leader 已 processed，需靠此处补派发 */
  const stuckQueued = await prisma.copyTradeRow.findMany({
    where: {
      status: CopyTradeStatus.queued,
      leaderTrade: { createdAt: { gte: since } },
    },
    distinct: ['leaderTradeId'],
    take: limit - ids.size,
    select: { leaderTradeId: true },
  });
  for (const row of stuckQueued) {
    add(row.leaderTradeId, 'queued');
  }

  if (ids.size >= limit) {
    return {
      candidates,
      archivedNoRow,
      backlog: {
        unprocessedCount: backlogAgg._count._all,
        oldestUnprocessed: backlogAgg._min.createdAt,
        newestUnprocessed: backlogAgg._max.createdAt,
      },
      buckets,
    };
  }

  const backfillTake = Math.max(backfillReserve, limit - ids.size);
  const backfillUnprocessed = await prisma.leaderTrade.findMany({
    where: {
      processed: false,
      createdAt: { gte: since, lt: hotCutoff },
    },
    orderBy: { createdAt: 'desc' },
    take: backfillTake,
    select: { id: true },
  });
  for (const row of backfillUnprocessed) {
    add(row.id, 'backfill');
  }

  if (ids.size >= limit) {
    return {
      candidates,
      archivedNoRow,
      backlog: {
        unprocessedCount: backlogAgg._count._all,
        oldestUnprocessed: backlogAgg._min.createdAt,
        newestUnprocessed: backlogAgg._max.createdAt,
      },
      buckets,
    };
  }

  const processedSellWithoutRows = await prisma.leaderTrade.findMany({
    where: {
      processed: true,
      side: 'SELL',
      createdAt: { gte: since },
      copyTrades: { none: {} },
    },
    orderBy: { createdAt: 'asc' },
    take: limit - ids.size,
    select: { id: true },
  });
  for (const row of processedSellWithoutRows) {
    add(row.id, 'processed_sell_without_rows');
  }

  return {
    candidates,
    archivedNoRow,
    backlog: {
      unprocessedCount: backlogAgg._count._all,
      oldestUnprocessed: backlogAgg._min.createdAt,
      newestUnprocessed: backlogAgg._max.createdAt,
    },
    buckets,
  };
}

export async function replayUnprocessedLeaderTrades(
  limit = CONFIG.copyDispatchReplayLimit
): Promise<ReplayUnprocessedResult> {
  const collection = await collectLeaderTradeIdsForReplay(limit);
  const candidates = collection.candidates;

  console.log('[copy-dispatch-replay] found', {
    count: candidates.length,
    limit,
    lookbackHours: CONFIG.copyDispatchReplayLookbackHours,
    hotWindowMs: CONFIG.copyDispatchReplayHotWindowMs,
    archivedNoRow: collection.archivedNoRow,
    buckets: collection.buckets,
    backlog: {
      unprocessedCount: collection.backlog.unprocessedCount,
      oldestUnprocessed: collection.backlog.oldestUnprocessed?.toISOString() ?? null,
      newestUnprocessed: collection.backlog.newestUnprocessed?.toISOString() ?? null,
    },
  });

  let dispatched = 0;
  let errors = 0;

  for (const candidate of candidates) {
    const leaderTradeId = candidate.id;
    try {
      const lt = await prisma.leaderTrade.findUnique({
        where: { id: leaderTradeId },
        select: { processed: true },
      });
      if (!lt) {
        continue;
      }
      const needs =
        !lt.processed || (await shouldRedispatchLeaderTrade(leaderTradeId));
      if (!needs) {
        continue;
      }
      console.log('[copy-dispatch-replay] dispatching', {
        leaderTradeId,
        processed: lt.processed,
        bucket: candidate.bucket,
      });
      await dispatchLeaderTrade(leaderTradeId, 'replay');
      dispatched++;
    } catch (error) {
      errors++;
      console.error('[copy-dispatch-replay] error', {
        leaderTradeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log('[copy-dispatch-replay] done', {
    scanned: candidates.length,
    dispatched,
    errors,
    archivedNoRow: collection.archivedNoRow,
  });

  return { scanned: candidates.length, dispatched, errors, archivedNoRow: collection.archivedNoRow };
}
