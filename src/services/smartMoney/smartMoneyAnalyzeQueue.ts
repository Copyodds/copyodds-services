import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { randomUUID } from 'node:crypto';
import { acquireCronLease, releaseCronLease } from '../cron/cronLease';
import { curveTypeForPeriod } from './smartMoneyCurveTtl';
import { isSmartMoneyExpensiveBatchRunning } from './smartMoneyBatchObservability';
import { runOnDemandAnalyzeForWallet } from './smartMoneyOnDemandAnalyze';
import { ensureGateUserPnlCurves } from './smartMoneyUserPnlCurves';
import {
  canAcceptSmartMoneyAnalyzeJob,
  decideSmartMoneyAnalyzeAction,
  type AnalyzeAction,
} from './smartMoneyOnDemandPolicy';
import { isCopyabilityDisplayReady } from './smartMoneyScoreCompleteness';

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const BUSY_RETRY_MS = 5_000;
const ON_DEMAND_RUN_LEASE = 'smart-money-on-demand-analysis';
const ON_DEMAND_RUN_OWNER = `api:${process.pid}:${randomUUID()}`;
const EXPENSIVE_CRON_LEASE_KEYS = [
  'smart-money-fetch-cron',
  'smart-money-deep-cron',
  'smart-money-closed-prefetch-cron',
  'smart-money-closed-full-enrich-cron',
  'smart-money-gamma-cron',
  'smart-money-curve-enrich-cron',
  'smart-money-copyability-enrich-cron',
];

let running = false;
let stopped = true;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let enqueueChain: Promise<void> = Promise.resolve();

export type AnalyzeFreshness = {
  wallet: string;
  exists: boolean;
  complete: boolean;
  fresh: boolean;
  action: AnalyzeAction;
  lastScoredAt: Date | null;
  reasons: string[];
};

export class SmartMoneyAnalyzeQueueError extends Error {
  constructor(
    public readonly code: 'QUEUE_FULL' | 'DAILY_LIMIT' | 'COOLDOWN',
    message: string
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasDisplayFields(input: {
  scoreExplain: unknown;
  tier?: string | null;
  traderScore?: unknown;
  traderType?: string | null;
}): boolean {
  if (!isRecord(input.scoreExplain)) return false;
  const displayProfile = input.scoreExplain.displayProfile;
  const traderProfile = isRecord(input.scoreExplain.traderProfile)
    ? input.scoreExplain.traderProfile
    : null;
  const card = traderProfile && isRecord(traderProfile.card) ? traderProfile.card : null;
  const tier = input.tier ?? card?.tier ?? traderProfile?.tier;
  const traderScore = input.traderScore ?? card?.traderScore;
  const traderType = input.traderType ?? card?.traderType ?? traderProfile?.traderType;
  return (
    isRecord(displayProfile) &&
    typeof tier === 'string' &&
    Number.isFinite(Number(traderScore)) &&
    typeof traderType === 'string'
  );
}

export async function evaluateSmartMoneyAddressFreshness(
  rawWallet: string
): Promise<AnalyzeFreshness> {
  const wallet = rawWallet.trim().toLowerCase();
  const [leaderboard, cache, allCurve, weekCurve] = await Promise.all([
    prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet },
      select: {
        lastScoredAt: true,
        scoreExplain: true,
        tier: true,
        traderScore: true,
        traderType: true,
        riskFlags: true,
        copyabilityScore: true,
      },
    }),
    prisma.smartMoneyScoreCache.findUnique({
      where: { wallet },
      select: { lastScoredAt: true, scoreExplain: true, riskFlags: true },
    }),
    prisma.traderCurvePoint.findFirst({
      where: { wallet, curveType: curveTypeForPeriod('ALL') },
      select: { id: true },
    }),
    prisma.traderCurvePoint.findFirst({
      where: { wallet, curveType: curveTypeForPeriod('1W') },
      select: { id: true },
    }),
  ]);

  const authority = leaderboard ?? cache;
  const exists = authority != null;
  const reasons: string[] = [];
  if (!exists) reasons.push('MISSING_SCORE');
  const coreComplete =
    authority != null &&
    hasDisplayFields(
      leaderboard
        ? {
            scoreExplain: leaderboard.scoreExplain,
            tier: leaderboard.tier,
            traderScore: leaderboard.traderScore,
            traderType: leaderboard.traderType,
          }
        : { scoreExplain: cache?.scoreExplain }
    );
  if (
    authority &&
    !coreComplete
  ) {
    reasons.push('MISSING_DISPLAY_FIELDS');
  }
  const copyabilityReady = isCopyabilityDisplayReady({
    scoreExplain: authority?.scoreExplain ?? null,
    copyabilityScore:
      leaderboard?.copyabilityScore != null ? Number(leaderboard.copyabilityScore) : null,
  });
  if (authority && coreComplete && !copyabilityReady) {
    reasons.push('COPYABILITY_PENDING');
  }
  if (!allCurve) reasons.push('MISSING_CURVE_ALL');
  if (!weekCurve) reasons.push('MISSING_CURVE_1W');
  const fatalFlags = authority?.riskFlags ?? [];
  const fatalDataMissing =
    fatalFlags.includes('CLOSED_POSITIONS_FETCH_FAILED') ||
    fatalFlags.includes('CLOSED_RETURN_DATA_MISSING') ||
    fatalFlags.includes('TRADES_FETCH_FAILED');
  if (fatalDataMissing) {
    reasons.push('FATAL_DATA_MISSING');
  }

  const lastScoredAt = authority?.lastScoredAt ?? null;
  const fresh =
    lastScoredAt != null &&
    Date.now() - lastScoredAt.getTime() <= CONFIG.smartMoneyOnDemandFreshnessMs;
  if (exists && !fresh) reasons.push('STALE_SCORE');
  const curvesComplete = allCurve != null && weekCurve != null;
  // 与排行榜展示对齐：核心展示字段 + 仿跟单三情景齐备才算 complete（Job READY）
  const complete =
    exists && coreComplete && copyabilityReady && curvesComplete && !fatalDataMissing;
  const action = decideSmartMoneyAnalyzeAction({
    exists,
    coreComplete: coreComplete && copyabilityReady,
    curvesComplete,
    fatalDataMissing,
    fresh,
  });

  return {
    wallet,
    exists,
    complete,
    fresh,
    action,
    lastScoredAt,
    reasons,
  };
}

