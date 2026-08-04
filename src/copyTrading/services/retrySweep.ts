import { CopyTradeStatus } from '../../generated/prisma/enums';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { dispatchLeaderTrade } from './dispatchLeaderTrade';
import { isEligibleForRetrySweep, type CopyRetrySweepConfig } from './retrySweepLogic';

function sweepConfig(): CopyRetrySweepConfig {
  return {
    copyMaxRetries: CONFIG.copyMaxRetries,
    copyRetryBaseDelayMs: CONFIG.copyRetryBaseDelayMs,
    copyRetryMaxDelayMs: CONFIG.copyRetryMaxDelayMs,
  };
}

/** 将可重试的失败单置回 queued 并直接 dispatch（不经过 BullMQ） */
export async function sweepRetryableCopyTrades(): Promise<number> {
  const config = sweepConfig();
  const nowMs = Date.now();

  const rows = await prisma.copyTradeRow.findMany({
    where: {
      status: CopyTradeStatus.failed,
      retryCount: { lt: config.copyMaxRetries },
    },
    take: 500,
    orderBy: { updatedAt: 'asc' },
  });

  const eligible = rows.filter((row) => isEligibleForRetrySweep(row, nowMs, config));
  if (!eligible.length) {
    return 0;
  }

  const leaderTradeIds = new Set<string>();
  for (const row of eligible) {
    leaderTradeIds.add(row.leaderTradeId);
  }

  let n = 0;
  for (const leaderTradeId of leaderTradeIds) {
    const leaderEligibleIds = eligible
      .filter((r) => r.leaderTradeId === leaderTradeId)
      .map((r) => r.id);

    const updated = await prisma.copyTradeRow.updateMany({
      where: {
        id: { in: leaderEligibleIds },
        status: CopyTradeStatus.failed,
        retryCount: { lt: config.copyMaxRetries },
      },
      data: {
        status: CopyTradeStatus.queued,
        errorCode: null,
        errorMsg: null,
      },
    });

    if (updated.count < 1) {
      continue;
    }

    try {
      await dispatchLeaderTrade(leaderTradeId, 'retry_sweep');
      n++;
      console.log('[copy-retry-sweep] requeued retryable trades', {
        leaderTradeId,
        rowCount: updated.count,
      });
    } catch (error) {
      console.error('[copy-retry-sweep] dispatch failed', {
        leaderTradeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const skippedNonRetryable = rows.length - eligible.length;
  if (skippedNonRetryable > 0) {
    console.log('[copy-retry-sweep] skipped non-retryable or backoff', {
      skipped: skippedNonRetryable,
      eligible: eligible.length,
    });
  }

  return n;
}
