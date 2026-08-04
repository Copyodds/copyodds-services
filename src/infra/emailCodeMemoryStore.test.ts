import assert from 'node:assert/strict';
import {
  getActiveCode,
  recordSendEvent,
  resetEmailCodeMemoryStoreForTests,
  setActiveCode,
  listSendEventsSince,
} from './emailCodeMemoryStore';

resetEmailCodeMemoryStoreForTests();

const email = 'sweep@example.com';
const now = Date.now();
setActiveCode({
  codeHash: 'abc',
  email,
  type: 'REGISTER',
  attempts: 0,
  maxAttempts: 5,
  expiresAt: now - 1000,
  createdAt: now - 2000,
});

assert.equal(getActiveCode(email, 'REGISTER'), null);

recordSendEvent({ email, type: 'REGISTER', ip: '1.2.3.4', createdAt: now });
assert.equal(listSendEventsSince(now - 1000).length, 1);

console.log('emailCodeMemoryStore.test.ts: ok');
