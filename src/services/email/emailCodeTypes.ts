import { CONFIG } from '../../config/env';

export type EmailCodeType = 'REGISTER' | 'LOGIN' | 'WITHDRAW';

export const EMAIL_CODE_TTL_SEC = 300;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

export function getEmailCodeSendCooldownSec(): number {
  return CONFIG.emailCodeSendCooldownSec;
}

/** 单邮箱、单类型、单日上限（注册通常只需几次） */
export function getEmailCodeDailyMaxForType(type: EmailCodeType): number {
  if (type === 'LOGIN' || type === 'WITHDRAW') {
    return CONFIG.emailCodeDailyLoginMax;
  }
  return CONFIG.emailCodeDailyRegisterMax;
}

/** 单邮箱、所有验证码类型合计单日上限（无密码登录场景下主要兜底） */
export function getEmailCodeDailyCombinedMax(): number {
  return CONFIG.emailCodeDailyCombinedMax;
}

export function getEmailCodeIpHourlyMax(): number {
  return CONFIG.emailCodeIpHourlyMax;
}

export const EMAIL_CODE_INVALID_MESSAGE = '验证码错误或已过期';

export function formatDayUtc(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function formatHourUtc(d = new Date()): string {
  return `${formatDayUtc(d)}${String(d.getUTCHours()).padStart(2, '0')}`;
}

export function secondsUntilEndOfUtcDay(d = new Date()): number {
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((end - d.getTime()) / 1000));
}
