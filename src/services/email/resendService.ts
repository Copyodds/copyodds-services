import { Resend } from 'resend';
import { CONFIG } from '../../config/env';
import { logger } from '../../utils/logger';
import type { EmailCodeType } from './emailCodeTypes';
import {
  ACTION_BY_TYPE,
  buildEmailHtml,
  buildEmailText,
  formatMailFrom,
  getSubject,
} from './emailTemplates';

let resendClient: Resend | null = null;

function serializeResendError(error: unknown): Record<string, unknown> {
  if (error == null) {
    return {};
  }
  if (typeof error !== 'object') {
    return { raw: String(error) };
  }
  const e = error as Record<string, unknown>;
  return {
    name: e.name,
    message: e.message,
    statusCode: e.statusCode,
  };
}

function getResendClient(): Resend {
  if (!CONFIG.resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  if (!resendClient) {
    resendClient = new Resend(CONFIG.resendApiKey);
  }
  return resendClient;
}

function resolveDelivery(to: string): {
  deliverTo: string;
  intendedTo: string;
  testMode: boolean;
} {
  if (!CONFIG.emailCodeTestMode) {
    return { deliverTo: to, intendedTo: to, testMode: false };
  }
  const testTo = CONFIG.emailCodeTestTo;
  if (!testTo) {
    throw new Error(
      'EMAIL_CODE_TEST_TO is required when test mode is enabled (use your Resend account email)',
    );
  }
  return { deliverTo: testTo, intendedTo: to, testMode: true };
}

export async function sendEmailCode(options: {
  to: string;
  code: string;
  type: EmailCodeType;
}): Promise<void> {
  const { to, code, type } = options;
  const { deliverTo, intendedTo, testMode } = resolveDelivery(to);
  const subject = getSubject(type, code, testMode);
  const action = ACTION_BY_TYPE[type];
  const from = formatMailFrom();

  try {
    const client = getResendClient();
    const { data, error } = await client.emails.send({
      from,
      to: [deliverTo],
      subject,
      html: buildEmailHtml(code, action, { testMode, intendedTo }),
      text: buildEmailText(code, action, { testMode, intendedTo }),
    });

    if (error) {
      const resendError = serializeResendError(error);
      const hint = testMode
        ? 'Set EMAIL_CODE_TEST_TO to the same email as your Resend account; MAIL_FROM should stay onboarding@resend.dev'
        : CONFIG.mailFrom.includes('resend.dev') || from.includes('resend.dev')
          ? 'Enable test mode: EMAIL_CODE_TEST_TO=your-resend-account@email.com (or verify domain for production)'
          : 'Check Resend dashboard: domain verified, API key valid, MAIL_FROM matches verified domain';
      logger.error(
        { resendError, intendedTo, deliverTo, type, from, testMode, hint, provider: 'resend' },
        'resend send failed'
      );
      throw new Error('Failed to send verification email');
    }

    logger.info(
      { intendedTo, deliverTo, type, emailId: data?.id, from, testMode, provider: 'resend' },
      testMode ? 'verification email sent (test mode redirect)' : 'verification email sent'
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'Failed to send verification email') {
      throw err;
    }
    if (
      err instanceof Error &&
      err.message.includes('EMAIL_CODE_TEST_TO is required')
    ) {
      logger.error({ intendedTo: to, type, testMode: CONFIG.emailCodeTestMode }, err.message);
      throw new Error('Email test mode is misconfigured');
    }
    logger.error(
      {
        err: serializeResendError(err),
        intendedTo: to,
        deliverTo,
        type,
        from,
        provider: 'resend',
      },
      'resend send failed'
    );
    throw new Error('Failed to send verification email');
  }
}
