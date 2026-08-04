import type { Server } from 'node:http';
import { CONFIG } from '../config/env';
import { runAutoRedeemSweep, runRedeemExecutionReconcileSweep } from '../services/cron/redeemCron';
import { runLeaderboardSync } from '../services/cron/leaderboardCron';
import { runSmartMoneyCandidatePipeline } from '../services/smartMoney/smartMoneyCron';
import {
  runSmartMoneyPipelineDeepBatch,
  runSmartMoneyPipelineLightBatch,
  runSmartMoneyGammaEnrichmentBatch,
  runSmartMoneyCurveEnrichmentBatch,
} from '../services/smartMoney/smartMoneyPipelineCron';
import { runSmartMoneyEliminatedRecheckBatch } from '../services/smartMoney/smartMoneyEliminated';
import { runSmartMoneyRawRefillTick } from '../services/smartMoney/smartMoneyRawRefill';
import { runSmartMoneyCopyabilityEnrichmentBatch } from '../services/smartMoney/smartMoneyCopyabilityEnrich';
import { runSmartMoneyClosedPrefetchBatch } from '../services/smartMoney/smartMoneyClosedPrefetch';
import { runSmartMoneyClosedFullEnrichBatch } from '../services/smartMoney/smartMoneyClosedFullEnrich';
import { runSmartMoneyRankRefreshBatch } from '../services/smartMoney/smartMoneyRankRefresh';
import { flushSmartMoneyRankRecomputeIfDirty } from '../services/smartMoney/smartMoneyLeaderboardWriter';
import { checkCopyPoolTopNDailySla } from '../services/smartMoney/smartMoneyCopyPoolSla';
import { acquireCronLease, releaseCronLease } from '../services/cron/cronLease';
import {
  runAdminDashboardDailyCron,
  runAdminDashboardRuntimeCron,
  runAdminDashboardStatsCron,
} from '../services/adminDashboard/adminDashboardCron';
import { processVirtualAccountLifecycle } from '../virtualCopyTrading/virtualCopyLifecycle';

const CRON_MAX_JITTER_MS = 15_000;
const CRON_LEASE_OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

type CronController = {
  stop: () => void;
};

function getCronJitterMs(intervalMs: number): number {
  if (intervalMs <= 60_000) {
    return 0;
  }
  const upperBound = Math.min(CRON_MAX_JITTER_MS, Math.floor(intervalMs * 0.1));
  if (upperBound <= 0) {
    return 0;
  }
  return Math.floor(Math.random() * (upperBound + 1));
}

function scheduleCronJob(
  name: string,
  intervalMs: number,
  task: () => Promise<unknown>,
  options?: { initialDelayMs?: number }
): CronController {
  let stopped = false;
  let timeout: NodeJS.Timeout | null = null;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    const jitterMs = getCronJitterMs(intervalMs);
    timeout = setTimeout(runOnce, intervalMs + jitterMs);
  };

  const runOnce = () => {
    if (stopped) {
      return;
    }
    timeout = null;
    task()
      .catch((e) => console.error(`[${name}] run error`, e))
      .finally(scheduleNext);
  };

  const initialDelayMs = Math.max(0, options?.initialDelayMs ?? 0);
  if (initialDelayMs > 0) {
    console.log(`[${name}] initial jitter ${initialDelayMs}ms`);
  }
  timeout = setTimeout(runOnce, initialDelayMs);

  return {
    stop() {
      stopped = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    },
  };
}

