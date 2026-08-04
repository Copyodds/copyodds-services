import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoUint8Array } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { prisma } from '../../db';
import { discoverableChallengeUserId } from '../../lib/passkeyDiscoverable';
import {
  assertPasskeyConfigured,
  getExpectedRpIds,
  PASSKEY_CHALLENGE_KIND,
  passkeyConfig,
} from '../../lib/passkeyConfig';
import { createAppError } from '../../utils/appError';
import { Code } from '../../utils/response';
import { consumePasskeyChallenge, savePasskeyChallenge } from './passkeyChallengeStore';

const USER_SESSION_SELECT = {
  id: true,
  username: true,
  email: true,
  firstName: true,
  lastName: true,
  inviteCode: true,
  referrerId: true,
  referrerBoundAt: true,
  referrerBindSource: true,
  affiliateTier: true,
  gasBalance: true,
} as const;

function userIdToBuffer(userId: number) {
  return isoUint8Array.fromUTF8String(String(userId));
}

function maskCredentialId(credentialId: string): string {
  if (credentialId.length <= 8) {
    return credentialId;
  }
  return `${credentialId.slice(0, 4)}...${credentialId.slice(-4)}`;
}

function parseTransports(value: string | null | undefined): AuthenticatorTransportFuture[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as AuthenticatorTransportFuture[];
  return items.length > 0 ? items : undefined;
}

function serializeTransports(transports: string[] | undefined): string | null {
  if (!transports?.length) return null;
  return transports.join(',');
}

function passkeyVerifyErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if ((process.env.NODE_ENV ?? '').toLowerCase() !== 'production') {
    return `Passkey verification failed: ${detail}`;
  }
  return 'Passkey verification failed';
}

export async function createRegisterOptions(userId: number, label?: string) {
  assertPasskeyConfigured();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      username: true,
      passkeyCredentials: { select: { credentialId: true, transports: true } },
    },
  });

  if (!user) {
    throw createAppError({
      code: Code.NOT_FOUND,
      httpStatus: 404,
      message: 'User not found',
    });
  }

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
    user.username ||
    user.email ||
    `User ${user.id}`;

  const options = await generateRegistrationOptions({
    rpName: passkeyConfig.rpName,
    rpID: passkeyConfig.rpId,
    userName: user.email ?? user.username,
    userDisplayName: displayName,
    userID: userIdToBuffer(user.id),
    attestationType: 'none',
    excludeCredentials: user.passkeyCredentials.map((cred) => ({
      id: cred.credentialId,
      transports: parseTransports(cred.transports),
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: passkeyConfig.userVerification,
    },
    timeout: passkeyConfig.timeoutMs,
  });

  const requestId = await savePasskeyChallenge({
    userId,
    kind: PASSKEY_CHALLENGE_KIND.REGISTER,
    challenge: options.challenge,
  });

  return {
    requestId,
    publicKey: options,
    label: label?.trim() || undefined,
  };
}

export async function verifyRegisterResponse(input: {
  userId: number;
  requestId: string;
  response: RegistrationResponseJSON;
  label?: string;
}) {
  assertPasskeyConfigured();

  const expectedChallenge = await consumePasskeyChallenge({
    requestId: input.requestId,
    userId: input.userId,
    kind: PASSKEY_CHALLENGE_KIND.REGISTER,
  });

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: passkeyConfig.origins,
      expectedRPID: getExpectedRpIds(),
      requireUserVerification: passkeyConfig.userVerification === 'required',
    });
  } catch (err) {
    console.error('[passkey] verifyRegistrationResponse failed', err);
    throw createAppError({
      code: Code.PASSKEY_VERIFY_FAILED,
      httpStatus: 401,
      message: passkeyVerifyErrorMessage(err),
    });
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw createAppError({
      code: Code.PASSKEY_VERIFY_FAILED,
      httpStatus: 401,
      message: 'Passkey verification failed',
    });
  }

  const { credential, aaguid, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  await prisma.passkeyCredential.create({
    data: {
      userId: input.userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      algorithm: -7,
      aaguid: aaguid ?? null,
      label: input.label?.trim().slice(0, 128) || null,
      signCount: credential.counter,
      backupEligible: credentialDeviceType === 'multiDevice',
      backupState: credentialBackedUp,
      transports: serializeTransports(credential.transports),
    },
  });
}

