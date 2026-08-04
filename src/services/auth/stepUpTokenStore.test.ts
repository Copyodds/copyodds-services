import assert from 'node:assert/strict';

async function main() {
  const {
    save,
    get,
    consume,
    cleanupExpired,
    resetStepUpTokenStoreForTests,
  } = await import('./stepUpTokenStore');

  resetStepUpTokenStoreForTests();

  const jti = 'test-jti-1';
  const expiresAt = Date.now() + 60_000;
  save(jti, { userId: 7, purpose: 'withdraw', method: 'email_otp', expiresAt });

  const row = get(jti);
  assert.ok(row);
  assert.equal(row!.userId, 7);
  assert.equal(row!.usedAt, undefined);

  const first = consume(jti, 7, 'withdraw');
  assert.equal(first.ok, true);
  assert.ok(first.ok && first.entry.usedAt != null);

  const second = consume(jti, 7, 'withdraw');
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, 'ALREADY_USED');

  resetStepUpTokenStoreForTests();
  save('expired-jti', {
    userId: 1,
    purpose: 'withdraw',
    method: 'passkey',
    expiresAt: Date.now() - 1,
  });
  cleanupExpired();
  assert.equal(get('expired-jti'), undefined);

  resetStepUpTokenStoreForTests();
  save('wrong-user', { userId: 2, purpose: 'withdraw', method: 'passkey', expiresAt: Date.now() + 60_000 });
  const badUser = consume('wrong-user', 99, 'withdraw');
  assert.equal(badUser.ok, false);
  if (!badUser.ok) assert.equal(badUser.reason, 'INVALID');

  resetStepUpTokenStoreForTests();
  save('wrong-purpose', { userId: 3, purpose: 'withdraw', method: 'passkey', expiresAt: Date.now() + 60_000 });
  const badPurpose = consume('wrong-purpose', 3, 'other');
  assert.equal(badPurpose.ok, false);
  if (!badPurpose.ok) assert.equal(badPurpose.reason, 'PURPOSE_MISMATCH');

  resetStepUpTokenStoreForTests();
  const missing = consume('does-not-exist', 1, 'withdraw');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'NOT_FOUND');

  console.log('stepUpTokenStore.test.ts: ok');
}

main();
