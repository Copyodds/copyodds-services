import { randomUUID } from 'node:crypto';
import { prisma } from '../../db';
import { passkeyConfig, type PasskeyChallengeKind } from '../../lib/passkeyConfig';
import { createAppError } from '../../utils/appError';
import { Code } from '../../utils/response';

export async function savePasskeyChallenge(input: {
  userId: number;
  kind: PasskeyChallengeKind;
  challenge: string;
  requestId?: string;
}): Promise<string> {
  const requestId = input.requestId ?? randomUUID();
  const expiresAt = new Date(Date.now() + passkeyConfig.challengeTtlSeconds * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.passkeyChallenge.deleteMany({
      where: { userId: input.userId, kind: input.kind },
    });
    await tx.passkeyChallenge.create({
      data: {
        requestId,
        userId: input.userId,
        kind: input.kind,
        challenge: input.challenge,
        expiresAt,
      },
    });
  });

  return requestId;
}

export async function consumePasskeyChallenge(input: {
  requestId: string;
  userId: number;
  kind: PasskeyChallengeKind;
}): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.passkeyChallenge.findUnique({
      where: { requestId: input.requestId },
    });

    if (!row || row.userId !== input.userId || row.kind !== input.kind) {
      throw createAppError({
        code: Code.PASSKEY_VERIFY_FAILED,
        httpStatus: 401,
        message: 'Passkey verification failed',
      });
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      await tx.passkeyChallenge.delete({ where: { requestId: input.requestId } });
      throw createAppError({
        code: Code.PASSKEY_CHALLENGE_EXPIRED,
        httpStatus: 400,
        message: 'Passkey challenge expired',
      });
    }

    await tx.passkeyChallenge.delete({ where: { requestId: input.requestId } });
    return row.challenge;
  });
}
