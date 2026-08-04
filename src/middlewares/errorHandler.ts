import type { NextFunction, Request, Response } from 'express';
import { isAppError } from '../utils/appError';
import { Code, fail, resolveResponseCode } from '../utils/response';
import { logger } from '../utils/logger';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const requestId = typeof res.locals?.requestId === 'string' ? res.locals.requestId : undefined;
  logger.error(
    { err, requestId, context: 'errorHandler' },
    err instanceof Error ? err.message : String(err),
  );

  if (res.headersSent) {
    return;
  }

  const appError = isAppError(err) ? err : null;
  const message = appError?.message ?? (err instanceof Error ? err.message : 'Internal server error');
  const httpStatus = appError?.httpStatus ?? 500;
  const code = appError?.code ?? Code.INTERNAL_ERROR;
  const details = appError?.expose ? appError.details : undefined;
  const publicMessage = appError?.expose ? message : 'Internal server error';

  try {
    fail(
      res,
      code,
      publicMessage,
      httpStatus,
      details === undefined ? undefined : { details },
    );
  } catch (sendErr) {
    logger.error(
      { err: sendErr, requestId, context: 'errorHandler.fail' },
      'fail() threw after error',
    );
    if (!res.headersSent) {
      try {
        res.status(500).setHeader('Content-Type', 'application/json; charset=utf-8');
        const responseCode = resolveResponseCode(
          code,
          publicMessage,
          details === undefined ? undefined : { details },
        );
        res.end(
          JSON.stringify({
            code: responseCode,
            data: {
              message: publicMessage,
              ...(details === undefined ? {} : { details }),
            },
            ...(requestId ? { requestId } : {}),
          }),
        );
      } catch {
        res.end();
      }
    }
  }
}
