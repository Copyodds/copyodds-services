import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { Code, success, fail } from '../../utils/response';

export const AUTH_COOKIE_NAME = 'auth_token';
const DEFAULT_AUTH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function authCookieBaseOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
} {
  return {
    httpOnly: true,
    secure: (process.env.NODE_ENV ?? '').toLowerCase() === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

function authCookieMaxAgeMs(token: string): number {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  if (decoded?.exp) {
    return Math.max(0, decoded.exp * 1000 - Date.now());
  }
  return DEFAULT_AUTH_COOKIE_MAX_AGE_MS;
}

function userGasBalanceToString(gasBalance: unknown): string {
  if (gasBalance == null) return '0';
  if (typeof gasBalance === 'object' && gasBalance !== null && 'toString' in gasBalance) {
    return String((gasBalance as { toString: () => string }).toString());
  }
  return String(gasBalance);
}

export function buildAuthUserPayload(user: {
  id: number;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  inviteCode: string;
  referrerId: number | null;
  referrerBoundAt: Date | null;
  referrerBindSource: string | null;
  affiliateTier: number | null;
  gasBalance: unknown;
}) {
  void user.referrerId;
  return {
    username: user.username,
    email: user.email ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    inviteCode: user.inviteCode,
    referrerBoundAt: user.referrerBoundAt ?? null,
    referrerBindSource: user.referrerBindSource ?? null,
    affiliateTier: user.affiliateTier ?? null,
    gasBalance: userGasBalanceToString(user.gasBalance),
  };
}

export async function createSessionToken(userId: number, username: string): Promise<string> {
  const sessionId = randomUUID();
  const token = jwt.sign(
    { userId, username, jti: sessionId },
    CONFIG.jwtSecret,
    { expiresIn: CONFIG.jwtExpiresIn } as jwt.SignOptions
  );
  const decoded = jwt.decode(token) as { exp?: number };
  if (decoded.exp === undefined) {
    throw new Error('JWT missing exp');
  }
  const expiresAt = new Date(decoded.exp * 1000);
  await prisma.userSession.create({
    data: { id: sessionId, userId, expiresAt },
  });
  return token;
}

export async function issueAuthSession(
  res: Response,
  user: Parameters<typeof buildAuthUserPayload>[0],
  httpStatus = 200,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!CONFIG.jwtSecret) {
    fail(res, Code.DEPENDENCY_UNAVAILABLE, 'Auth service is not configured', 503);
    return;
  }
  const token = await createSessionToken(user.id, user.username);
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...authCookieBaseOptions(),
    maxAge: authCookieMaxAgeMs(token),
  });
  success(
    res,
    {
      token,
      user: buildAuthUserPayload(user),
      ...extra,
    },
    httpStatus
  );
}
