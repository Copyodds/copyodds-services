import assert from 'node:assert/strict';
import {
  PASSKEY_CHALLENGE_KIND,
  ensureHttpsOriginVariants,
  normalizePasskeyOrigin,
  passkeyConfig,
} from '../lib/passkeyConfig';

assert.equal(PASSKEY_CHALLENGE_KIND.REGISTER, 1);
assert.equal(PASSKEY_CHALLENGE_KIND.LOGIN, 2);

assert.equal(normalizePasskeyOrigin('test.copyodds.io'), 'https://test.copyodds.io');
assert.equal(normalizePasskeyOrigin('https://test.copyodds.io/'), 'https://test.copyodds.io');
assert.equal(normalizePasskeyOrigin('localhost:3000'), 'http://localhost:3000');

const expanded = ensureHttpsOriginVariants(['http://test.copyodds.io']);
assert.deepEqual(expanded.sort(), ['http://test.copyodds.io', 'https://test.copyodds.io'].sort());
assert.deepEqual(ensureHttpsOriginVariants(['http://localhost:3000']), ['http://localhost:3000']);

console.log('passkeyConfig.test.ts: ok', passkeyConfig.origins);