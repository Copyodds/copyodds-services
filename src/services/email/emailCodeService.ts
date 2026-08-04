import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { CONFIG } from '../../config/env';
import {
  deleteActiveCode,
  getActiveCode,
  listSendEventsSince,
  recordSendEvent,
  setActiveCode,
  updateActiveCode,
} from '../../infra/emailCodeMemoryStore';
import { createAppError } from '../../utils/appError';
import { Code } from '../../utils/response';
import { isEmailProviderConfigured, sendEmailCode } from './emailSender';
import {
  EMAIL_CODE_INVALID_MESSAGE,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_SEC,
  getEmailCodeDailyCombinedMax,
  getEmailCodeDailyMaxForType,
  getEmailCodeIpHourlyMax,
  getEmailCodeSendCooldownSec,
  type EmailCodeType,
} from './emailCodeTypes';

function getPepper(): string {
  const pepper = CONFIG.emailCodePepper;
  if (!pepper) {
    throw createAppError({
      code: Code.DEPENDENCY_UNAVAILABLE,
      httpStatus: 503,
      message: 'Email verification is not configured',
    });
  }
  return pepper;
}

export function generateCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

export function hashCode(code: string): string {
  return createHmac('sha256', getPepper()).update(code).digest('hex');
}

export function compareCode(code: string, codeHash: string): boolean {
  const computed = hashCode(code);
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(codeHash, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function dayStartUtcMs(d = new Date()): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function hourStartUtcMs(d = new Date()): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
}

export async function checkRateLimit(
  email: string,
  ip: string,
  type: EmailCodeType
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const now = Date.now();
  const cooldownSince = now - getEmailCodeSendCooldownSec() * 1000;
  const dayStart = dayStartUtcMs();
  const hourStart = hourStartUtcMs();

  const recentEvents = listSendEventsSince(Math.min(cooldownSince, dayStart, hourStart));

  if (
    recentEvents.some(
      (e) =>
        e.email === normalizedEmail &&
        e.type === type &&
        e.createdAt >= cooldownSince
    )
  ) {
    throw createAppError({
      code: Code.TOO_MANY_REQUESTS,
      httpStatus: 429,
      message: '发送过于频繁，请稍后再试',
    });
  }

  const combinedCount = recentEvents.filter(
    (e) => e.email === normalizedEmail && e.createdAt >= dayStart
  ).length;
  if (combinedCount >= getEmailCodeDailyCombinedMax()) {
    throw createAppError({
      code: Code.TOO_MANY_REQUESTS,
      httpStatus: 429,
      message: '今日验证码发送次数已达上限，请明日再试或联系客服',
    });
  }

  const dailyCount = recentEvents.filter(
    (e) => e.email === normalizedEmail && e.type === type && e.createdAt >= dayStart
  ).length;
  const dailyMax = getEmailCodeDailyMaxForType(type);
  if (dailyCount >= dailyMax) {
    throw createAppError({
      code: Code.TOO_MANY_REQUESTS,
      httpStatus: 429,
      message:
        type === 'LOGIN'
          ? '今日登录验证码发送次数已达上限，请稍后再试'
          : '今日注册验证码发送次数已达上限，请稍后再试',
    });
  }

  const ipTrimmed = ip.trim();
  if (ipTrimmed) {
    const ipCount = recentEvents.filter(
      (e) => e.ip === ipTrimmed && e.createdAt >= hourStart
    ).length;
    if (ipCount >= getEmailCodeIpHourlyMax()) {
      throw createAppError({
        code: Code.TOO_MANY_REQUESTS,
        httpStatus: 429,
        message: '发送过于频繁，请稍后再试',
      });
    }
  }
}

export async function sendCode(
  email: string,
  type: EmailCodeType,
  options: { ip: string }
): Promise<void> {
  if (!isEmailProviderConfigured()) {
    throw createAppError({
      code: Code.DEPENDENCY_UNAVAILABLE,
      httpStatus: 503,
      message: 'Email service is not configured',
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const ipTrimmed = options.ip.trim();
  await checkRateLimit(normalizedEmail, ipTrimmed, type);

  const plainCode = generateCode();
  const codeHash = hashCode(plainCode);
  const now = Date.now();

  setActiveCode({
    codeHash,
    email: normalizedEmail,
    type,
    attempts: 0,
    maxAttempts: EMAIL_CODE_MAX_ATTEMPTS,
    expiresAt: now + EMAIL_CODE_TTL_SEC * 1000,
    createdAt: now,
  });

  try {
    await sendEmailCode({ to: normalizedEmail, code: plainCode, type });
  } catch {
    deleteActiveCode(normalizedEmail, type);
    throw createAppError({
      code: Code.DEPENDENCY_UNAVAILABLE,
      httpStatus: 503,
      message: '验证码发送失败，请稍后重试',
    });
  }

  recordSendEvent({
    email: normalizedEmail,
    type,
    ip: ipTrimmed,
    createdAt: now,
  });
}

export async function verifyCode(
  email: string,
  type: EmailCodeType,
  code: string
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const entry = getActiveCode(normalizedEmail, type);
  if (!entry) {
    throw createAppError({
      code: Code.VALIDATION_FAILED,
      httpStatus: 400,
      message: EMAIL_CODE_INVALID_MESSAGE,
    });
  }

  if (entry.attempts >= entry.maxAttempts) {
    deleteActiveCode(normalizedEmail, type);
    throw createAppError({
      code: Code.VALIDATION_FAILED,
      httpStatus: 400,
      message: EMAIL_CODE_INVALID_MESSAGE,
    });
  }

  if (!compareCode(code, entry.codeHash)) {
    const nextAttempts = entry.attempts + 1;
    if (nextAttempts >= entry.maxAttempts) {
      deleteActiveCode(normalizedEmail, type);
    } else {
      updateActiveCode(normalizedEmail, type, { attempts: nextAttempts });
    }
    throw createAppError({
      code: Code.VALIDATION_FAILED,
      httpStatus: 400,
      message: EMAIL_CODE_INVALID_MESSAGE,
    });
  }

  deleteActiveCode(normalizedEmail, type);
}

export async function deleteCode(email: string, type: EmailCodeType): Promise<void> {
  deleteActiveCode(email.trim().toLowerCase(), type);
}
