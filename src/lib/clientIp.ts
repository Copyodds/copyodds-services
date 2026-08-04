import type { Request } from 'express';

/** Client IP from X-Forwarded-For (first hop) or socket address. */
export function getClientIp(req: Request): string {
  const xf = req.header('x-forwarded-for');
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}