export async function createLoginOptions(email?: string) {
  assertPasskeyConfigured();

  const normalizedEmail = email?.trim().toLowerCase() ?? '';

  if (!normalizedEmail) {
    const options = await generateAuthenticationOptions({
      rpID: passkeyConfig.rpId,
      timeout: passkeyConfig.timeoutMs,
      userVerification: passkeyConfig.userVerification,
    });

    const requestId = randomUUID();
    const syntheticUserId = discoverableChallengeUserId(requestId);
    await savePasskeyChallenge({
      requestId,
      userId: syntheticUserId,
      kind: PASSKEY_CHALLENGE_KIND.LOGIN,
      challenge: options.challenge,
    });

    return { requestId, publicKey: options };
  }

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      passkeyCredentials: { select: { credentialId: true, transports: true } },
    },
  });

  if (!user) {
    throw createAppError({
      code: Code.NOT_FOUND,
      httpStatus: 404,
      message: 'Email is not registered',
    });
  }

  if (user.passkeyCredentials.length === 0) {
    throw createAppError({
      code: Code.PASSKEY_NOT_FOUND,
      httpStatus: 404,
      message: 'No passkeys found for this account',
    });
  }

  const options = await generateAuthenticationOptions({
    rpID: passkeyConfig.rpId,
    timeout: passkeyConfig.timeoutMs,
    userVerification: passkeyConfig.userVerification,
    allowCredentials: user.passkeyCredentials.map((cred) => ({
      id: cred.credentialId,
      transports: parseTransports(cred.transports),
    })),
  });

  const requestId = await savePasskeyChallenge({
    userId: user.id,
    kind: PASSKEY_CHALLENGE_KIND.LOGIN,
    challenge: options.challenge,
  });

  return { requestId, publicKey: options };
}

export async function verifyLoginResponse(input: {
  email?: string;
  requestId: string;
  response: AuthenticationResponseJSON;
}) {
  assertPasskeyConfigured();

  const normalizedEmail = input.email?.trim().toLowerCase() ?? '';
  const credentialId = input.response.id;
  const stored = await prisma.passkeyCredential.findUnique({
    where: { credentialId },
  });

  if (!stored) {
    throw createAppError({
      code: Code.PASSKEY_NOT_FOUND,
      httpStatus: 404,
      message: 'Passkey not found',
    });
  }

  let user;
  let challengeUserId: number;

  if (normalizedEmail) {
    const emailUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: USER_SESSION_SELECT,
    });

    if (!emailUser || stored.userId !== emailUser.id) {
      throw createAppError({
        code: Code.PASSKEY_NOT_FOUND,
        httpStatus: 404,
        message: 'Passkey not found',
      });
    }

    user = emailUser;
    challengeUserId = emailUser.id;
  } else {
    challengeUserId = discoverableChallengeUserId(input.requestId);
    user = await prisma.user.findUnique({
      where: { id: stored.userId },
      select: USER_SESSION_SELECT,
    });

    if (!user) {
      throw createAppError({
        code: Code.NOT_FOUND,
        httpStatus: 404,
        message: 'User not found',
      });
    }
  }

  const expectedChallenge = await consumePasskeyChallenge({
    requestId: input.requestId,
    userId: challengeUserId,
    kind: PASSKEY_CHALLENGE_KIND.LOGIN,
  });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: passkeyConfig.origins,
      expectedRPID: getExpectedRpIds(),
      credential: {
        id: stored.credentialId,
        publicKey: stored.publicKey,
        counter: stored.signCount,
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: passkeyConfig.userVerification === 'required',
    });
  } catch (err) {
    console.error('[passkey] verifyAuthenticationResponse failed', err);
    throw createAppError({
      code: Code.PASSKEY_VERIFY_FAILED,
      httpStatus: 401,
      message: passkeyVerifyErrorMessage(err),
    });
  }

  if (!verification.verified) {
    throw createAppError({
      code: Code.PASSKEY_VERIFY_FAILED,
      httpStatus: 401,
      message: 'Passkey verification failed',
    });
  }

  const newCounter = verification.authenticationInfo.newCounter;
  const cloneWarning = newCounter > 0 && stored.signCount > 0 && newCounter < stored.signCount;

  await prisma.passkeyCredential.update({
    where: { id: stored.id },
    data: {
      signCount: newCounter,
      lastUsedAt: new Date(),
      cloneWarning,
    },
  });

  return user;
}

