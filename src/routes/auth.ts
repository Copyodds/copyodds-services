import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';
import { prisma } from '../db';
import { CONFIG } from '../config/env';
import { jwtAuth } from '../middlewares/jwtAuth';
import { Code, success, fail } from '../utils/response';
import {
  generateInviteCode,
  isValidInviteCode,
} from '../lib/inviteCode';
import {
  createReferralBindingAudit,
  normalizeInviteCode,
  REFERRAL_BIND_SOURCE,
  REFERRAL_BIND_STATUS,
  ReferralBindingError,
  resolveReferralBindingByInviteCode,
} from '../services/gas/gas';
import { attemptCustodialOpenForAuthSession } from '../services/custody/custodialWalletOpen';
import { isAppError } from '../utils/appError';
import { getClientIp } from '../lib/clientIp';
import { codeSchema, emailOnlyBodySchema, loginBodySchema } from '../lib/authSchemas';
import { sendCode, verifyCode } from '../services/email/emailCodeService';
import { issueStepUpToken } from '../services/auth/stepUpService';
import { STEP_UP_PURPOSE } from '../lib/stepUpTypes';
import { recordStepUpFailure, recordStepUpIssued } from '../services/audit/stepUpAudit';
import { applyAffiliateTierAutoUpgradeCascade } from '../services/affiliate/affiliateTierAutoUpgrade';
import {
  AUTH_COOKIE_NAME,
  authCookieBaseOptions,
  buildAuthUserPayload,
  issueAuthSession,
} from '../services/auth/authSession';
import { passkeyRouter } from './passkey';
import { twoFaRouter } from './twoFa';

const router = Router();

router.use('/passkey', passkeyRouter);
router.use('/2fa', twoFaRouter);

function handleRouteError(res: import('express').Response, err: unknown, next: import('express').NextFunction): void {
  if (isAppError(err)) {
    fail(res, err.code, err.message, err.httpStatus, err.details ? { details: err.details } : undefined);
    return;
  }
  next(err);
}

const USERNAME_MIN = 1;
const USERNAME_MAX = 64;
const NAME_MAX = 100;
const EMAIL_MAX = 320;
const LOGIN_CODE_FAIL_MESSAGE = '邮箱或验证码错误';

const registerBodySchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, 'first name is required')
    .max(NAME_MAX, 'first name is too long'),
  lastName: z
    .string()
    .trim()
    .min(1, 'last name is required')
    .max(NAME_MAX, 'last name is too long'),
  email: z
    .string()
    .trim()
    .min(1, 'email is required')
    .max(EMAIL_MAX, 'email is too long')
    .email('invalid email')
    .transform((value) => value.toLowerCase()),
  code: codeSchema,
  agreeToTerms: z.boolean().refine((value) => value, 'You must agree to the terms and conditions'),
  // 可选：邀请码，用于绑定上级
  inviteCode: z
    .string()
    .trim()
    .max(64, 'invite code is too long')
    .refine((value) => value.length === 0 || isValidInviteCode(value.trim()), 'invite code is invalid')
    .optional(),
});

function sanitizeUsernamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

async function generateUniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const inviteCode = generateInviteCode();
    const existing = await prisma.user.findUnique({ where: { inviteCode } });
    if (!existing) {
      return inviteCode;
    }
  }

  throw new Error('Failed to generate unique invite code');
}

