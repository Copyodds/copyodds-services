/**
 * CopyPool 复评 / Gate 增量过程指标（进程内计数 + 可快照到管道统计）。
 */
type CounterBag = {
  incrementalHit: number;
  incrementalSkipFresh: number;
  fullRebuild: number;
  incrementalFailed: number;
  priorityPicked: number;
  backgroundPicked: number;
  gateCappedSeen: number;
  approxRankAssigned: number;
};

const counters: CounterBag = {
  incrementalHit: 0,
  incrementalSkipFresh: 0,
  fullRebuild: 0,
  incrementalFailed: 0,
  priorityPicked: 0,
  backgroundPicked: 0,
  gateCappedSeen: 0,
  approxRankAssigned: 0,
};

let windowStartedAtMs = Date.now();

export function recordClosedIncrementalMetric(
  mode: 'skip_fresh' | 'incremental' | 'full_rebuild_needed' | 'failed'
): void {
  if (mode === 'incremental') counters.incrementalHit += 1;
  else if (mode === 'skip_fresh') counters.incrementalSkipFresh += 1;
  else if (mode === 'full_rebuild_needed') counters.fullRebuild += 1;
  else if (mode === 'failed') counters.incrementalFailed += 1;
}

export function recordCopyPoolRescorePickMetric(channel: 'priority' | 'background' | 'legacy'): void {
  if (channel === 'priority') counters.priorityPicked += 1;
  else if (channel === 'background') counters.backgroundPicked += 1;
}

export function recordGateCappedMetric(): void {
  counters.gateCappedSeen += 1;
}

export function recordApproxRankAssignedMetric(): void {
  counters.approxRankAssigned += 1;
}

export function getCopyPoolRescoreMetricSnapshot(): CounterBag & {
  windowStartedAtMs: number;
  incrementalHitRate: number | null;
  fullRebuildRate: number | null;
} {
  const closedAttempts =
    counters.incrementalHit +
    counters.incrementalSkipFresh +
    counters.fullRebuild +
    counters.incrementalFailed;
  const incrementalAttempts = counters.incrementalHit + counters.fullRebuild + counters.incrementalFailed;
  return {
    ...counters,
    windowStartedAtMs,
    incrementalHitRate:
      closedAttempts > 0 ? counters.incrementalHit / closedAttempts : null,
    fullRebuildRate: incrementalAttempts > 0 ? counters.fullRebuild / incrementalAttempts : null,
  };
}

/** 测试用 */
export function resetCopyPoolRescoreMetricsForTest(): void {
  counters.incrementalHit = 0;
  counters.incrementalSkipFresh = 0;
  counters.fullRebuild = 0;
  counters.incrementalFailed = 0;
  counters.priorityPicked = 0;
  counters.backgroundPicked = 0;
  counters.gateCappedSeen = 0;
  counters.approxRankAssigned = 0;
  windowStartedAtMs = Date.now();
}
