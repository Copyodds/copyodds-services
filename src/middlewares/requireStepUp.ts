import type { Request, Response, NextFunction } from 'express';
import type { StepUpPurpose } from '../lib/stepUpTypes';
import {
  extractStepUpTokenFromRequest,
  consumeStepUpToken,
  type VerifiedStepUp,
} from '../services/auth/stepUpService';
import {
  recordStepUpConsumed,
  recordStepUpReplayed,
  recordWithdrawStepUpDenied,
} from '../services/audit/stepUpAudit';
import { isAppError } from '../utils/appError';
import { Code, fail } from '../utils/response';

declare global {
  namespace Express {
    interface Request {
      stepUp?: VerifiedStepUp;
    }
  }
}

function reasonCodeFromStepUpError(err: unknown): string {
  if (!isAppError(err)) return 'STEP_UP_INVALID';
  switch (err.code) {
    case Code.STEP_UP_REQUIRED:
      return 'STEP_UP_REQUIRED';
    case Code.STEP_UP_EXPIRED:
      return 'STEP_UP_EXPIRED';
    case Code.STEP_UP_PURPOSE_MISMATCH:
      return 'STEP_UP_PURPOSE_MISMATCH';
    case Code.STEP_UP_ALREADY_USED:
      return 'STEP_UP_ALREADY_USED';
    case Code.STEP_UP_NOT_FOUND:
      return 'STEP_UP_NOT_FOUND';
    default:
      return 'STEP_UP_INVALID';
  }
}

export function requireStepUp(expectedPurpose: StepUpPurpose) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const token = extractStepUpTokenFromRequest(req);
    if (!token) {
      await recordWithdrawStepUpDenied({
        userId: req.user.userId,
        reasonCode: 'STEP_UP_REQUIRED',
        req,
      }).catch(() => undefined);
      fail(res, Code.STEP_UP_REQUIRED, 'Withdraw requires step-up verification', 403, {
        purpose: expectedPurpose,
      });
      return;
    }

    try {
      req.stepUp = consumeStepUpToken(token, expectedPurpose, req.user.userId);
      await recordStepUpConsumed({
        userId: req.user.userId,
        method: req.stepUp.method,
        jti: req.stepUp.jti,
        req,
      }).catch(() => undefined);
      next();
    } catch (err) {
      const reasonCode = reasonCodeFromStepUpError(err);

      if (isAppError(err) && err.code === Code.STEP_UP_ALREADY_USED) {
        await recordStepUpReplayed({
          userId: req.user.userId,
          reasonCode,
          req,
        }).catch(() => undefined);
      } else {
        await recordWithdrawStepUpDenied({
          userId: req.user.userId,
          reasonCode,
          req,
        }).catch(() => undefined);
      }

      if (isAppError(err)) {
        fail(res, err.code, err.message, err.httpStatus, err.details ? { details: err.details } : undefined);
        return;
      }
      fail(res, Code.STEP_UP_INVALID, 'Step-up verification invalid', 403);
    }
  };
}
