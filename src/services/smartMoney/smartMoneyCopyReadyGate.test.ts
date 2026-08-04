/**
 * Copy 就绪门：已算出（含低分）= Enrich 完成；入池须 ≥ MIN。订阅不走此门。
 * 跑：npx tsx src/services/smartMoney/smartMoneyCopyReadyGate.test.ts
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import assert from 'node:assert/strict';
import {
  isCopyabilityComputed,
  isCopyabilityReadyForPool,
  isCopyabilityEligibleForPoolEnter,
  copyabilityPoolMinComposite,
} from './smartMoneyCopyReady.js';
import { CONFIG } from '../../config/env.js';
import { smartMoneyCachedDisplayWhere } from './smartMoneyCachedQuery.js';

assert.equal(isCopyabilityComputed(null), false);
assert.equal(isCopyabilityComputed(undefined), false);
assert.equal(isCopyabilityComputed(0), true);
assert.equal(isCopyabilityComputed(12.5), true);

assert.equal(isCopyabilityReadyForPool(null), false);
assert.equal(isCopyabilityReadyForPool(0), true);
assert.equal(isCopyabilityReadyForPool(0.1), true);

const min = copyabilityPoolMinComposite();
assert.equal(isCopyabilityEligibleForPoolEnter(null), false);
assert.equal(isCopyabilityEligibleForPoolEnter(0), false);
assert.equal(isCopyabilityEligibleForPoolEnter(min - 0.01), false);
assert.equal(isCopyabilityEligibleForPoolEnter(min), true);
assert.equal(isCopyabilityEligibleForPoolEnter(60), true);

if (CONFIG.smartMoneyCopyReadyRequiredForPool) {
  const where = smartMoneyCachedDisplayWhere();
  assert.deepEqual(where.copyabilityScore, { gte: min });
}

// 订阅策略默认 warn：不在榜也可跟（仅告警），不强制 CopyPool
assert.equal(CONFIG.smartMoneyCopyPoolSubscribePolicy, 'warn');

console.log('smartMoneyCopyReadyGate.test.ts: ok');
