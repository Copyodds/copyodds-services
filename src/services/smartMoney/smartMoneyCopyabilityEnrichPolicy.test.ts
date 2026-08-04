/**
 * F7：Copyability Enrich 踢池策略（默认关闭低 copy 硬踢；LOW_COPYABILITY 软标记）。
 * 跑：npx tsx src/services/smartMoney/smartMoneyCopyabilityEnrichPolicy.test.ts
 */
import assert from 'node:assert/strict';
import { CONFIG } from '../../config/env.js';
import { COPY_POOL_HARD_FLAGS } from './smartMoneyPipelineTypes.js';
import { hasCopyPoolHardFlag } from './smartMoneyTierGate.js';

assert.equal(
  CONFIG.smartMoneyCopyabilityKickOnLowScore,
  false,
  'F7：默认不因 copyability&lt;35 踢池'
);
assert.equal(
  (COPY_POOL_HARD_FLAGS as readonly string[]).includes('LOW_COPYABILITY'),
  false,
  'F7：LOW_COPYABILITY 不再是硬旗'
);
assert.equal(hasCopyPoolHardFlag(['LOW_COPYABILITY']), false);
assert.equal(hasCopyPoolHardFlag(['HIGH_TRADE_FREQUENCY']), false);
assert.ok(CONFIG.smartMoneyScoredRecheckMs < CONFIG.smartMoneyTier1RetryMs);
assert.ok(CONFIG.smartMoneyCopyPoolBgRescoreMs >= 60_000);
assert.equal(CONFIG.smartMoneyQualifiedMaxActive, 0);
assert.equal(CONFIG.smartMoneyTraderScoreAsPrimary, true);

console.log('smartMoneyCopyabilityEnrichPolicy.test.ts: ok');
