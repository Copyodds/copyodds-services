import { CONFIG } from '../../config/env';
import { runSmartMoneyCandidateSync } from './smartMoneyCandidateSync';
import {
  finishSmartMoneyBatchRun,
  startSmartMoneyBatchRun,
} from './smartMoneyBatchObservability';
import { snapshotConsumableBacklog } from './smartMoneyConsumableBacklog';

type SmartMoneyCandidatePipelineStats = {
  trigger: string;
  candidateSynced: boolean;
  candidateCount: number;
  createdCount: number;
  updatedCount: number;
  deactivatedCount: number;
  ingestedRaw: number;
  metadataRefreshed: number;
  discoveryPaused: boolean;
  mode: 'watermark' | 'full' | null;
  elapsedMs: number;
};

let candidateSyncRunning = false;

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * 带 AbortSignal 的超时：超时后 abort，让底层批处理尽快停，避免 orphan 继续占满 DB。
 */
function withTimeoutAbort<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return new Promise<T>((resolve, reject) => {
    factory(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          reject(new Error(`[smart-money-cron] ${label} timed out after ${timeoutMs}ms`));
          return;
        }
        reject(error);
      }
    );
  });
}

/**
 * 发现层同步（Phase E）：
 * 默认水位进货（线 A）+ 活跃元数据短写（线 B）；不再默认全量 ObservedTrader 镜像。
 * 不触发 Light/Deep（由独立 cron 负责）。
 */
export async function runSmartMoneyCandidatePipeline(
  trigger: string
): Promise<SmartMoneyCandidatePipelineStats> {
  if (candidateSyncRunning) {
    console.warn('[smart-money-cron] candidate pipeline skipped: already running', { trigger });
    finishSmartMoneyBatchRun(startSmartMoneyBatchRun('candidate', trigger), {
      skipped: true,
      skipReason: 'already_running',
    });
    return {
      trigger,
      candidateSynced: false,
      candidateCount: 0,
      createdCount: 0,
      updatedCount: 0,
      deactivatedCount: 0,
      ingestedRaw: 0,
      metadataRefreshed: 0,
      discoveryPaused: false,
      mode: null,
      elapsedMs: 0,
    };
  }

  const startedAt = Date.now();
  const run = startSmartMoneyBatchRun('candidate', trigger);
  const backlogBefore = await snapshotConsumableBacklog().catch(() => ({}));
  console.log('[smart-money-cron] candidate pipeline started', { trigger });

  let candidateStats: Awaited<ReturnType<typeof runSmartMoneyCandidateSync>> = null;
  candidateSyncRunning = true;
  try {
    candidateStats = await withTimeoutAbort(
      (signal) => runSmartMoneyCandidateSync({ signal }),
      CONFIG.smartMoneyCandidateSyncTimeoutMs,
      `candidate-sync (${trigger})`
    );
  } catch (error) {
    console.warn('[smart-money-cron] candidate sync failed', {
      trigger,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    candidateSyncRunning = false;
  }

  const stats: SmartMoneyCandidatePipelineStats = {
    trigger,
    candidateSynced: candidateStats != null,
    candidateCount: candidateStats?.uniqueWallets ?? 0,
    createdCount: candidateStats?.createdCount ?? 0,
    updatedCount: candidateStats?.updatedCount ?? 0,
    deactivatedCount: candidateStats?.deactivatedCount ?? 0,
    ingestedRaw: candidateStats?.ingestedRaw ?? 0,
    metadataRefreshed: candidateStats?.metadataRefreshed ?? 0,
    discoveryPaused: candidateStats?.discoveryPaused ?? false,
    mode: candidateStats?.mode ?? null,
    elapsedMs: Date.now() - startedAt,
  };

  console.log('[smart-money-cron] candidate pipeline finished', {
    trigger: stats.trigger,
    candidateSynced: stats.candidateSynced,
    mode: stats.mode,
    candidateCount: stats.candidateCount,
    ingestedRaw: stats.ingestedRaw,
    metadataRefreshed: stats.metadataRefreshed,
    discoveryPaused: stats.discoveryPaused,
    elapsed: formatDurationMs(stats.elapsedMs),
  });

  const backlogAfter = await snapshotConsumableBacklog().catch(() => backlogBefore);
  finishSmartMoneyBatchRun(run, {
    picked: stats.candidateCount,
    succeeded: stats.ingestedRaw + stats.metadataRefreshed,
    converted: stats.ingestedRaw,
    backlogBefore,
    backlogAfter,
    // 达到 RAW 目标水位后暂停 discovery 是健康流控，不应误报为堵塞。
    backpressure: false,
    bottleneck: null,
    extras: {
      candidateSynced: stats.candidateSynced,
      mode: stats.mode,
      createdCount: stats.createdCount,
      updatedCount: stats.updatedCount,
      deactivatedCount: stats.deactivatedCount,
      ingestedRaw: stats.ingestedRaw,
      metadataRefreshed: stats.metadataRefreshed,
      discoveryPaused: stats.discoveryPaused,
    },
  });

  return stats;
}
