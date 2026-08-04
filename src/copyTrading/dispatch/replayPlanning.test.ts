import assert from 'node:assert/strict';
import { computeReplayPlanLimits } from './replayPlanning';

assert.deepEqual(computeReplayPlanLimits(100, 0.2), {
  hotLimit: 80,
  backfillReserve: 20,
});

assert.deepEqual(computeReplayPlanLimits(1, 0.5), {
  hotLimit: 1,
  backfillReserve: 0,
});

assert.deepEqual(computeReplayPlanLimits(10, 2), {
  hotLimit: 2,
  backfillReserve: 8,
});

assert.deepEqual(computeReplayPlanLimits(10, Number.NaN), {
  hotLimit: 8,
  backfillReserve: 2,
});

console.log('replayPlanning.test.ts: ok');
