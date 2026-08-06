import type { Request, Response, NextFunction } from 'express';
import { Code, fail } from '../utils/response';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const configuredKey = process.env.API_KEY;

  if (!configuredKey) {
    console.error('[apiKeyAuth] API_KEY is not set', { requestId: req.requestId ?? null });
    fail(res, Code.DEPENDENCY_UNAVAILABLE, 'Server misconfiguration', 500);
    return;
  }

  const headerKey = req.header('x-api-key');

  if (!headerKey || headerKey !== configuredKey) {
    fail(res, Code.API_KEY_INVALID, 'Unauthorized', 401);
    return;
  }

  next();
}
