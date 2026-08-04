import { CONFIG } from '../../config/env';
import type { EmailCodeType } from './emailCodeTypes';

export const SUBJECT_BY_TYPE: Record<EmailCodeType, string> = {
  REGISTER: 'CopyOdds registration verification code',
  LOGIN: 'CopyOdds login verification code',
  WITHDRAW: 'CopyOdds withdrawal confirmation code',
};

export const ACTION_BY_TYPE: Record<EmailCodeType, string> = {
  REGISTER: 'account registration',
  LOGIN: 'sign-in',
  WITHDRAW: 'withdrawal confirmation (not sign-in)',
};

export function formatMailFrom(): string {
  const from = CONFIG.mailFrom.trim();
  if (!from) {
    return CONFIG.smtpUser
      ? `CopyOdds <${CONFIG.smtpUser}>`
      : 'CopyOdds <onboarding@resend.dev>';
  }
  if (from.includes('<') && from.includes('>')) {
    return from;
  }
  return `CopyOdds <${from}>`;
}

export function getSubject(type: EmailCodeType, code: string, testMode?: boolean): string {
  const base = SUBJECT_BY_TYPE[type];
  const withCode = `${code} · ${base}`;
  return testMode ? `[Test] ${withCode}` : withCode;
}

export function buildEmailHtml(
  code: string,
  action: string,
  opts?: { testMode?: boolean; intendedTo?: string }
): string {
  const testBanner =
    opts?.testMode && opts.intendedTo
      ? `<p style="background:#fff3cd;padding:12px;border-radius:8px;color:#856404;font-size:14px;"><strong>Test mode</strong>: This email was intended for <code>${opts.intendedTo}</code> but was forwarded here because the sending domain is not verified. When registering or resetting, enter <strong>${opts.intendedTo}</strong> in the form and use the verification code below.</p>`
      : '';
  const preheader = `Your verification code is ${code}. Valid for 5 minutes.`;
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; line-height: 1.6; color: #333;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
  <h2 style="color: #111;">CopyOdds</h2>
  ${testBanner}
  <p>You are completing <strong>${action}</strong>. Your verification code is:</p>
  <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #111;">${code}</p>
  <p>This code is valid for <strong>5 minutes</strong>. Do not share it with anyone.</p>
  <p style="color: #666; font-size: 14px;">If you did not initiate this request, please ignore this email.</p>
</body>
</html>`.trim();
}

export function buildEmailText(
  code: string,
  action: string,
  opts?: { testMode?: boolean; intendedTo?: string }
): string {
  const lines = [`Verification code: ${code}`, ''];
  if (opts?.testMode && opts.intendedTo) {
    lines.push(
      `[Test mode] Intended for ${opts.intendedTo}; forwarded to this inbox.`,
      `Enter ${opts.intendedTo} on the page and use the verification code above.`,
      ''
    );
  }
  lines.push(
    'CopyOdds',
    `You are completing ${action}.`,
    '',
    'This code is valid for 5 minutes. Do not share it with anyone.',
    'If you did not initiate this request, please ignore this email.'
  );
  return lines.join('\n');
}
