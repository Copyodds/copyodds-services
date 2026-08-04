import { CONFIG } from '../../config/env';
import type { EmailCodeType } from './emailCodeTypes';
import { sendEmailCode as sendViaResend } from './resendService';
import { sendEmailCode as sendViaSmtp } from './smtpEmailService';

export type EmailCodeSendOptions = {
  to: string;
  code: string;
  type: EmailCodeType;
};

export function isEmailProviderConfigured(): boolean {
  if (CONFIG.emailProvider === 'gmail_smtp') {
    return Boolean(CONFIG.smtpHost && CONFIG.smtpUser && CONFIG.smtpPass);
  }
  return Boolean(CONFIG.resendApiKey);
}

export async function sendEmailCode(options: EmailCodeSendOptions): Promise<void> {
  if (CONFIG.emailProvider === 'gmail_smtp') {
    await sendViaSmtp(options);
    return;
  }
  await sendViaResend(options);
}