function schedule(delayMs = 0): void {
  if (stopped || wakeTimer) return;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void processNext();
  }, delayMs);
  wakeTimer.unref?.();
}

async function expireOldPending(): Promise<void> {
  const expiredBefore = new Date(Date.now() - CONFIG.smartMoneyOnDemandPendingTimeoutMs);
  await prisma.smartMoneyAnalyzeJob.updateMany({
    where: { status: 'PENDING', createdAt: { lt: expiredBefore } },
    data: {
      status: 'EXPIRED',
      error: 'queue_wait_timeout',
      activeKey: null,
      finishedAt: new Date(),
    },
  });
}

async function isLeaderboardWorkBusy(): Promise<boolean> {
  if (isSmartMoneyExpensiveBatchRunning()) return true;
  // Smart Money cron 可能运行在独立 worker 进程；CronLease 是跨进程的最小忙碌信号。
  const activeLeases = await prisma.cronLease.count({
    where: {
      key: { in: EXPENSIVE_CRON_LEASE_KEYS },
      expiresAt: { gt: new Date() },
    },
  });
  return activeLeases > 0;
}

async function processNext(): Promise<void> {
  if (stopped || running) return;
  await expireOldPending().catch(() => undefined);
  if (await isLeaderboardWorkBusy().catch(() => true)) {
    schedule(BUSY_RETRY_MS);
    return;
  }
  const leaseAcquired = await acquireCronLease(
    ON_DEMAND_RUN_LEASE,
    ON_DEMAND_RUN_OWNER,
    CONFIG.smartMoneyOnDemandJobTimeoutMs + 30_000
  ).catch(() => false);
  if (!leaseAcquired) {
    schedule(BUSY_RETRY_MS);
    return;
  }

  const next = await prisma.smartMoneyAnalyzeJob.findFirst({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  });
  if (!next) {
    await releaseCronLease(ON_DEMAND_RUN_LEASE, ON_DEMAND_RUN_OWNER).catch(() => undefined);
    return;
  }

  const claimed = await prisma.smartMoneyAnalyzeJob.updateMany({
    where: { id: next.id, status: 'PENDING' },
    data: { status: 'RUNNING', startedAt: new Date(), error: null },
  });
  if (claimed.count !== 1) {
    await releaseCronLease(ON_DEMAND_RUN_LEASE, ON_DEMAND_RUN_OWNER).catch(() => undefined);
    schedule();
    return;
  }

  running = true;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('on_demand_job_timeout')),
    CONFIG.smartMoneyOnDemandJobTimeoutMs
  );
  try {
    if (next.action === 'ENRICH_ONLY') {
      controller.signal.throwIfAborted();
      await ensureGateUserPnlCurves(next.wallet);
      controller.signal.throwIfAborted();
    } else {
      const result = await runOnDemandAnalyzeForWallet(next.wallet, {
        signal: controller.signal,
      });
      if (!result.success) throw new Error(result.error ?? 'analysis_failed');
    }
    const completed = await evaluateSmartMoneyAddressFreshness(next.wallet);
    if (!completed.complete) {
      throw new Error(`analysis_incomplete:${completed.reasons.join(',')}`);
    }
    await prisma.smartMoneyAnalyzeJob.update({
      where: { id: next.id },
      data: {
        status: 'READY',
        activeKey: null,
        finishedAt: new Date(),
        error: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.smartMoneyAnalyzeJob
      .update({
        where: { id: next.id },
        data: {
          status: 'FAILED',
          activeKey: null,
          finishedAt: new Date(),
          error: message.slice(0, 500),
        },
      })
      .catch(() => undefined);
  } finally {
    clearTimeout(timeout);
    await releaseCronLease(ON_DEMAND_RUN_LEASE, ON_DEMAND_RUN_OWNER).catch(() => undefined);
    running = false;
    schedule();
  }
}

async function enqueueSmartMoneyAnalyzeUnlocked(input: {
  wallet: string;
  userId: number;
  period: '1D' | '1W' | '1M' | 'ALL';
  action: Exclude<AnalyzeAction, 'skip'>;
}) {
  const wallet = input.wallet.trim().toLowerCase();
  if (!WALLET_RE.test(wallet)) throw new Error('invalid_wallet');

  const existing = await prisma.smartMoneyAnalyzeJob.findUnique({
    where: { activeKey: wallet },
  });
  if (existing) {
    schedule();
    return { job: existing, reused: true };
  }

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const userToday = await prisma.smartMoneyAnalyzeJob.count({
    where: { userId: input.userId, createdAt: { gte: dayStart } },
  });
  if (userToday >= CONFIG.smartMoneyOnDemandUserDailyLimit) {
    throw new SmartMoneyAnalyzeQueueError('DAILY_LIMIT', 'daily_analysis_limit_reached');
  }

  if (CONFIG.smartMoneyOnDemandWalletCooldownMs > 0) {
    const recent = await prisma.smartMoneyAnalyzeJob.findFirst({
      where: {
        wallet,
        finishedAt: {
          gte: new Date(Date.now() - CONFIG.smartMoneyOnDemandWalletCooldownMs),
        },
      },
      orderBy: { finishedAt: 'desc' },
      select: { id: true },
    });
    if (recent) {
      throw new SmartMoneyAnalyzeQueueError('COOLDOWN', 'wallet_analysis_cooldown');
    }
  }

  const activeCount = await prisma.smartMoneyAnalyzeJob.count({
    where: { status: { in: ['PENDING', 'RUNNING'] } },
  });
  if (!canAcceptSmartMoneyAnalyzeJob(activeCount, CONFIG.smartMoneyOnDemandQueueMax)) {
    throw new SmartMoneyAnalyzeQueueError('QUEUE_FULL', 'analysis_queue_full');
  }

  try {
    const job = await prisma.smartMoneyAnalyzeJob.create({
      data: {
        wallet,
        userId: input.userId,
        period: input.period,
        status: 'PENDING',
        action: input.action.toUpperCase(),
        activeKey: wallet,
      },
    });
    schedule();
    return { job, reused: false };
  } catch (error) {
    // 并发提交同一钱包时，activeKey 唯一约束只保留一个任务。
    const raced = await prisma.smartMoneyAnalyzeJob.findUnique({
      where: { activeKey: wallet },
    });
    if (raced) {
      schedule();
      return { job: raced, reused: true };
    }
    throw error;
  }
}

/** 单进程串行化入队检查，确保并发请求也不会突破总容量 5。 */
export async function enqueueSmartMoneyAnalyze(input: {
  wallet: string;
  userId: number;
  period: '1D' | '1W' | '1M' | 'ALL';
  action: Exclude<AnalyzeAction, 'skip'>;
}) {
  const previous = enqueueChain;
  let release!: () => void;
  enqueueChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await enqueueSmartMoneyAnalyzeUnlocked(input);
  } finally {
    release();
  }
}

export async function getSmartMoneyAnalyzeJob(id: string) {
  const job = await prisma.smartMoneyAnalyzeJob.findUnique({ where: { id } });
  if (!job) return null;
  const queuePosition =
    job.status === 'PENDING'
      ? await prisma.smartMoneyAnalyzeJob.count({
          where: { status: 'PENDING', createdAt: { lte: job.createdAt } },
        })
      : job.status === 'RUNNING'
        ? 0
        : null;
  return { ...job, queuePosition };
}

export async function startSmartMoneyAnalyzeQueue(): Promise<void> {
  stopped = false;
  const now = new Date();
  await prisma.smartMoneyAnalyzeJob.updateMany({
    where: { status: { in: ['PENDING', 'RUNNING'] } },
    data: {
      status: 'FAILED',
      error: 'backend_restarted',
      activeKey: null,
      finishedAt: now,
    },
  });
  schedule();
}

export function stopSmartMoneyAnalyzeQueue(): void {
  stopped = true;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
}
