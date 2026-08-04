import assert from 'node:assert/strict';
import {
  resolveAnalyzedProfileRiskCopyPoolCheck,
  resolveProfileRiskCopyPoolCheck,
} from './smartMoneyProfileRiskCopyPoolPolicy';

const inPool = resolveProfileRiskCopyPoolCheck('block', true);
assert.equal(inPool.allowed, true);
assert.equal(inPool.inCopyPool, true);
assert.equal(inPool.notInCopyPool, false);

const blocked = resolveProfileRiskCopyPoolCheck('block', false);
assert.equal(blocked.allowed, false);
assert.equal(blocked.notInCopyPool, true);

const warn = resolveProfileRiskCopyPoolCheck('warn', false);
assert.equal(warn.allowed, true);
assert.equal(warn.notInCopyPool, true);

const off = resolveProfileRiskCopyPoolCheck('off', false);
assert.equal(off.allowed, true);
assert.equal(off.notInCopyPool, false);

const analyzedNotRanked = resolveAnalyzedProfileRiskCopyPoolCheck('block', false, true);
assert.equal(analyzedNotRanked.allowed, true);
assert.equal(analyzedNotRanked.inCopyPool, false);
assert.equal(analyzedNotRanked.notInCopyPool, true);

const unknownNotRanked = resolveAnalyzedProfileRiskCopyPoolCheck('block', false, false);
assert.equal(unknownNotRanked.allowed, false);

console.log('smartMoneyProfileRiskCopyPoolGate.test.ts: ok');