function withCronLease(
  name: string,
  leaseKey: string,
  intervalMs: number,
  task: () => Promise<unknown>,
): () => Promise<void> {
  // 租约 TTL：至少 5min、默认约 3×间隔；但必须封顶。
  // 否则 candidate 间隔 6h～24h 时 TTL 可达 18h～72h，进程被 pm2 杀掉后
  // 新实例会一直 skipped: lease held，表现为「永远没有 pipeline started」。
  const ttlMs = Math.min(Math.max(intervalMs * 3, 5 * 60_000), 2 * 60 * 60_000);
  return async () => {
    const leaseAcquired = await acquireCronLease(leaseKey, CRON_LEASE_OWNER, ttlMs);
    if (!leaseAcquired) {
      console.log(`[${name}] skipped: lease held by another instance`, {
        leaseKey,
        owner: CRON_LEASE_OWNER,
      });
      return;
    }
    try {
      await task();
    } finally {
      try {
        await releaseCronLease(leaseKey, CRON_LEASE_OWNER);
      } catch (error) {
        console.warn(`[${name}] failed to release lease`, {
          leaseKey,
          owner: CRON_LEASE_OWNER,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}

/**
 * 聪明钱管道 cron（candidate / light / deep / gamma / curve-enrich / rank）。
 * API 与独立 worker 共用；双跑靠 SMART_MONEY_CRONS_IN_API + lease。
 */
export function createSmartMoneyCronControllers(): CronController[] {
  if (!CONFIG.smartMoneyCronEnabled) {
    return [];
  }

  const controllers: CronController[] = [];

  if (CONFIG.smartMoneyCandidateSyncOnStart) {
    const startDelay = Math.max(30_000, CONFIG.smartMoneyCandidateFirstDelayMs);
    console.log(
      `[smart-money-cron] deferred candidate sync on start in ${startDelay}ms (SMART_MONEY_CANDIDATE_SYNC_ON_START)`
    );
    const startTimer = setTimeout(() => {
      runSmartMoneyCandidatePipeline('server-start').catch((e: unknown) =>
        console.error('[smart-money-cron] deferred candidate pipeline error', e)
      );
    }, startDelay);
    controllers.push({
      stop() {
        clearTimeout(startTimer);
      },
    });
  }

  controllers.push(
    scheduleCronJob(
      'smart-money-cron',
      CONFIG.smartMoneyCandidateIntervalMs,
      withCronLease(
        'smart-money-candidate-cron',
        'smart-money-candidate-cron',
        CONFIG.smartMoneyCandidateIntervalMs,
        () => runSmartMoneyCandidatePipeline('interval:candidate-refresh'),
      ),
      {
        initialDelayMs:
          CONFIG.smartMoneyCandidateFirstDelayMs +
          getCronJitterMs(CONFIG.smartMoneyCandidateFirstDelayMs),
      },
    ),
  );

  controllers.push(
    scheduleCronJob(
      'smart-money-fetch-cron',
      CONFIG.smartMoneyLightFetchIntervalMs,
      withCronLease(
        'smart-money-fetch-cron',
        'smart-money-fetch-cron',
        CONFIG.smartMoneyLightFetchIntervalMs,
        () => runSmartMoneyPipelineLightBatch('interval:light'),
      ),
      {
        initialDelayMs:
          CONFIG.smartMoneyLightFetchIntervalMs +
          getCronJitterMs(CONFIG.smartMoneyLightFetchIntervalMs),
      },
    ),
  );

  controllers.push(
    scheduleCronJob(
      'smart-money-deep-cron',
      CONFIG.smartMoneyDeepFetchIntervalMs,
      withCronLease(
        'smart-money-deep-cron',
        'smart-money-deep-cron',
        CONFIG.smartMoneyDeepFetchIntervalMs,
        () => runSmartMoneyPipelineDeepBatch('interval:deep'),
      ),
      {
        initialDelayMs:
          CONFIG.smartMoneyDeepFetchIntervalMs +
          getCronJitterMs(CONFIG.smartMoneyDeepFetchIntervalMs),
      },
    ),
  );

  if (CONFIG.smartMoneyClosedPrefetchEnabled) {
    controllers.push(
      scheduleCronJob(
        'smart-money-closed-prefetch-cron',
        CONFIG.smartMoneyClosedPrefetchIntervalMs,
        withCronLease(
          'smart-money-closed-prefetch-cron',
          'smart-money-closed-prefetch-cron',
          CONFIG.smartMoneyClosedPrefetchIntervalMs,
          async () => {
            const result = await runSmartMoneyClosedPrefetchBatch('interval:closed-prefetch');
            if (result.picked > 0 || result.pagesFetched > 0) {
              console.log('[smart-money-closed-prefetch]', result);
            }
          },
        ),
        {
          initialDelayMs:
            Math.floor(CONFIG.smartMoneyClosedPrefetchIntervalMs / 2) +
            getCronJitterMs(CONFIG.smartMoneyClosedPrefetchIntervalMs),
        },
      ),
    );
  }

  if (CONFIG.smartMoneyClosedFullEnrichEnabled) {
    controllers.push(
      scheduleCronJob(
        'smart-money-closed-full-enrich-cron',
        CONFIG.smartMoneyClosedFullEnrichIntervalMs,
        withCronLease(
          'smart-money-closed-full-enrich-cron',
          'smart-money-closed-full-enrich-cron',
          CONFIG.smartMoneyClosedFullEnrichIntervalMs,
          async () => {
            const result = await runSmartMoneyClosedFullEnrichBatch('interval:closed-full-enrich');
            if (result.picked > 0) {
              console.log('[smart-money-closed-full-enrich]', result);
            }
          },
        ),
        {
          initialDelayMs:
            CONFIG.smartMoneyClosedFullEnrichIntervalMs +
            getCronJitterMs(CONFIG.smartMoneyClosedFullEnrichIntervalMs),
        },
      ),
    );
  }

  // 排名重排 flush：Deep/Gamma/Rank 批只置脏标记，这里低频合并执行一次全榜重排。
  // 脏标记是进程内状态，不走 lease（谁标脏谁 flush）。
  controllers.push(
    scheduleCronJob(
      'smart-money-rank-recompute-cron',
      CONFIG.smartMoneyRankRecomputeIntervalMs,
      async () => {
        const result = await flushSmartMoneyRankRecomputeIfDirty();
        if (result.ran) {
          console.log('[smart-money-rank-recompute] flushed', {
            topCount: result.topCount,
            clearedCount: result.clearedCount,
          });
        }
      },
      { initialDelayMs: CONFIG.smartMoneyRankRecomputeIntervalMs },
    ),
  );

  if (CONFIG.smartMoneyGammaEnrichmentEnabled) {
    controllers.push(
      scheduleCronJob(
        'smart-money-gamma-cron',
        CONFIG.smartMoneyGammaEnrichmentIntervalMs,
        withCronLease(
          'smart-money-gamma-cron',
          'smart-money-gamma-cron',
          CONFIG.smartMoneyGammaEnrichmentIntervalMs,
          () => runSmartMoneyGammaEnrichmentBatch('interval:gamma'),
        ),
        {
          initialDelayMs:
            CONFIG.smartMoneyGammaEnrichmentIntervalMs +
            getCronJitterMs(CONFIG.smartMoneyGammaEnrichmentIntervalMs),
        },
      ),
    );
  }

  if (CONFIG.smartMoneyCurveEnrichEnabled) {
    controllers.push(
      scheduleCronJob(
        'smart-money-curve-enrich-cron',
        CONFIG.smartMoneyCurveEnrichIntervalMs,
        withCronLease(
          'smart-money-curve-enrich-cron',
          'smart-money-curve-enrich-cron',
          CONFIG.smartMoneyCurveEnrichIntervalMs,
          () => runSmartMoneyCurveEnrichmentBatch('interval:curve-enrich'),
        ),
        {
          initialDelayMs:
            CONFIG.smartMoneyCurveEnrichIntervalMs +
            getCronJitterMs(CONFIG.smartMoneyCurveEnrichIntervalMs),
        },
      ),
    );
  }

  if (CONFIG.smartMoneyEliminatedCronEnabled) {
    controllers.push(
      scheduleCronJob(
        'smart-money-eliminated-cron',
        CONFIG.smartMoneyEliminatedIntervalMs,
        withCronLease(
          'smart-money-eliminated-cron',
          'smart-money-eliminated-cron',
          CONFIG.smartMoneyEliminatedIntervalMs,
          async () => {
            const result = await runSmartMoneyEliminatedRecheckBatch();
            console.log('[smart-money-eliminated] recheck', result);
          },
        ),
        {
          initialDelayMs:
            CONFIG.smartMoneyEliminatedIntervalMs +
            getCronJitterMs(CONFIG.smartMoneyEliminatedIntervalMs),
        },
      ),
    );
  }

  if (CONFIG.smartMoneyRawRefillCronEnabled) {
    controllers.push(
      scheduleCronJob(
        'smart-money-raw-refill-cron',
        CONFIG.smartMoneyRawRefillIntervalMs,
        withCronLease(
          'smart-money-raw-refill-cron',
          'smart-money-raw-refill-cron',
          CONFIG.smartMoneyRawRefillIntervalMs,
          async () => {
            const result = await runSmartMoneyRawRefillTick();
            if (result && (result.ingested > 0 || result.shortfall > 0)) {
              console.log('[smart-money-raw-refill] tick', result);
            }
          },
        ),
        {
          initialDelayMs:
            CONFIG.smartMoneyRawRefillIntervalMs +
            getCronJitterMs(CONFIG.smartMoneyRawRefillIntervalMs),
        },
      ),
    );
  }

  if (CONFIG.smartMoneyCopyabilityEnrichEnabled && CONFIG.smartMoneyCopyabilityEnabled) {
    controllers.push(
      scheduleCronJob(
        'smart-money-copyability-enrich-cron',
        CONFIG.smartMoneyCopyabilityEnrichIntervalMs,
        withCronLease(
          'smart-money-copyability-enrich-cron',
          'smart-money-copyability-enrich-cron',
          CONFIG.smartMoneyCopyabilityEnrichIntervalMs,
          () => runSmartMoneyCopyabilityEnrichmentBatch('interval:copyability-enrich'),
        ),
        {
          initialDelayMs:
            CONFIG.smartMoneyCopyabilityEnrichIntervalMs +
            getCronJitterMs(CONFIG.smartMoneyCopyabilityEnrichIntervalMs),
        },
      ),
    );
  }

  if (CONFIG.smartMoneyRankModelEnabled && CONFIG.smartMoneyCopyabilityEnabled) {
    controllers.push(
      scheduleCronJob(
        'smart-money-rank-cron',
        CONFIG.smartMoneyRankRefreshIntervalMs,
        withCronLease(
          'smart-money-rank-cron',
          'smart-money-rank-cron',
          CONFIG.smartMoneyRankRefreshIntervalMs,
          () => runSmartMoneyRankRefreshBatch('interval:rank'),
        ),
        {
          initialDelayMs:
            CONFIG.smartMoneyRankRefreshIntervalMs +
            getCronJitterMs(CONFIG.smartMoneyRankRefreshIntervalMs),
        },
      ),
    );
  }

  if (CONFIG.smartMoneyCopyPoolSlaCronEnabled) {
    controllers.push(
      scheduleCronJob(
        'smart-money-copy-pool-sla-cron',
        CONFIG.smartMoneyCopyPoolSlaIntervalMs,
        withCronLease(
          'smart-money-copy-pool-sla-cron',
          'smart-money-copy-pool-sla-cron',
          CONFIG.smartMoneyCopyPoolSlaIntervalMs,
          async () => {
            const result = await checkCopyPoolTopNDailySla();
            if (result.checked) {
              console.log('[smart-money-copy-pool-sla]', result);
            }
          },
        ),
        {
          initialDelayMs:
            CONFIG.smartMoneyCopyPoolSlaIntervalMs +
            getCronJitterMs(CONFIG.smartMoneyCopyPoolSlaIntervalMs),
        },
      ),
    );
  }

  console.log('[smart-money-cron] registered', {
    candidate: true,
    light: true,
    deep: true,
    closedPrefetch: CONFIG.smartMoneyClosedPrefetchEnabled,
    closedFullEnrich: CONFIG.smartMoneyClosedFullEnrichEnabled,
    gamma: CONFIG.smartMoneyGammaEnrichmentEnabled,
    curveEnrich: CONFIG.smartMoneyCurveEnrichEnabled,
    eliminated: CONFIG.smartMoneyEliminatedCronEnabled,
    rawRefill: CONFIG.smartMoneyRawRefillCronEnabled,
    copyabilityEnrich:
      CONFIG.smartMoneyCopyabilityEnrichEnabled && CONFIG.smartMoneyCopyabilityEnabled,
    rank: CONFIG.smartMoneyRankModelEnabled && CONFIG.smartMoneyCopyabilityEnabled,
    copyPoolRefreshShare: CONFIG.smartMoneyCopyPoolRefreshBatchShare,
    copyPoolRescoreMode: CONFIG.smartMoneyCopyPoolRescoreMode,
    copyPoolDailyTopN: CONFIG.smartMoneyCopyPoolDailyTopN,
    copyPoolSla: CONFIG.smartMoneyCopyPoolSlaCronEnabled,
  });

  return controllers;
}

/** 独立 worker 入口：立即注册，不依赖 HTTP listen */
export function registerSmartMoneyCronsStandalone(): CronController {
  const controllers = createSmartMoneyCronControllers();
  return {
    stop() {
      for (const c of controllers) c.stop();
    },
  };
}

/** 在 HTTP server 成功 listen 后注册进程内定时任务（与 Express app 同进程） */
export function registerServerCrons(server: Server): CronController {
  const controllers: CronController[] = [];
  server.once('listening', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : CONFIG.port;
    console.log(`Server running at http://localhost:${port}`);
    console.error(
      `[listen] pid=${process.pid} port=${port} — 浏览器请求若打到本进程，会先出现一行 [HTTP] METHOD /api/...；若完全没有 [HTTP]，说明端口/代理不对或未命中本服务。`,
    );

    if (CONFIG.redeemCronEnabled) {
      const ms = CONFIG.redeemIntervalMs;
      console.log(`[redeem-cron] enabled, interval ${ms}ms`);
      controllers.push(
        scheduleCronJob(
          'redeem-cron',
          ms,
          withCronLease('redeem-cron', 'redeem-cron', ms, () => runAutoRedeemSweep()),
          {
            initialDelayMs: ms,
          },
        ),
      );
    }

    {
      const ms = CONFIG.redeemReconcileIntervalMs;
      console.log(`[redeem-reconcile-cron] enabled, interval ${ms}ms`);
      controllers.push(
        scheduleCronJob(
          'redeem-reconcile-cron',
          ms,
          withCronLease(
            'redeem-reconcile-cron',
            'redeem-reconcile-cron',
            ms,
            () => runRedeemExecutionReconcileSweep()
          ),
          { initialDelayMs: 90_000 },
        ),
      );
    }

    if (CONFIG.leaderboardCronEnabled) {
      const ms = CONFIG.leaderboardIntervalMs;
      console.log(`[leaderboard-cron] enabled, interval ${ms}ms`);
      withCronLease('leaderboard-cron', 'leaderboard-sync', ms, () => runLeaderboardSync())().catch(
        (e: unknown) => console.error('[leaderboard-cron] initial sync error', e),
      );
      controllers.push(
        scheduleCronJob(
          'leaderboard-cron',
          ms,
          withCronLease('leaderboard-cron', 'leaderboard-sync', ms, () => runLeaderboardSync()),
          {
            initialDelayMs: ms + getCronJitterMs(ms),
          },
        ),
      );
    }

    if (CONFIG.smartMoneyCronEnabled && CONFIG.smartMoneyCronsInApi) {
      controllers.push(...createSmartMoneyCronControllers());
    } else if (CONFIG.smartMoneyCronEnabled && !CONFIG.smartMoneyCronsInApi) {
      console.log(
        '[smart-money-cron] skipped in API process (SMART_MONEY_CRONS_IN_API=false); use smart-money-worker'
      );
    }

    if (CONFIG.adminDashboardCronEnabled) {
      const runtimeMs = CONFIG.adminDashboardRuntimeIntervalMs;
      const statsMs = CONFIG.adminDashboardStatsIntervalMs;
      console.log(
        `[admin-dashboard-cron] enabled runtime=${runtimeMs}ms stats=${statsMs}ms`,
      );
      withCronLease(
        'admin-dashboard-runtime',
        'admin-dashboard-runtime',
        runtimeMs,
        () => runAdminDashboardRuntimeCron(),
      )().catch((e: unknown) =>
        console.error('[admin-dashboard-cron] initial runtime refresh error', e),
      );
      withCronLease(
        'admin-dashboard-stats',
        'admin-dashboard-stats',
        statsMs,
        () => runAdminDashboardStatsCron(),
      )().catch((e: unknown) =>
        console.error('[admin-dashboard-cron] initial stats refresh error', e),
      );
      controllers.push(
        scheduleCronJob(
          'admin-dashboard-runtime',
          runtimeMs,
          withCronLease('admin-dashboard-runtime', 'admin-dashboard-runtime', runtimeMs, () =>
            runAdminDashboardRuntimeCron(),
          ),
          { initialDelayMs: 15_000 },
        ),
        scheduleCronJob(
          'admin-dashboard-stats',
          statsMs,
          withCronLease('admin-dashboard-stats', 'admin-dashboard-stats', statsMs, () =>
            runAdminDashboardStatsCron(),
          ),
          { initialDelayMs: 30_000 },
        ),
        scheduleCronJob(
          'admin-dashboard-daily',
          24 * 60 * 60 * 1000,
          withCronLease('admin-dashboard-daily', 'admin-dashboard-daily', 24 * 60 * 60 * 1000, () =>
            runAdminDashboardDailyCron(),
          ),
          { initialDelayMs: 60_000 },
        ),
      );
    }

    if (CONFIG.virtualCopyAccountsEnabled) {
      const ms = CONFIG.virtualCopyLifecycleIntervalMs;
      controllers.push(
        scheduleCronJob(
          'virtual-copy-lifecycle',
          ms,
          withCronLease('virtual-copy-lifecycle', 'virtual-copy-lifecycle', ms, () =>
            processVirtualAccountLifecycle(),
          ),
          { initialDelayMs: ms },
        ),
      );
    }

  });

  return {
    stop() {
      for (const controller of controllers) {
        controller.stop();
      }
    },
  };
}
