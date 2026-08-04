import assert from 'node:assert/strict';
import {
  boundedStatus,
  resetVirtualCopyMetricsForTests,
  virtualCopyErrorClass,
  virtualCopyMetrics,
  virtualCopyMetricsRegistry,
} from './virtualCopyMetrics';
import { summarizeVirtualCopyHealth } from './virtualCopyHealthSummary';

async function main(): Promise<void> {
  resetVirtualCopyMetricsForTests();
  virtualCopyMetrics.queueDepth.labels('queued').set(7);
  virtualCopyMetrics.executions.labels('skipped', 'insufficient_cash', 'buy', 'leader').inc();
  virtualCopyMetrics.reconciliationDrift.labels('cash_ledger_drift').set(2);

  const text = await virtualCopyMetricsRegistry.metrics();
  assert.match(text, /polycopy_virtual_copy_queue_depth\{status="queued"\} 7/);
  assert.match(text, /error_class="insufficient_cash"/);
  assert.match(text, /polycopy_virtual_copy_reconciliation_drift\{type="cash_ledger_drift"\} 2/);
  assert.doesNotMatch(text, /accountId|account_id|userId|user_id|tokenId|token_id/);

  assert.equal(virtualCopyErrorClass('virtual_insufficient_cash'), 'insufficient_cash');
  assert.equal(virtualCopyErrorClass('dynamic-upstream-message'), 'other');
  assert.equal(boundedStatus('PARTIALLY_FILLED'), 'partially_filled');
  assert.equal(boundedStatus('future-status'), 'other');

  const healthy = summarizeVirtualCopyHealth({
    checkedAt: new Date(0).toISOString(),
    queue: { depth: 0, oldestAgeSeconds: 0, simulating: 0, dead: 0 },
    replayLagSeconds: 0,
    staleClaims: 0,
    buySafetyPaused: false,
  });
  assert.equal(healthy.status, 'ok');

  const degraded = summarizeVirtualCopyHealth({
    checkedAt: new Date(0).toISOString(),
    queue: { depth: 2, oldestAgeSeconds: 61, simulating: 0, dead: 1 },
    replayLagSeconds: 0,
    staleClaims: 1,
    buySafetyPaused: false,
  });
  assert.equal(degraded.status, 'degraded');
  assert.deepEqual(degraded.reasons, ['dead_executions', 'stale_claims', 'queue_lag']);

  const unhealthy = summarizeVirtualCopyHealth({
    checkedAt: new Date(0).toISOString(),
    queue: { depth: 2, oldestAgeSeconds: 301, simulating: 0, dead: 0 },
    replayLagSeconds: 301,
    staleClaims: 0,
    buySafetyPaused: false,
  });
  assert.equal(unhealthy.status, 'unhealthy');
}

void main();
