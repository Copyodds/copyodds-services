import type { NextFunction, Request, Response } from 'express';
import { Code, fail } from '../utils/response';
import {
  checkUserTradePermission,
  isUserTradePermissionError,
} from '../services/trading/userTradePermission';
import { isAppError } from '../utils/appError';

/**
 * 拦截已冻结 / 复核中用户的交易与资金变更类接口（不影响只读接口与登录）。
 */
export function requireUserTradePermission(req: Request, res: Response, next: NextFunction) {
  const userId = Number(req.user?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }

  checkUserTradePermission(userId)
    .then(() => next())
    .catch((error: unknown) => {
      if (isUserTradePermissionError(error)) {
        fail(res, Code.TRADING_BLOCKED, error.message, 403, {
          errorCode: error.errorCode,
          tradeStatus: error.tradeStatus,
        });
        return;
      }
      if (isAppError(error)) {
        fail(res, error.code, error.message, error.httpStatus, error.details ? { details: error.details } : undefined);
        return;
      }
      next(error);
    });
}