export async function listPasskeys(userId: number) {
  const rows = await prisma.passkeyCredential.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  return rows.map((row) => ({
    id: row.id,
    credentialId: maskCredentialId(row.credentialId),
    label: row.label,
    aaguid: row.aaguid,
    signCount: row.signCount,
    backupEligible: row.backupEligible,
    backupState: row.backupState,
    cloneWarning: row.cloneWarning,
    transports: row.transports,
    lastUsedAt: row.lastUsedAt ? Math.floor(row.lastUsedAt.getTime() / 1000) : null,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
  }));
}

export async function deletePasskey(userId: number, passkeyId: number): Promise<void> {
  const row = await prisma.passkeyCredential.findFirst({
    where: { id: passkeyId, userId },
  });

  if (!row) {
    throw createAppError({
      code: Code.PASSKEY_NOT_FOUND,
      httpStatus: 404,
      message: 'Passkey not found',
    });
  }

  await prisma.passkeyCredential.delete({ where: { id: row.id } });
}

export async function userHasPasskeys(userId: number): Promise<boolean> {
  const count = await prisma.passkeyCredential.count({ where: { userId } });
  return count > 0;
}

/** Step-up for withdraw: requires existing passkeys and userVerification. */
export async function createStepUpWithdrawOptions(userId: number) {
  assertPasskeyConfigured();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      passkeyCredentials: { select: { credentialId: true, transports: true } },
    },
  });

  if (!user || user.passkeyCredentials.length === 0) {
    throw createAppError({
      code: Code.PASSKEY_NOT_FOUND,
      httpStatus: 404,
      message: 'No passkeys found for this account',
    });
  }

  const options = await generateAuthenticationOptions({
    rpID: passkeyConfig.rpId,
    timeout: passkeyConfig.timeoutMs,
    userVerification: 'required',
    allowCredentials: user.passkeyCredentials.map((cred) => ({
      id: cred.credentialId,
      transports: parseTransports(cred.transports),
    })),
  });

  const requestId = await savePasskeyChallenge({
    userId: user.id,
    kind: PASSKEY_CHALLENGE_KIND.STEP_UP_WITHDRAW,
    challenge: options.challenge,
  });

  return { requestId, publicKey: options };
}

export async function verifyStepUpWithdrawResponse(input: {
  userId: number;
  requestId: string;
  response: AuthenticationResponseJSON;
}): Promise<void> {
  assertPasskeyConfigured();

  const credentialId = input.response.id;
  const stored = await prisma.passkeyCredential.findUnique({
    where: { credentialId },
  });

  if (!stored || stored.userId !== input.userId) {
    throw createAppError({
      code: Code.PASSKEY_NOT_FOUND,
      httpStatus: 404,
      message: 'Passkey not found',
    });
  }

  const expectedChallenge = await consumePasskeyChallenge({
    requestId: input.requestId,
    userId: input.userId,
    kind: PASSKEY_CHALLENGE_KIND.STEP_UP_WITHDRAW,
  });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: passkeyConfig.origins,
      expectedRPID: getExpectedRpIds(),
      credential: {
        id: stored.credentialId,
        publicKey: stored.publicKey,
        counter: stored.signCount,
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: true,
    });
  } catch (err) {
    console.error('[passkey] step-up withdraw verify failed', err);
    throw createAppError({
      code: Code.PASSKEY_VERIFY_FAILED,
      httpStatus: 401,
      message: passkeyVerifyErrorMessage(err),
    });
  }

  if (!verification.verified) {
    throw createAppError({
      code: Code.PASSKEY_VERIFY_FAILED,
      httpStatus: 401,
      message: 'Passkey verification failed',
    });
  }

  const newCounter = verification.authenticationInfo.newCounter;
  const cloneWarning = newCounter > 0 && stored.signCount > 0 && newCounter < stored.signCount;

  await prisma.passkeyCredential.update({
    where: { id: stored.id },
    data: {
      signCount: newCounter,
      lastUsedAt: new Date(),
      cloneWarning,
    },
  });
}
