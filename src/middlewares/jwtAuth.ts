import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { CONFIG } from '../config/env';
import { prisma } from '../db';
import { recordUserDailyActivity } from '../repositories/userDailyActivityRepository';
import { Code, fail } from '../utils/response';

export interface JwtPayload {
  userId: number;
  username: string;
  jti: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      sessionId?: string;
    }
  }
}

export async function jwtAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const cookieToken =
    typeof (req as Request & { cookies?: Record<string, unknown> }).cookies?.auth_token === 'string'
      ? ((req as Request & { cookies?: Record<string, unknown> }).cookies?.auth_token as string)
      : undefined;
  const token = bearerToken || cookieToken;

  if (!token) {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }

  if (!CONFIG.jwtSecret) {
    fail(res, Code.INTERNAL_ERROR, 'Server misconfiguration', 500);
    return;
  }

  try {
    const payload = jwt.verify(token, CONFIG.jwtSecret) as JwtPayload & { jti?: string };
    if (typeof payload.jti !== 'string' || !payload.jti) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const session = await prisma.userSession.findUnique({
      where: { id: payload.jti },
    });
    if (!session || session.userId !== payload.userId || session.expiresAt <= new Date()) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    req.user = { userId: payload.userId, username: payload.username, jti: payload.jti };
    req.sessionId = payload.jti;
    void recordUserDailyActivity(payload.userId).catch(() => undefined);
    next();
  } catch {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
  }
}
