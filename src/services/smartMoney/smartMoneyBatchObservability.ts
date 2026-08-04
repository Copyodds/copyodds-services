/**
 * 排行榜全链路批次观测：统一 runId + 单行结构化日志。
 * 保留现有 console 日志；本模块额外输出 event=smart_money_batch，便于定位堵塞点。
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger';

export type SmartMoneyBatchStage =
  | 'raw_refill'
  | 'candidate'
  | 'light'
  | 'gate_prefetch'
  | 'deep'
  | 'eliminated'
  | 'curve_enrich'
  | 'gamma_enrich'
  | 'rank_recompute'
  | 'copy_pool_sla';

export type SmartMoneyBatchBacklog = Record<string, number | null | undefined>;

export type SmartMoneyBatchOutcome = {
  picked?: number;
  succeeded?: number;
  failed?: number;
  deferred?: number;
  /** Light：真正淘汰数（与 deferred 分列，F6） */
  eliminated?: number;
  converted?: number;
  /** 业务通过/晋级等（Light Tier1L、Deep scored、Gate ready…） */
  passed?: number;
  pagesFetched?: number;
  reasonTop?: Record<string, number>;
  backlogBefore?: SmartMoneyBatchBacklog;
  backlogAfter?: SmartMoneyBatchBacklog;
  extras?: Record<string, unknown>;
  /** 空批是否仍输出（默认 false；heartbeat 可强制） */
  forceEmit?: boolean;
  skipped?: boolean;
  skipReason?: string;
  bottleneck?: string | null;
  backpressure?: boolean;
};

export type SmartMoneyBatchRun = {
  runId: string;
  stage: SmartMoneyBatchStage;
  trigger: string;
  startedAtMs: number;
};

const HEARTBEAT_MS = 5 * 60_000;
const lastEmitByStage = new Map<SmartMoneyBatchStage, number>();
const activeRunCountByStage = new Map<SmartMoneyBatchStage, number>();
const recentSummaries: Array<Record<string, unknown>> = [];
const RECENT_SUMMARY_LIMIT = 40;

/** 归一化失败/淘汰原因：取 | 前缀，并截断过长码 */
export function normalizeBatchReason(raw: string | null | undefined, maxLen = 64): string {
  if (raw == null) return 'unknown';
  const trimmed = String(raw).trim();
  if (!trimmed) return 'unknown';
  const head = trimmed.split('|')[0]?.trim() || trimmed;
  return head.length > maxLen ? `${head.slice(0, maxLen)}…` : head;
}

export function aggregateReasonTop(
  reasons: Array<string | null | undefined>,
  limit = 12
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    const key = normalizeBatchReason(reason);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
  );
}

export function computeItemsPerMinute(count: number, elapsedMs: number): number {
  if (!(elapsedMs > 0) || !(count > 0)) return 0;
  return Math.round((count * 60_000) / elapsedMs);
}

export function startSmartMoneyBatchRun(
  stage: SmartMoneyBatchStage,
  trigger: string
): SmartMoneyBatchRun {
  activeRunCountByStage.set(stage, (activeRunCountByStage.get(stage) ?? 0) + 1);
  return {
    runId: randomUUID(),
    stage,
    trigger,
    startedAtMs: Date.now(),
  };
}

function shouldEmitEmpty(stage: SmartMoneyBatchStage, forceEmit?: boolean): boolean {
  if (forceEmit) return true;
  const last = lastEmitByStage.get(stage) ?? 0;
  return Date.now() - last >= HEARTBEAT_MS;
}

function pushRecentSummary(payload: Record<string, unknown>): void {
  recentSummaries.push(payload);
  while (recentSummaries.length > RECENT_SUMMARY_LIMIT) {
    recentSummaries.shift();
  }
}

/**
 * 结束一批并打一条结构化日志。
 * - 空批（picked=0 且非 skip）默认降噪，仅每 5 分钟 heartbeat 一次
 * - skipped（lease/reentry）默认 debug，不刷 info
 */
