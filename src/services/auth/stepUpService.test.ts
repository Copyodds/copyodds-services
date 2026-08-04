import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-for-step-up-unit-tests';

async function main() {
  const { resetStepUpTokenStoreForTests } = await import('./stepUpTokenStore');
  const {
    issueStepUpToken,
    verifyStepUpToken,
    consumeStepUpToken,
    extractStepUpTokenFromRequest,
  } = await import('./stepUpService');
  const { STEP_UP_PURPOSE } = await import('../../lib/stepUpTypes');
  const { Code } = await import('../../utils/response');
  const { isAppError } = await import('../../utils/appError');

  const userId = 42;
  const otherUserId = 99;
  const secret = process.env.JWT_SECRET!;

  resetStepUpTokenStoreForTests();

  const { stepUpToken, jti } = issueStepUpToken(userId, STEP_UP_PURPOSE.WITHDRAW, 'passkey');
  assert.ok(stepUpToken.length > 20);
  assert.ok(jti);

  const verified = verifyStepUpToken(stepUpToken, STEP_UP_PURPOSE.WITHDRAW, userId);
  assert.equal(verified.userId, userId);
  assert.equal(verified.jti, jti);

  const consumed = consumeStepUpToken(stepUpToken, STEP_UP_PURPOSE.WITHDRAW, userId);
  assert.equal(consumed.jti, jti);

  try {
    consumeStepUpToken(stepUpToken, STEP_UP_PURPOSE.WITHDRAW, userId);
    assert.fail('expected second consume to fail');
  } catch (err) {
    assert.ok(isAppError(err));
    assert.equal((err as { code: number }).code, Code.STEP_UP_ALREADY_USED);
  }

  resetStepUpTokenStoreForTests();
  const orphanJwt = jwt.sign(
    {
      sub: userId,
      purpose: STEP_UP_PURPOSE.WITHDRAW,
      method: 'passkey',
      typ: 'step_up',
      jti: 'orphan-jti-not-in-store',
    },
    secret,
    { expiresIn: 300 }
  );
  try {
    consumeStepUpToken(orphanJwt, STEP_UP_PURPOSE.WITHDRAW, userId);
    assert.fail('expected not found');
  } catch (err) {
    assert.ok(isAppError(err));
    assert.equal((err as { code: number }).code, Code.STEP_UP_NOT_FOUND);
  }

  resetStepUpTokenStoreForTests();
  const otherToken = issueStepUpToken(otherUserId, STEP_UP_PURPOSE.WITHDRAW, 'email_otp').stepUpToken;
  try {
    consumeStepUpToken(otherToken, STEP_UP_PURPOSE.WITHDRAW, userId);
    assert.fail('expected user mismatch');
  } catch (err) {
    assert.ok(isAppError(err));
    assert.equal((err as { code: number }).code, Code.STEP_UP_INVALID);
  }

  resetStepUpTokenStoreForTests();
  const sessionJwt = jwt.sign(
    { userId, username: 'alice', jti: 'session-abc' },
    secret,
    { expiresIn: 3600 }
  );
  try {
    consumeStepUpToken(sessionJwt, STEP_UP_PURPOSE.WITHDRAW, userId);
    assert.fail('expected session jwt rejected');
  } catch (err) {
    assert.ok(isAppError(err));
    assert.equal((err as { code: number }).code, Code.STEP_UP_INVALID);
  }

  resetStepUpTokenStoreForTests();
  const loginPurposeToken = jwt.sign(
    { sub: userId, purpose: 'login', method: 'email_otp', typ: 'step_up', jti: 'x' },
    secret,
    { expiresIn: 300 }
  );
  try {
    consumeStepUpToken(loginPurposeToken, STEP_UP_PURPOSE.WITHDRAW, userId);
    assert.fail('expected purpose mismatch');
  } catch (err) {
    assert.ok(isAppError(err));
    assert.equal((err as { code: number }).code, Code.STEP_UP_PURPOSE_MISMATCH);
  }

  resetStepUpTokenStoreForTests();
  const { stepUpToken: expToken, jti: expJti } = issueStepUpToken(
    userId,
    STEP_UP_PURPOSE.WITHDRAW,
    'email_otp'
  );
  const { save } = await import('./stepUpTokenStore');
  save(expJti, {
    userId,
    purpose: STEP_UP_PURPOSE.WITHDRAW,
    method: 'email_otp',
    expiresAt: Date.now() - 1,
  });
  try {
    consumeStepUpToken(expToken, STEP_UP_PURPOSE.WITHDRAW, userId);
    assert.fail('expected expired');
  } catch (err) {
    assert.ok(isAppError(err));
    assert.equal((err as { code: number }).code, Code.STEP_UP_EXPIRED);
  }

  resetStepUpTokenStoreForTests();
  const bodyToken = issueStepUpToken(userId, STEP_UP_PURPOSE.WITHDRAW, 'email_otp').stepUpToken;
  const headerToken = issueStepUpToken(otherUserId, STEP_UP_PURPOSE.WITHDRAW, 'email_otp').stepUpToken;
  const extracted = extractStepUpTokenFromRequest({
    body: { stepUpToken: bodyToken },
    header(name: string) {
      return name.toLowerCase() === 'x-step-up-token' ? headerToken : undefined;
    },
  } as import('express').Request);
  assert.equal(extracted, bodyToken);

  console.log('stepUpService.test.ts: ok');
}

main();
