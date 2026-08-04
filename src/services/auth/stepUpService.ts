import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { CONFIG } from '../../config/env';
import {
  STEP_UP_JWT_TYP,
  STEP_UP_PURPOSE,
  STEP_UP_TOKEN_TTL_SEC,
  type StepUpMethod,
  type StepUpPurpose,
} from '../../lib/stepUpTypes';
import { createAppError } from '../../utils/appError';
import { Code } from '../../utils/response';
import * as stepUpTokenStore from './stepUpTokenStore';

const ALLOWED_STEP_UP_PURPOSES = new Set<string>(Object.values(STEP_UP_PURPOSE));
const ALLOWED_STEP_UP_METHODS = new Set<StepUpMethod>(['passkey', 'email_otp', 'totp']);

export type VerifiedStepUp = {
  userId: number;
  purpose: StepUpPurpose;
  method: StepUpMethod;
  jti: string;
};

type DecodedStepUp = VerifiedStepUp;

function assertJwtConfigured(): void {
  if (!CONFIG.jwtSecret) {
    throw createAppError({
      code: Code.INTERNAL_ERROR,
      httpStatus: 500,
      message: 'Server misconfiguration',
    });
  }
}

function mapConsumeFailureToAppError(reason: stepUpTokenStore.StepUpConsumeFailure) {
  switch (reason) {
    case 'NOT_FOUND':
      return createAppError({
        code: Code.STEP_UP_NOT_FOUND,
        httpStatus: 403,
        message: 'Step-up verification not found',
      });
    case 'ALREADY_USED':
      return createAppError({
        code: Code.STEP_UP_ALREADY_USED,
        httpStatus: 403,
        message: 'Step-up verification already used',
      });
    case 'EXPIRED':
      return createAppError({
        code: Code.STEP_UP_EXPIRED,
        httpStatus: 403,
        message: 'Step-up verification expired',
      });
    case 'PURPOSE_MISMATCH':
      return createAppError({
        code: Code.STEP_UP_PURPOSE_MISMATCH,
        httpStatus: 403,
        message: 'Step-up verification purpose mismatch',
      });
    case 'INVALID':
    default:
      return createAppError({
        code: Code.STEP_UP_INVALID,
        httpStatus: 403,
        message: 'Step-up verification invalid',
      });
  }
}

function decodeStepUpJwt(
  token: string,
  expectedPurpose: StepUpPurpose,
  expectedUserId: number
): DecodedStepUp {
  assertJwtConfigured();

  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, CONFIG.jwtSecret) as jwt.JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw createAppError({
        code: Code.STEP_UP_EXPIRED,
        httpStatus: 403,
        message: 'Step-up verification expired',
      });
    }
    throw createAppError({
      code: Code.STEP_UP_INVALID,
      httpStatus: 403,
      message: 'Step-up verification invalid',
    });
  }

  if (decoded.typ !== STEP_UP_JWT_TYP) {
    throw createAppError({
      code: Code.STEP_UP_INVALID,
      httpStatus: 403,
      message: 'Step-up verification invalid',
    });
  }

  // Login/session JWT uses userId + jti without typ step_up — never accept as step-up.
  if (decoded.userId !== undefined && decoded.userId !== null) {
    throw createAppError({
      code: Code.STEP_UP_INVALID,
      httpStatus: 403,
      message: 'Step-up verification invalid',
    });
  }

  const jti = typeof decoded.jti === 'string' ? decoded.jti.trim() : '';
  if (!jti) {
    throw createAppError({
      code: Code.STEP_UP_INVALID,
      httpStatus: 403,
      message: 'Step-up verification invalid',
    });
  }

  const userId = typeof decoded.sub === 'number' ? decoded.sub : Number(decoded.sub);
  if (!Number.isInteger(userId) || userId <= 0 || userId !== expectedUserId) {
    throw createAppError({
      code: Code.STEP_UP_INVALID,
      httpStatus: 403,
      message: 'Step-up verification invalid',
    });
  }

  const purpose = decoded.purpose;
  if (typeof purpose !== 'string' || !ALLOWED_STEP_UP_PURPOSES.has(purpose)) {
    throw createAppError({
      code: Code.STEP_UP_PURPOSE_MISMATCH,
      httpStatus: 403,
      message: 'Step-up verification purpose mismatch',
    });
  }
  if (purpose !== expectedPurpose) {
    throw createAppError({
      code: Code.STEP_UP_PURPOSE_MISMATCH,
      httpStatus: 403,
      message: 'Step-up verification purpose mismatch',
    });
  }

  const method = decoded.method;
  if (typeof method !== 'string' || !ALLOWED_STEP_UP_METHODS.has(method as StepUpMethod)) {
    throw createAppError({
      code: Code.STEP_UP_INVALID,
      httpStatus: 403,
      message: 'Step-up verification invalid',
    });
  }

  return { userId, purpose: purpose as StepUpPurpose, method: method as StepUpMethod, jti };
}