export function finishSmartMoneyBatchRun(
  run: SmartMoneyBatchRun,
  outcome: SmartMoneyBatchOutcome = {}
): Record<string, unknown> {
  const active = activeRunCountByStage.get(run.stage) ?? 0;
  if (active <= 1) activeRunCountByStage.delete(run.stage);
  else activeRunCountByStage.set(run.stage, active - 1);
  const elapsedMs = Math.max(0, Date.now() - run.startedAtMs);
  const picked = outcome.picked ?? 0;
  const succeeded = outcome.succeeded ?? 0;
  const failed = outcome.failed ?? 0;
  const deferred = outcome.deferred ?? 0;
  const eliminated = outcome.eliminated ?? 0;
  const converted = outcome.converted ?? outcome.passed ?? 0;
  const itemsPerMinute = computeItemsPerMinute(Math.max(picked, succeeded), elapsedMs);

  const payload: Record<string, unknown> = {
    event: 'smart_money_batch',
    runId: run.runId,
    stage: run.stage,
    trigger: run.trigger,
    elapsedMs,
    itemsPerMinute,
    picked,
    succeeded,
    failed,
    deferred,
    eliminated,
    converted,
    pagesFetched: outcome.pagesFetched ?? 0,
    reasonTop: outcome.reasonTop ?? {},
    backlogBefore: outcome.backlogBefore ?? {},
    backlogAfter: outcome.backlogAfter ?? {},
    bottleneck: outcome.bottleneck ?? null,
    backpressure: outcome.backpressure === true,
    skipped: outcome.skipped === true,
    skipReason: outcome.skipReason ?? null,
    ...(outcome.extras ?? {}),
  };

  const empty =
    !outcome.skipped &&
    picked === 0 &&
    succeeded === 0 &&
    failed === 0 &&
    converted === 0 &&
    (outcome.pagesFetched ?? 0) === 0;

  if (outcome.skipped) {
    logger.debug(payload, 'smart-money batch skipped');
    pushRecentSummary(payload);
    return payload;
  }

  if (empty && !shouldEmitEmpty(run.stage, outcome.forceEmit)) {
    return payload;
  }

  lastEmitByStage.set(run.stage, Date.now());
  logger.info(payload, 'smart-money batch');
  // 同步一条易 grep 的 console，兼容现有 pm2 习惯
  console.log('[smart-money-batch]', JSON.stringify(payload));
  pushRecentSummary(payload);
  return payload;
}

/** 进程内最近批次摘要，供 stats API 挂载 */
export function getRecentSmartMoneyBatchSummaries(limit = 20): Array<Record<string, unknown>> {
  const n = Math.max(1, Math.min(limit, RECENT_SUMMARY_LIMIT));
  return recentSummaries.slice(-n);
}

/** 测试用 */
export function resetSmartMoneyBatchObservabilityForTest(): void {
  lastEmitByStage.clear();
  activeRunCountByStage.clear();
  recentSummaries.length = 0;
}

/** 按需分析只在排行榜高成本批次空闲时启动；已启动任务不在这里抢占。 */
export function isSmartMoneyExpensiveBatchRunning(): boolean {
  const expensive: SmartMoneyBatchStage[] = [
    'light',
    'gate_prefetch',
    'deep',
    'curve_enrich',
    'gamma_enrich',
  ];
  return expensive.some((stage) => (activeRunCountByStage.get(stage) ?? 0) > 0);
}

/**
 * 根据前后 backlog 粗判瓶颈（仅诊断，不改配置）。
 * 生产持续大于消费时标记 backpressure。
 */
export function inferPipelineBottleneck(input: {
  stage: SmartMoneyBatchStage;
  backlogBefore?: SmartMoneyBatchBacklog;
  backlogAfter?: SmartMoneyBatchBacklog;
  produced?: number;
  consumed?: number;
}): { bottleneck: string | null; backpressure: boolean } {
  const before = input.backlogBefore ?? {};
  const after = input.backlogAfter ?? {};
  const gateMissing = Number(after.qualifiedGateMissing ?? before.qualifiedGateMissing ?? 0);
  const gateReady = Number(after.qualifiedGateReady ?? before.qualifiedGateReady ?? 0);
  const rawDue = Number(after.rawDue ?? before.rawDue ?? 0);
  const deepExec = Number(after.deepExecutable ?? before.deepExecutable ?? 0);
  const scoredAwait = Number(after.scoredAwaitingEntry ?? before.scoredAwaitingEntry ?? 0);

  let bottleneck: string | null = null;
  if (input.stage === 'light' && rawDue > 500) bottleneck = 'light_raw_backlog';
  else if (input.stage === 'gate_prefetch' && gateMissing > Math.max(20, gateReady * 5)) {
    bottleneck = 'gate_prefetch_lag';
  } else if (input.stage === 'deep' && gateReady === 0 && gateMissing > 0) {
    bottleneck = 'deep_waiting_gate';
  } else if (input.stage === 'deep' && deepExec > 50 && (input.consumed ?? 0) === 0) {
    bottleneck = 'deep_idle_with_ready';
  } else if (scoredAwait > 100) {
    bottleneck = 'scored_entry_lag';
  }

  const produced = input.produced ?? 0;
  const consumed = input.consumed ?? 0;
  const backpressure =
    produced > 0 && consumed >= 0 && produced > consumed * 1.5 && (gateMissing > 50 || rawDue > 200);

  return { bottleneck, backpressure };
}
