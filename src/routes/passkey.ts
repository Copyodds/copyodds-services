import { Router } from 'express';
import { z } from 'zod';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { jwtAuth } from '../middlewares/jwtAuth';
import { Code, fail, success } from '../utils/response';
import { isAppError } from '../utils/appError';
import { isPasskeyConfigured } from '../lib/passkeyConfig';
import { issueAuthSession } from '../services/auth/authSession';
import {
  createLoginOptions,
  createRegisterOptions,
  createStepUpWithdrawOptions,
  deletePasskey,
  listPasskeys,
  verifyLoginResponse,
  verifyRegisterResponse,
  verifyStepUpWithdrawResponse,
} from '../services/auth/passkeyService';
import { issueStepUpToken } from '../services/auth/stepUpService';
import { STEP_UP_PURPOSE } from '../lib/stepUpTypes';
import { recordStepUpFailure, recordStepUpIssued } from '../services/audit/stepUpAudit';
import { passkeyLoginOptionsBodySchema, passkeyLoginVerifyBodySchema } from '../lib/authSchemas';

const router = Router();

function handleRouteError(
  res: import('express').Response,
  err: unknown,
  next: import('express').NextFunction
): void {
  if (isAppError(err)) {
    fail(res, err.code, err.message, err.httpStatus, err.details ? { details: err.details } : undefined);
    return;
  }
  next(err);
}

function ensurePasskeyEnabled(
  _req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
): void {
  if (!isPasskeyConfigured()) {
    fail(res, Code.PASSKEY_NOT_CONFIGURED, 'Passkey is not configured', 503);
    return;
  }
  next();
}

const registerOptionsBodySchema = z.object({
  label: z.string().trim().max(128).optional(),
});

const registerVerifyBodySchema = z.object({
  requestId: z.string().trim().min(1).max(64),
  label: z.string().trim().max(128).optional(),
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
    transports: z.array(z.string()).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});

const loginVerifyBodySchema = passkeyLoginVerifyBodySchema;

const stepUpVerifyBodySchema = z.object({
  requestId: z.string().trim().min(1).max(64),
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().nullable().optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});

router.post('/step-up/options', jwtAuth, ensurePasskeyEnabled, async (req, res, next) => {
  try {
    const result = await createStepUpWithdrawOptions(req.user!.userId);
    success(res, result);
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/step-up/verify', jwtAuth, ensurePasskeyEnabled, async (req, res, next) => {
  try {
    const parsed = stepUpVerifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }

    const userId = req.user!.userId;
    const { requestId, ...credential } = parsed.data;
    try {
      await verifyStepUpWithdrawResponse({
        userId,
        requestId,
        response: credential as AuthenticationResponseJSON,
      });
    } catch (err) {
      const reasonCode =
        isAppError(err) && err.code === Code.PASSKEY_VERIFY_FAILED
          ? 'PASSKEY_VERIFY_FAILED'
          : 'PASSKEY_STEP_UP_FAILED';
      await recordStepUpFailure({
        userId,
        method: 'passkey',
        reasonCode,
        req,
      }).catch(() => undefined);
      handleRouteError(res, err, next);
      return;
    }

    const issued = issueStepUpToken(userId, STEP_UP_PURPOSE.WITHDRAW, 'passkey');
    await recordStepUpIssued({ userId, method: 'passkey', jti: issued.jti, req });
    success(res, { stepUpToken: issued.stepUpToken, expiresIn: issued.expiresIn });
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/register/options', jwtAuth, ensurePasskeyEnabled, async (req, res, next) => {
  try {
    const parsed = registerOptionsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }

    const result = await createRegisterOptions(req.user!.userId, parsed.data.label);
    success(res, result);
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/register/verify', jwtAuth, ensurePasskeyEnabled, async (req, res, next) => {
  try {
    const parsed = registerVerifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }

    const { requestId, label, ...credential } = parsed.data;
    await verifyRegisterResponse({
      userId: req.user!.userId,
      requestId,
      label,
      response: credential as RegistrationResponseJSON,
    });
    success(res, { success: true });
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/login/options', ensurePasskeyEnabled, async (req, res, next) => {
  try {
    const parsed = passkeyLoginOptionsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }

    const result = await createLoginOptions(parsed.data.email || undefined);
    success(res, result);
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/login/verify', ensurePasskeyEnabled, async (req, res, next) => {
  try {
    const parsed = loginVerifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }

    const { requestId, email, ...credential } = parsed.data;
    const user = await verifyLoginResponse({
      email: email || undefined,
      requestId,
      response: credential as AuthenticationResponseJSON,
    });
    await issueAuthSession(res, user);
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.get('/list', jwtAuth, ensurePasskeyEnabled, async (req, res, next) => {
  try {
    const items = await listPasskeys(req.user!.userId);
    success(res, { items });
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.delete('/:id', jwtAuth, ensurePasskeyEnabled, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid passkey id', 400);
      return;
    }

    await deletePasskey(req.user!.userId, id);
    success(res, { success: true });
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

export const passkeyRouter = router;
