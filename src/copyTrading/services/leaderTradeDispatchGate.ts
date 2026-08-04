import { CopyTradeStatus } from '../../generated/prisma/enums';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { isCopyTradeErrorRetryable } from './copyRetryPolicy';
import {
  allowNoRowsRedispatch,
  shouldReenqueueFromCounts,
  type LeaderTradeReenqueueCounts,
} from './leaderTradeReenqueueLogic';

export async function buildLeaderTradeRedispatchCounts(
  leaderTradeId: string
): Promise<LeaderTradeReenqueueCounts> {
  const lt = await prisma.leaderTrade.findUnique({
    where: { id: leaderTradeId },
    select: { processed: true, leaderId: true, side: true },
  });

  const emptyCounts: LeaderTradeReenqueueCounts = {
    noRowsWithEnabledSubs: false,
    queuedCount: 0,
    submittingStaleCount: 0,
    hasRetryableFailedUnderMax: false,
  };

  if (!lt) {
    return emptyCounts;
  }

  const rowCount = await prisma.copyTradeRow.count({ where: { leaderTradeId } });
  if (rowCount === 0) {
    if (!lt.leaderId) {
      return emptyCounts;
    }
    // processed BUY 空跑不再补派发；processed SELL 无行仍可补（fundingPaused 订阅）。
    if (!allowNoRowsRedispatch({ processed: lt.processed, side: lt.side })) {
      return emptyCounts;
    }
    const includeFundingPaused = lt.side === 'SELL';
    const subs = await prisma.copySubscription.count({
      where: {
        leaderId: lt.leaderId,
        deletedAt: null,
        OR: [
          { enabled: true },
          ...(includeFundingPaused
            ? [{ enabled: false, fundingPausedAt: { not: null } }]
            : []),
        ],
      },
    });
    return {
      ...emptyCounts,
      noRowsWithEnabledSubs: subs > 0,
    };
  }

  const queuedCount = await prisma.copyTradeRow.count({
    where: { leaderTradeId, status: CopyTradeStatus.queued },
  });

  const staleBefore = new Date(Date.now() - CONFIG.copyStaleSubmittingMs);
  const submittingStaleCount = await prisma.copyTradeRow.count({
    where: {
      leaderTradeId,
      status: CopyTradeStatus.submitting,
      updatedAt: { lt: staleBefore },
    },
  });

  const failedRows = await prisma.copyTradeRow.findMany({
    where: { leaderTradeId, status: CopyTradeStatus.failed },
    select: { errorCode: true, retryCount: true },
  });
  const hasRetryableFailedUnderMax = failedRows.some(
    (r) => isCopyTradeErrorRetryable(r.errorCode) && r.retryCount < CONFIG.copyMaxRetries
  );

  return {
    noRowsWithEnabledSubs: false,
    queuedCount,
    submittingStaleCount,
    hasRetryableFailedUnderMax,
  };
}

/** duplicate leader-signal 或需补派发时 */
export async function shouldRedispatchLeaderTrade(leaderTradeId: string): Promise<boolean> {
  const counts = await buildLeaderTradeRedispatchCounts(leaderTradeId);
  return shouldReenqueueFromCounts(counts);
}
