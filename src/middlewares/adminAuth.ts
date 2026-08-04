import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { prisma } from '../db';
import { CONFIG } from '../config/env';
import { Code, fail } from '../utils/response';

export type AdminAuthLocals = {
  adminUserId: string;
  sessionId: string;
};

function hashSessionSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function tokenFromRequest(req: Request): string | null {
  const auth = (req.headers.authorization ?? '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      return token;
    }
  }
  const cookieName = CONFIG.adminSessionCookieName;
  const cookieHeader = req.headers.cookie ?? '';
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

/**
 * 校验 AdminSession（与 polymarket-admin-api Go 服务相同 token 格式：sessionId.secret）
 */
export async function adminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = tokenFromRequest(req);
  if (!token) {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }

  const dot = token.indexOf('.');
  if (dot <= 0) {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }

  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!sessionId || !secret) {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }

  const wantHash = hashSessionSecret(secret);
  const session = await prisma.adminSession.findFirst({
    where: {
      id: sessionId,
      tokenHash: wantHash,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: {
      adminUser: { select: { id: true, status: true } },
    },
  });

  if (!session || session.adminUser.status !== 'ACTIVE') {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }

  void prisma.adminSession
    .update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  res.locals.adminAuth = {
    adminUserId: session.adminUser.id,
    sessionId: session.id,
  } satisfies AdminAuthLocals;

  next();
}