async function generateUniqueUsername(options: {
  firstName: string;
  lastName: string;
  email: string;
}): Promise<string> {
  const fullNameBase = sanitizeUsernamePart(`${options.firstName}-${options.lastName}`);
  const emailBase = sanitizeUsernamePart(options.email.split('@')[0] ?? '');
  const base = (fullNameBase || emailBase || 'user').slice(0, USERNAME_MAX);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${Math.random().toString(36).slice(2, 8)}`;
    const trimmedBase = base.slice(0, Math.max(USERNAME_MIN, USERNAME_MAX - suffix.length));
    const candidate = `${trimmedBase}${suffix}`;
    const existing = await prisma.user.findUnique({ where: { username: candidate } });
    if (!existing) {
      return candidate;
    }
  }

  throw new Error('Failed to generate unique username');
}

router.post('/register', async (req, res, next) => {
  try {
    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }
    const { firstName, lastName, email, code, inviteCode } = parsed.data;
    const normalizedInviteCode = normalizeInviteCode(inviteCode);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      fail(res, Code.CONFLICT, 'Email already registered', 409);
      return;
    }

    try {
      await verifyCode(email, 'REGISTER', code);
    } catch (err) {
      handleRouteError(res, err, next);
      return;
    }

    let referralBinding:
      | Awaited<ReturnType<typeof resolveReferralBindingByInviteCode>>
      | null = null;
    if (normalizedInviteCode) {
      try {
        referralBinding = await resolveReferralBindingByInviteCode(normalizedInviteCode);
      } catch (error) {
        if (error instanceof ReferralBindingError) {
          await createReferralBindingAudit({
            targetEmail: email,
            inviteCodeRaw: inviteCode ?? null,
            inviteCodeNormalized: normalizedInviteCode,
            bindSource: REFERRAL_BIND_SOURCE.REGISTER,
            bindStatus: error.status,
            failureReason: error.message,
          });
          fail(res, Code.VALIDATION_FAILED, error.message, 400);
          return;
        }
        throw error;
      }
    }

    const username = await generateUniqueUsername({ firstName, lastName, email });

    // 为新用户生成自己的邀请码
    const selfInviteCode = await generateUniqueInviteCode();
    const boundAt = referralBinding ? new Date() : null;

    const created = await prisma.$transaction(async (tx) => {
      const newUser = await (tx as any).user.create({
        data: {
          username,
          email,
          firstName,
          lastName,
          emailVerified: true,
          termsAcceptedAt: new Date(),
          inviteCode: selfInviteCode,
          referrerId: referralBinding?.referrerId,
          referralPath: referralBinding?.referralPath,
          referrerBoundAt: boundAt,
          referrerBindSource: referralBinding ? REFERRAL_BIND_SOURCE.REGISTER : null,
          referrerLockedAt: boundAt,
        },
      });

      if (referralBinding) {
        await createReferralBindingAudit(
          {
            userId: newUser.id,
            referrerId: referralBinding.referrerId,
            targetEmail: email,
            inviteCodeRaw: inviteCode ?? null,
            inviteCodeNormalized: referralBinding.normalizedInviteCode,
            bindSource: REFERRAL_BIND_SOURCE.REGISTER,
            bindStatus: REFERRAL_BIND_STATUS.SUCCESS,
            referralPathSnapshot: referralBinding.referralPath,
            boundAt,
          },
          tx,
        );
      }

      return newUser;
    });

    const createdUser = await prisma.user.findUnique({ where: { id: (created as any).id } });
    if (!createdUser) {
      fail(res, Code.INTERNAL_ERROR, 'Registration failed', 500);
      return;
    }
    if (referralBinding?.referrerId) {
      await applyAffiliateTierAutoUpgradeCascade(referralBinding.referrerId);
    }
    const custody = await attemptCustodialOpenForAuthSession((created as any).id);
    await issueAuthSession(res, createdUser, 201, { custody });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      fail(res, Code.CONFLICT, 'Registration conflict, please retry', 409);
      return;
    }
    next(err);
  }
});

router.post('/email-code/register', async (req, res, next) => {
  try {
    const parsed = emailOnlyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }
    const { email } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      fail(res, Code.CONFLICT, 'Email already registered', 409);
      return;
    }

    await sendCode(email, 'REGISTER', { ip: getClientIp(req) });
    success(res, { success: true, message: '验证码已发送' });
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/email-code/withdraw', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { email: true, emailVerified: true },
    });
    if (!user?.email) {
      fail(res, Code.VALIDATION_FAILED, 'Verified email is required for withdraw confirmation', 400);
      return;
    }
    if (!user.emailVerified) {
      fail(res, Code.FORBIDDEN, 'Email must be verified before withdraw confirmation', 403);
      return;
    }

    await sendCode(user.email, 'WITHDRAW', { ip: getClientIp(req) });
    success(res, { success: true, message: '提现确认验证码已发送' });
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

const withdrawEmailVerifySchema = z.object({
  code: codeSchema,
});

router.post('/email-code/withdraw/verify', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const parsed = withdrawEmailVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { email: true, emailVerified: true },
    });
    if (!user?.email || !user.emailVerified) {
      fail(res, Code.FORBIDDEN, 'Verified email is required', 403);
      return;
    }

    const userId = req.user.userId;
    try {
      await verifyCode(user.email, 'WITHDRAW', parsed.data.code);
    } catch (err) {
      await recordStepUpFailure({
        userId,
        method: 'email_otp',
        reasonCode: 'EMAIL_OTP_INVALID',
        req,
      }).catch(() => undefined);
      handleRouteError(res, err, next);
      return;
    }

    const issued = issueStepUpToken(userId, STEP_UP_PURPOSE.WITHDRAW, 'email_otp');
    await recordStepUpIssued({ userId, method: 'email_otp', jti: issued.jti, req });
    success(res, { stepUpToken: issued.stepUpToken, expiresIn: issued.expiresIn });
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/email-code/login', async (req, res, next) => {
  try {
    const parsed = emailOnlyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }
    const { email } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      fail(res, Code.NOT_FOUND, '该邮箱未注册，请先注册', 404);
      return;
    }

    await sendCode(email, 'LOGIN', { ip: getClientIp(req) });
    req.log?.info({ email, type: 'LOGIN', sent: true }, 'login code sent');
    success(res, { success: true, message: '验证码已发送' });
  } catch (err) {
    handleRouteError(res, err, next);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }
    const { email, code } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      fail(res, Code.INVALID_CREDENTIALS, LOGIN_CODE_FAIL_MESSAGE, 401);
      return;
    }

    try {
      await verifyCode(email, 'LOGIN', code);
    } catch (err) {
      if (isAppError(err) && err.code === Code.VALIDATION_FAILED) {
        fail(res, Code.INVALID_CREDENTIALS, LOGIN_CODE_FAIL_MESSAGE, 401);
        return;
      }
      handleRouteError(res, err, next);
      return;
    }

    const custody = await attemptCustodialOpenForAuthSession(user.id);
    await issueAuthSession(res, user, 200, { custody });
  } catch (err) {
    next(err);
  }
});

/**
 * 登出：作废当前 JWT 对应的数据库会话，之后同一 token 将无法通过校验。
 */
router.post('/logout', jwtAuth, async (req, res, next) => {
  try {
    if (!req.sessionId) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    await prisma.userSession.deleteMany({ where: { id: req.sessionId } });
    res.clearCookie(AUTH_COOKIE_NAME, authCookieBaseOptions());
    success(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Token 检测：校验 JWT + 数据库会话。
 * 前端可用此接口判断 token 是否过期或有效。
 */
router.get('/verify', jwtAuth, (req, res) => {
  if (!req.user) {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }
  success(res, {
    valid: true,
    user: { username: req.user.username },
  });
});

router.get('/me', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const user = await (prisma as any).user.findUnique({
      where: { id: req.user.userId },
    });

    if (!user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    success(res, buildAuthUserPayload(user as Parameters<typeof buildAuthUserPayload>[0]));
  } catch (err) {
    next(err);
  }
});

const patchMeBodySchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, 'first name is required')
    .max(NAME_MAX, 'first name is too long')
    .optional(),
  lastName: z
    .string()
    .trim()
    .min(1, 'last name is required')
    .max(NAME_MAX, 'last name is too long')
    .optional(),
});

router.patch('/me', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const parsed = patchMeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }

    if (!parsed.data.firstName && !parsed.data.lastName) {
      fail(res, Code.VALIDATION_FAILED, 'No fields to update', 400);
      return;
    }

    const updateData: Record<string, string> = {};
    if (parsed.data.firstName) updateData.firstName = parsed.data.firstName;
    if (parsed.data.lastName) updateData.lastName = parsed.data.lastName;

    const updated = await (prisma as any).user.update({
      where: { id: req.user.userId },
      data: updateData,
    });

    success(res, buildAuthUserPayload(updated as Parameters<typeof buildAuthUserPayload>[0]));
  } catch (err) {
    next(err);
  }
});

// Demo：交易执行钱包为服务端 CUSTODIAL，不再接受用户绑定外部 EOA 或提交私钥
router.post('/wallets', jwtAuth, (_req, res) => {
  fail(res, Code.GONE, 'Binding external EOA wallets is disabled. Use POST /api/custody/open for custodial wallet.', 410);
});

// 当前用户托管执行钱包（只读）
router.get('/wallets', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const wallets = await prisma.wallet.findMany({
      where: { userId: req.user.userId, type: 'CUSTODIAL' },
      select: { address: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    success(res, { wallets });
  } catch (err) {
    next(err);
  }
});

router.delete('/wallets/:id', jwtAuth, (_req, res) => {
  fail(res, Code.GONE, 'Custodial wallets cannot be deleted from the API.', 410);
});

router.post('/wallets/private-key', jwtAuth, (_req, res) => {
  fail(res, Code.GONE, 'Private key import is disabled. Use custodial wallet (POST /api/custody/open).', 410);
});

router.get('/wallets/private-key/status', jwtAuth, (_req, res) => {
  fail(res, Code.GONE, 'Private key status is no longer available.', 410);
});

export const authRouter = router;

// 简单的 admin 接口：通过一个预共享的管理密钥设置用户的推广档位
const setTierBodySchema = z.object({
  userId: z.number().int().positive(),
  tier: z.number().int().min(0).max(8),
});

router.post('/admin/affiliate/tier', async (req, res, next) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== CONFIG.adminKey) {
      fail(res, Code.FORBIDDEN, 'Forbidden', 403);
      return;
    }

    const parsed = setTierBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
      return;
    }

    const { userId, tier } = parsed.data;

    const updated = await (prisma as any).user.update({
      where: { id: userId },
      data: {
        affiliateTier: tier === 0 ? null : tier,
      },
    });

    if ((updated as any).affiliateTier) {
      await applyAffiliateTierAutoUpgradeCascade((updated as any).id);
    }

    success(res, {
      id: (updated as any).id,
      affiliateTier: (updated as any).affiliateTier ?? null,
    });
  } catch (err) {
    next(err);
  }
});
