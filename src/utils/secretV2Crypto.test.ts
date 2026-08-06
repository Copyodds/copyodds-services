import assert from 'node:assert/strict';
import { decryptSecretV2, encryptSecretV2 } from './secretV2Crypto';

// Synthetic fixtures only — never commit real wallet mnemonics or production passwords.
const pass = 'test-only-password-not-for-production';
const plain = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const enc = encryptSecretV2(plain, pass);
assert.ok(enc.startsWith('v2:'));
assert.equal(decryptSecretV2(enc, pass), plain);

console.info('[secretV2Crypto] roundtrip ok');
