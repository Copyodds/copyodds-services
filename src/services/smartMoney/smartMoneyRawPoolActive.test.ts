import assert from 'node:assert/strict';
import { RAW_POOL_OCCUPYING_STAGES, rawPoolActiveWhere } from './smartMoneyRawPoolActive.js';

assert.deepEqual([...RAW_POOL_OCCUPYING_STAGES], ['RAW', 'LIGHT_ANALYZING']);
assert.equal(rawPoolActiveWhere.dormant, false);
assert.deepEqual(rawPoolActiveWhere.pipelineStage.in, ['RAW', 'LIGHT_ANALYZING']);
// 已晋级阶段不得出现在水位 where，否则 CopyPool 涨满会饿死 RAW
assert.equal(rawPoolActiveWhere.pipelineStage.in.includes('COPY_POOL'), false);
assert.equal(rawPoolActiveWhere.pipelineStage.in.includes('QUALIFIED'), false);

console.log('smartMoneyRawPoolActive.test.ts: ok');
