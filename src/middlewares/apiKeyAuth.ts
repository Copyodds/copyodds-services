import type { Request, Response, NextFunction } from 'express';
import { Code, fail } from '../utils/response';

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const configuredKey = process.env.API_KEY;

  if (!configuredKey) {
    if (isProduction()) {
      console.error('[apiKeyAuth] API_KEY is not set in production', { requestId: req.requestId ?? null });
      fail(res, Code.DEPENDENCY_UNAVAILABLE, 'Server misconfiguration', 500);
      return;
    }
    console.warn('[apiKeyAuth] API_KEY is not set, skipping API key authentication');
    return next();
  }

  const headerKey = req.header('x-api-key');

  if (!headerKey || headerKey !== configuredKey) {
    fail(res, Code.API_KEY_INVALID, 'Unauthorized', 401);
    return;
  }

  next();
}

