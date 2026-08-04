import assert from 'node:assert/strict';
import {
  aggregateReasonTop,
  computeItemsPerMinute,
  finishSmartMoneyBatchRun,
  getRecentSmartMoneyBatchSummaries,
  inferPipelineBottleneck,
  isSmartMoneyExpensiveBatchRunning,
  normalizeBatchReason,
  resetSmartMoneyBatchObservabilityForTest,
  startSmartMoneyBatchRun,
} from './smartMoneyBatchObservability';

resetSmartMoneyBatchObservabilityForTest();

assert.equal(normalizeBatchReason('L1-DUST|ret1y=1|mdd=0'), 'L1-DUST');
assert.equal(normalizeBatchReason('COPY_HARD|HIGH_TRADE_FREQUENCY'), 'COPY_HARD');
assert.equal(normalizeBatchReason(null), 'unknown');
assert.equal(normalizeBatchReason(''), 'unknown');

const top = aggregateReasonTop(
  ['L1-DUST|a', 'L1-DUST|b', 'T1L-DD', 'L1-DUST|c', null, 'T1L-2'],
  3
);
assert.equal(top['L1-DUST'], 3);
assert.equal(top['T1L-DD'], 1);
assert.equal(top['T1L-2'], 1);

assert.equal(computeItemsPerMinute(120, 60_000), 120);
assert.equal(computeItemsPerMinute(0, 60_000), 0);
assert.equal(computeItemsPerMinute(30, 0), 0);

const run = startSmartMoneyBatchRun('light', 'test');
assert.ok(run.runId.length > 10);
assert.equal(run.stage, 'light');
assert.equal(isSmartMoneyExpensiveBatchRunning(), true);

const payload = finishSmartMoneyBatchRun(run, {
  picked: 40,
  succeeded: 40,
  failed: 0,
  passed: 18,
  reasonTop: { 'T1L-DD': 10, 'L-PNL1Y': 8 },
  backlogBefore: { rawDue: 900 },
  backlogAfter: { rawDue: 860 },
  forceEmit: true,
});
assert.equal(payload.event, 'smart_money_batch');
assert.equal(payload.stage, 'light');
assert.equal(payload.picked, 40);
assert.equal(payload.converted, 18);
assert.ok(typeof payload.elapsedMs === 'number');
assert.ok(typeof payload.itemsPerMinute === 'number');
assert.equal(isSmartMoneyExpensiveBatchRunning(), false);

const emptyRun = startSmartMoneyBatchRun('gate_prefetch', 'test-empty');
const emptyPayload = finishSmartMoneyBatchRun(emptyRun, {
  picked: 0,
  succeeded: 0,
  failed: 0,
});
assert.equal(emptyPayload.picked, 0);
// 空批默认不强制写入 recent（除非 heartbeat）；forceEmit 后才入环
const forcedEmpty = finishSmartMoneyBatchRun(startSmartMoneyBatchRun('gate_prefetch', 'hb'), {
  picked: 0,
  forceEmit: true,
});
assert.equal(forcedEmpty.event, 'smart_money_batch');

const recent = getRecentSmartMoneyBatchSummaries(5);
assert.ok(recent.length >= 1);
assert.equal(recent[recent.length - 1]?.event, 'smart_money_batch');

const bp = inferPipelineBottleneck({
  stage: 'gate_prefetch',
  backlogAfter: { qualifiedGateMissing: 300, qualifiedGateReady: 2 },
  produced: 50,
  consumed: 5,
});
assert.equal(bp.bottleneck, 'gate_prefetch_lag');
assert.equal(bp.backpressure, true);

const deepWait = inferPipelineBottleneck({
  stage: 'deep',
  backlogAfter: { qualifiedGateMissing: 100, qualifiedGateReady: 0, deepExecutable: 0 },
});
assert.equal(deepWait.bottleneck, 'deep_waiting_gate');

console.log('smartMoneyBatchObservability.test.ts: ok');
