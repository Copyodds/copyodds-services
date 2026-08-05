import assert from 'node:assert/strict';
import {
  PASSKEY_CHALLENGE_KIND,
  ensureHttpsOriginVariants,
  normalizePasskeyOrigin,
  passkeyConfig,
} from '../lib/passkeyConfig';

assert.equal(PASSKEY_CHALLENGE_KIND.REGISTER, 1);
assert.equal(PASSKEY_CHALLENGE_KIND.LOGIN, 2);

assert.equal(normalizePasskeyOrigin('app.example.com'), 'https://app.example.com');
assert.equal(normalizePasskeyOrigin('https://app.example.com/'), 'https://app.example.com');
assert.equal(normalizePasskeyOrigin('localhost:3000'), 'http://localhost:3000');

const expanded = ensureHttpsOriginVariants(['http://app.example.com']);
assert.deepEqual(expanded.sort(), ['http://app.example.com', 'https://app.example.com'].sort());
assert.deepEqual(ensureHttpsOriginVariants(['http://localhost:3000']), ['http://localhost:3000']);

console.log('passkeyConfig.test.ts: ok', passkeyConfig.origins);