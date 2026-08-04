import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export const virtualCopyMetricsRegistry = new Registry();

collectDefaultMetrics({
  register: virtualCopyMetricsRegistry,
  prefix: 'polycopy_',
});

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const valueBuckets = [0, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1_000];

export const virtualCopyMetrics = {
  queueDepth: new Gauge({
    name: 'polycopy_virtual_copy_queue_depth',
    help: 'Current virtual-copy execution queue depth by bounded status.',
    labelNames: ['status'] as const,
    registers: [virtualCopyMetricsRegistry],
  }),
  queueOldestAgeSeconds: new Gauge({
    name: 'polycopy_virtual_copy_queue_oldest_age_seconds',
    help: 'Age of the oldest due virtual-copy execution.',
    registers: [virtualCopyMetricsRegistry],
  }),
  executions: new Counter({
    name: 'polycopy_virtual_copy_executions_total',
    help: 'Virtual-copy executions by terminal status and bounded error class.',
    labelNames: ['status', 'error_class', 'side', 'source'] as const,
    registers: [virtualCopyMetricsRegistry],
  }),
  executionDurationSeconds: new Histogram({
    name: 'polycopy_virtual_copy_execution_duration_seconds',
    help: 'End-to-end execution simulation duration.',
    labelNames: ['status'] as const,
    buckets: durationBuckets,
    registers: [virtualCopyMetricsRegistry],
  }),
  externalRequestDurationSeconds: new Histogram({
    name: 'polycopy_virtual_copy_external_request_duration_seconds',
    help: 'CLOB, Gamma, and Polygon request latency and result.',
    labelNames: ['service', 'operation', 'result'] as const,
    buckets: durationBuckets,
    registers: [virtualCopyMetricsRegistry],
  }),
  markResults: new Counter({
    name: 'polycopy_virtual_copy_mark_results_total',
    help: 'Mark-price resolutions including explicit fallback/degradation.',
    labelNames: ['source', 'status'] as const,
    registers: [virtualCopyMetricsRegistry],
  }),
  degradation: new Counter({
    name: 'polycopy_virtual_copy_degradation_total',
    help: 'Virtual-copy degraded behavior by bounded reason.',
    labelNames: ['component', 'reason'] as const,
    registers: [virtualCopyMetricsRegistry],
  }),
  slippageBps: new Histogram({
    name: 'polycopy_virtual_copy_slippage_bps',
    help: 'Observed adverse execution slippage in basis points.',
    labelNames: ['side'] as const,
    buckets: valueBuckets,
    registers: [virtualCopyMetricsRegistry],
  }),
  feesUsd: new Histogram({
    name: 'polycopy_virtual_copy_fees_usd',
    help: 'Simulated virtual-copy fees in USD.',
    labelNames: ['side'] as const,
    buckets: [0, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 25, 100],
    registers: [virtualCopyMetricsRegistry],
  }),
  executionConditions: new Counter({
    name: 'polycopy_virtual_copy_execution_conditions_total',
    help: 'Partial fills, insufficient funds, and other bounded execution conditions.',
    labelNames: ['condition', 'side'] as const,
    registers: [virtualCopyMetricsRegistry],
  }),
  replayLagSeconds: new Gauge({
    name: 'polycopy_virtual_copy_replay_lag_seconds',
    help: 'Age of the durable leader-trade replay checkpoint.',
    registers: [virtualCopyMetricsRegistry],
  }),
  staleClaims: new Counter({
    name: 'polycopy_virtual_copy_stale_claims_total',
    help: 'Expired execution claims recovered by workers.',
    registers: [virtualCopyMetricsRegistry],
  }),
  reconciliationDrift: new Gauge({
    name: 'polycopy_virtual_copy_reconciliation_drift',
    help: 'Latest reconciliation issue count by bounded drift type.',
    labelNames: ['type'] as const,
    registers: [virtualCopyMetricsRegistry],
  }),
  reconciliationDriftUsd: new Gauge({
    name: 'polycopy_virtual_copy_reconciliation_drift_usd',
    help: 'Maximum absolute USD drift observed in the latest reconciliation.',
    labelNames: ['type'] as const,
    registers: [virtualCopyMetricsRegistry],
  }),
  resolvedOpenLots: new Gauge({
    name: 'polycopy_virtual_copy_resolved_open_lots',
    help: 'Open lot groups observed for resolved markets during the latest settlement sweep.',
    registers: [virtualCopyMetricsRegistry],
  }),
  fanout: new Histogram({
    name: 'polycopy_virtual_copy_fanout',
    help: 'Number of execution records produced per leader trade.',
    buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000],
    registers: [virtualCopyMetricsRegistry],
  }),
  lockWaitSeconds: new Histogram({
    name: 'polycopy_virtual_copy_lock_wait_seconds',
    help: 'Approximate database lock acquisition wait.',
    labelNames: ['lock'] as const,
    buckets: durationBuckets,
    registers: [virtualCopyMetricsRegistry],
  }),
  workerSweeps: new Counter({
    name: 'polycopy_virtual_copy_worker_sweeps_total',
    help: 'Worker sweep outcomes by loop.',
    labelNames: ['loop', 'result'] as const,
    registers: [virtualCopyMetricsRegistry],
  }),
  workerLastSuccessTimestamp: new Gauge({
    name: 'polycopy_virtual_copy_worker_last_success_timestamp_seconds',
    help: 'Unix timestamp of the latest successful worker sweep.',
    labelNames: ['loop'] as const,
    registers: [virtualCopyMetricsRegistry],
  }),
};

const KNOWN_ERROR_CLASSES = new Set([
  'account_expired',
  'account_unavailable',
  'buy_kill_switch',
  'daily_cap',
  'execution_failed',
  'insufficient_cash',
  'market_cap',
  'market_cooldown',
  'already_open_position',
  'max_amount',
  'no_fill',
  'no_position',
  'order_book_unavailable',
  'partial_below_minimum',
  'stale_claim_recovered',
]);

export function virtualCopyErrorClass(errorCode: string | null | undefined): string {
  if (!errorCode) return 'none';
  const normalized = errorCode.replace(/^virtual_/, '');
  return KNOWN_ERROR_CLASSES.has(normalized) ? normalized : 'other';
}

export function boundedStatus(status: string | null | undefined): string {
  switch (status) {
    case 'QUEUED':
    case 'SIMULATING':
    case 'FILLED':
    case 'PARTIALLY_FILLED':
    case 'SKIPPED':
    case 'DEAD':
    case 'SETTLED':
      return status.toLowerCase();
    default:
      return 'other';
  }
}

export function observeExternalRequest(
  service: 'clob' | 'gamma' | 'polygon',
  operation: string,
  startedAt: number,
  result: 'success' | 'empty' | 'http_error' | 'timeout' | 'error',
): void {
  virtualCopyMetrics.externalRequestDurationSeconds
    .labels(service, operation, result)
    .observe(Math.max(0, (performance.now() - startedAt) / 1_000));
}

export function resetVirtualCopyMetricsForTests(): void {
  virtualCopyMetricsRegistry.resetMetrics();
}
