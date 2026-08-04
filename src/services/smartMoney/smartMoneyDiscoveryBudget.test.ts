import assert from 'node:assert/strict';
import { computeDiscoveryIngestBudget } from './smartMoneyDiscoveryBudget.js';

{
  const b = computeDiscoveryIngestBudget({
    activeCount: 176_000,
    maxActive: 50_000,
    watermark: 0.9,
    perRun: 1000,
  });
  assert.equal(b.paused, true);
  assert.equal(b.slots, 0);
  assert.equal(b.targetCap, 45_000);
}

{
  const b = computeDiscoveryIngestBudget({
    activeCount: 40_000,
    maxActive: 50_000,
    watermark: 0.9,
    perRun: 1000,
  });
  assert.equal(b.paused, false);
  assert.equal(b.slots, 1000);
}

{
  const b = computeDiscoveryIngestBudget({
    activeCount: 44_500,
    maxActive: 50_000,
    watermark: 0.9,
    perRun: 1000,
  });
  assert.equal(b.paused, false);
  assert.equal(b.slots, 500);
}

{
  const b = computeDiscoveryIngestBudget({
    activeCount: 10,
    maxActive: 0,
    watermark: 0.9,
    perRun: 2000,
  });
  assert.equal(b.paused, false);
  assert.equal(b.slots, 2000);
}

{
  const b = computeDiscoveryIngestBudget({
    activeCount: 0,
    maxActive: 50_000,
    watermark: 0.9,
    perRun: 0,
  });
  assert.equal(b.paused, true);
  assert.equal(b.slots, 0);
}

{
  // 拉式：active 落在 (low, target) 仍应继续补到 target（避免卡死）
  const mid = computeDiscoveryIngestBudget({
    activeCount: 300,
    maxActive: 1000,
    perRun: 200,
    refillLow: 250,
    refillTarget: 1000,
  });
  assert.equal(mid.paused, false);
  assert.equal(mid.slots, 200);
  assert.equal(mid.belowLow, false);

  const full = computeDiscoveryIngestBudget({
    activeCount: 1000,
    maxActive: 1000,
    perRun: 200,
    refillLow: 250,
    refillTarget: 1000,
  });
  assert.equal(full.paused, true);
  assert.equal(full.slots, 0);

  const urgent = computeDiscoveryIngestBudget({
    activeCount: 100,
    maxActive: 1000,
    perRun: 1000,
    refillLow: 250,
    refillTarget: 1000,
  });
  assert.equal(urgent.paused, false);
  assert.equal(urgent.slots, 900);
  assert.equal(urgent.belowLow, true);
}

console.log('smartMoneyDiscoveryBudget.test.ts: ok');
