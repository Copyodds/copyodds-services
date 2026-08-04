import type { Request, Response } from 'express';
import { Prisma } from '../generated/prisma/client';
import { CONFIG } from '../config/env';
import { prisma } from '../db';
import { Code, fail } from '../utils/response';

type Bucket = { timestamps: number[] };

export type VirtualCopyRateLimitPolicy = {
  name: string;
  windowMs: number;
  userMax: number;
  ipMax: number;
};

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterMs: number } {
    const now = this.now();
    const cutoff = now - windowMs;
    const bucket = this.buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((value) => value > cutoff);
    if (bucket.timestamps.length >= limit) {
      const retryAfterMs = Math.max(1, bucket.timestamps[0] + windowMs - now);
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterMs };
    }
    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }
}

export const virtualCopyRateLimiter = new SlidingWindowRateLimiter();

function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

async function consumeDistributed(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const now = new Date();
    const cutoff = new Date(now.getTime() - windowMs);
    await tx.virtualCopyRateLimitEvent.deleteMany({
      where: { key, occurredAt: { lte: cutoff } },
    });
    const count = await tx.virtualCopyRateLimitEvent.count({
      where: { key, occurredAt: { gt: cutoff } },
    });
    if (count >= limit) {
      const oldest = await tx.virtualCopyRateLimitEvent.findFirst({
        where: { key, occurredAt: { gt: cutoff } },
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      });
      return {
        allowed: false,
        retryAfterMs: Math.max(1, (oldest?.occurredAt.getTime() ?? now.getTime()) + windowMs - now.getTime()),
      };
    }
    await tx.virtualCopyRateLimitEvent.create({ data: { key, occurredAt: now } });
    return { allowed: true, retryAfterMs: 0 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function enforceVirtualCopyRateLimit(
  req: Request,
  res: Response,
  userId: number,
  policy: VirtualCopyRateLimitPolicy,
  limiter = virtualCopyRateLimiter,
): Promise<boolean> {
  const userKey = `${policy.name}:user:${userId}`;
  const ipKey = `${policy.name}:ip:${requestIp(req)}`;
  const useMemory = process.env.NODE_ENV === 'test';
  const userResult = useMemory
    ? limiter.consume(userKey, policy.userMax, policy.windowMs)
    : await consumeDistributed(userKey, policy.userMax, policy.windowMs);
  const ipResult = useMemory
    ? limiter.consume(ipKey, policy.ipMax, policy.windowMs)
    : await consumeDistributed(ipKey, policy.ipMax, policy.windowMs);
  if (userResult.allowed && ipResult.allowed) return true;

  const retryAfterMs = Math.max(userResult.retryAfterMs, ipResult.retryAfterMs);
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  fail(res, Code.TOO_MANY_REQUESTS, 'Virtual copy request rate limit exceeded', 429, {
    retryAfterMs,
  });
  return false;
}

export const VIRTUAL_COPY_RATE_POLICIES = {
  accountCreate: {
    name: 'virtual-account-create',
    windowMs: CONFIG.virtualCopyRateLimitWindowMs,
    userMax: CONFIG.virtualCopyAccountCreateRateLimit,
    ipMax: CONFIG.virtualCopyAccountCreateIpRateLimit,
  },
  subscriptionWrite: {
    name: 'virtual-subscription-write',
    windowMs: CONFIG.virtualCopyRateLimitWindowMs,
    userMax: CONFIG.virtualCopySubscriptionRateLimit,
    ipMax: CONFIG.virtualCopySubscriptionIpRateLimit,
  },
  close: {
    name: 'virtual-position-close',
    windowMs: CONFIG.virtualCopyRateLimitWindowMs,
    userMax: CONFIG.virtualCopyCloseRateLimit,
    ipMax: CONFIG.virtualCopyCloseIpRateLimit,
  },
} satisfies Record<string, VirtualCopyRateLimitPolicy>;