function assertStoreEntryReady(jti: string, userId: number, purpose: string): void {
  const row = stepUpTokenStore.get(jti);
  if (!row) {
    throw createAppError({
      code: Code.STEP_UP_NOT_FOUND,
      httpStatus: 403,
      message: 'Step-up verification not found',
    });
  }
  if (row.usedAt != null) {
    throw createAppError({
      code: Code.STEP_UP_ALREADY_USED,
      httpStatus: 403,
      message: 'Step-up verification already used',
    });
  }
  if (row.expiresAt <= Date.now()) {
    throw createAppError({
      code: Code.STEP_UP_EXPIRED,
      httpStatus: 403,
      message: 'Step-up verification expired',
    });
  }
  if (row.userId !== userId) {
    throw createAppError({
      code: Code.STEP_UP_INVALID,
      httpStatus: 403,
      message: 'Step-up verification invalid',
    });
  }
  if (row.purpose !== purpose) {
    throw createAppError({
      code: Code.STEP_UP_PURPOSE_MISMATCH,
      httpStatus: 403,
      message: 'Step-up verification purpose mismatch',
    });
  }
}

/**
 * Issue a one-time step-up JWT. Entry is stored in process memory before signing.
 * See stepUpTokenStore.ts for single-instance deployment limits.
 */
export function issueStepUpToken(
  userId: number,
  purpose: StepUpPurpose,
  method: StepUpMethod
): { stepUpToken: string; expiresIn: number; jti: string } {
  assertJwtConfigured();
  const expiresIn = STEP_UP_TOKEN_TTL_SEC;
  const jti = randomUUID();
  const expiresAt = Date.now() + expiresIn * 1000;

  stepUpTokenStore.save(jti, {
    userId,
    purpose,
    method,
    expiresAt,
  });

  const stepUpToken = jwt.sign(
    {
      sub: userId,
      purpose,
      method,
      typ: STEP_UP_JWT_TYP,
      jti,
    },
    CONFIG.jwtSecret,
    { expiresIn }
  );
  return { stepUpToken, expiresIn, jti };
}

/** Verify JWT + in-memory entry without consuming (preview / diagnostics). */
export function verifyStepUpToken(
  token: string,
  expectedPurpose: StepUpPurpose,
  expectedUserId: number
): VerifiedStepUp {
  const decoded = decodeStepUpJwt(token, expectedPurpose, expectedUserId);
  assertStoreEntryReady(decoded.jti, decoded.userId, decoded.purpose);
  return decoded;
}

/**
 * Verify and atomically consume jti. Withdraw routes must use this via requireStepUp.
 */
export function consumeStepUpToken(
  token: string,
  expectedPurpose: StepUpPurpose,
  expectedUserId: number
): VerifiedStepUp {
  const decoded = decodeStepUpJwt(token, expectedPurpose, expectedUserId);
  const result = stepUpTokenStore.consume(decoded.jti, expectedUserId, expectedPurpose);
  if (!result.ok) {
    throw mapConsumeFailureToAppError(result.reason);
  }
  return decoded;
}

export function extractStepUpTokenFromRequest(req: Request): string | undefined {
  const body = req.body as { stepUpToken?: unknown } | undefined;
  // body.stepUpToken takes precedence over X-Step-Up-Token when both are present.
  if (typeof body?.stepUpToken === 'string' && body.stepUpToken.trim()) {
    return body.stepUpToken.trim();
  }
  const header = req.header('x-step-up-token');
  if (typeof header === 'string' && header.trim()) {
    return header.trim();
  }
  return undefined;
}
