import assert from 'node:assert/strict';
import {
  getCopyPoolRescoreMetricSnapshot,
  recordClosedIncrementalMetric,
  recordCopyPoolRescorePickMetric,
  resetCopyPoolRescoreMetricsForTest,
} from './smartMoneyCopyPoolRescoreMetrics.js';

resetCopyPoolRescoreMetricsForTest();
recordClosedIncrementalMetric('incremental');
recordClosedIncrementalMetric('incremental');
recordClosedIncrementalMetric('full_rebuild_needed');
recordClosedIncrementalMetric('skip_fresh');
recordCopyPoolRescorePickMetric('priority');
recordCopyPoolRescorePickMetric('background');

const snap = getCopyPoolRescoreMetricSnapshot();
assert.equal(snap.incrementalHit, 2);
assert.equal(snap.fullRebuild, 1);
assert.equal(snap.incrementalSkipFresh, 1);
assert.equal(snap.priorityPicked, 1);
assert.equal(snap.backgroundPicked, 1);
assert.ok(snap.incrementalHitRate != null && Math.abs(snap.incrementalHitRate - 0.5) < 1e-9);
assert.ok(snap.fullRebuildRate != null && Math.abs(snap.fullRebuildRate - 1 / 3) < 1e-9);

console.log('smartMoneyCopyPoolRescoreMetrics.test: OK');
