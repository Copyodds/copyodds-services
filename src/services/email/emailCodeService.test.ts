import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.EMAIL_CODE_PEPPER = process.env.EMAIL_CODE_PEPPER ?? 'test-pepper-for-unit-tests';

async function main() {
  const { resetEmailCodeMemoryStoreForTests } = await import('../../infra/emailCodeMemoryStore');
  const { compareCode, deleteCode, generateCode, hashCode, sendCode, verifyCode } =
    await import('./emailCodeService');

  resetEmailCodeMemoryStoreForTests();

  const code = generateCode();
  assert.match(code, /^\d{6}$/);
  const h = hashCode(code);
  assert.equal(compareCode(code, h), true);
  assert.equal(compareCode('000000', h), false);

  // 内存存取：不发真实邮件，直接写入后校验
  const { setActiveCode } = await import('../../infra/emailCodeMemoryStore');
  const email = 'mem-test@example.com';
  const now = Date.now();
  setActiveCode({
    codeHash: h,
    email,
    type: 'LOGIN',
    attempts: 0,
    maxAttempts: 5,
    expiresAt: now + 300_000,
    createdAt: now,
  });
  await verifyCode(email, 'LOGIN', code);
  assert.equal((await import('../../infra/emailCodeMemoryStore')).getActiveCode(email, 'LOGIN'), null);

  resetEmailCodeMemoryStoreForTests();
  const withdrawHash = hashCode('654321');
  setActiveCode({
    codeHash: withdrawHash,
    email,
    type: 'WITHDRAW',
    attempts: 0,
    maxAttempts: 5,
    expiresAt: now + 300_000,
    createdAt: now,
  });
  await verifyCode(email, 'WITHDRAW', '654321');
  assert.equal((await import('../../infra/emailCodeMemoryStore')).getActiveCode(email, 'WITHDRAW'), null);

  resetEmailCodeMemoryStoreForTests();
  setActiveCode({
    codeHash: h,
    email,
    type: 'LOGIN',
    attempts: 0,
    maxAttempts: 5,
    expiresAt: now + 300_000,
    createdAt: now,
  });
  try {
    await verifyCode(email, 'WITHDRAW', code);
    assert.fail('LOGIN code must not verify as WITHDRAW');
  } catch (err) {
    assert.ok(err);
  }

  resetEmailCodeMemoryStoreForTests();
  setActiveCode({
    codeHash: h,
    email,
    type: 'LOGIN',
    attempts: 0,
    maxAttempts: 5,
    expiresAt: now + 300_000,
    createdAt: now,
  });
  await deleteCode(email, 'LOGIN');
  assert.equal((await import('../../infra/emailCodeMemoryStore')).getActiveCode(email, 'LOGIN'), null);

  console.log('emailCodeService.test.ts: ok');
}

main();
