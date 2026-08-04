import { Router } from 'express';
import { z } from 'zod';
import { jwtAuth } from '../middlewares/jwtAuth';
import { getClientIp } from '../lib/clientIp';
import { codeSchema } from '../lib/authSchemas';
import { Code, success, fail } from '../utils/response';
import { isAppError } from '../utils/appError';
import {
  confirmTotp,
  disableTotp,
  getTwoFactorStatus,
  setupTotp,
  verifyTotpForWithdraw,
} from '../services/auth/totpService';
import { STEP_UP_PURPOSE } from '../lib/stepUpTypes';

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

const totpCodeBodySchema = z.object({
  code: codeSchema,
});

const totpVerifyBodySchema = z.object({
  purpose: z.literal(STEP_UP_PURPOSE.WITHDRAW),
  code: codeSchema,
  to: z.string().trim().min(1),
  amount: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(200),
});

router.get('/status', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const status = await getTwoFactorStatus(req.user.userId);
    success(res, status);
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/totp/setup', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const result = await setupTotp(req.user.userId, req);
    success(res, result);
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/totp/confirm', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = totpCodeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }
    const result = await confirmTotp(
      req.user.userId,
      parsed.data.code,
      getClientIp(req),
      req
    );
    success(res, result);
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/totp/verify', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = totpVerifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }
    const result = await verifyTotpForWithdraw(
      req.user.userId,
      parsed.data.code,
      {
        to: parsed.data.to,
        amount: parsed.data.amount,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      getClientIp(req),
      req
    );
    success(res, result);
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/totp/disable', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = totpCodeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }
    const result = await disableTotp(
      req.user.userId,
      parsed.data.code,
      getClientIp(req),
      req
    );
    success(res, result);
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

export const twoFaRouter = router;
