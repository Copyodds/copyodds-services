import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { CONFIG } from '../config/env';
import { Code, fail } from '../utils/response';

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * 内部跟单信号接口：校验 X-Internal-Secret 与 CONFIG.copyInternalSecret（需与 COPY_INTERNAL_SECRET 一致）。
 */
export function internalSecretAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = CONFIG.copyInternalSecret;
  if (!configured) {
    if (isProduction()) {
      console.error('[internalSecretAuth] COPY_INTERNAL_SECRET is not set in production');
    } else {
      console.warn('[internalSecretAuth] COPY_INTERNAL_SECRET is not set');
    }
    fail(res, Code.INTERNAL_ERROR, 'Server misconfiguration', 500);
    return;
  }

  const header = req.header('x-internal-secret');
  if (!header || !secretsEqual(header, configured)) {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }

  next();
}
