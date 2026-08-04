import type { Request, Response, NextFunction } from 'express';
import { getClientIp } from '../lib/clientIp';
import { Code, fail } from '../utils/response';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * 简单内存限流（多实例部署时每节点独立计数；生产可换 Redis）。
 */
export function authRateLimit(options: { windowMs: number; max: number; keyPrefix: string }) {
  const { windowMs, max, keyPrefix } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const mapKey = `${keyPrefix}:${getClientIp(req)}`;
    let b = buckets.get(mapKey);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(mapKey, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000) || 1));
      fail(res, Code.TOO_MANY_REQUESTS, 'Too many requests', 429);
      return;
    }
    next();
  };
}
