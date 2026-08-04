import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
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

let transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | null = null;

function getTransporter(): nodemailer.Transporter<SMTPTransport.SentMessageInfo> {
  if (!CONFIG.smtpUser || !CONFIG.smtpPass) {
    throw new Error('SMTP_USER and SMTP_PASS are required for gmail_smtp');
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: CONFIG.smtpHost,
      port: CONFIG.smtpPort,
      secure: CONFIG.smtpSecure,
      auth: {
        user: CONFIG.smtpUser,
        pass: CONFIG.smtpPass,
      },
    });
  }
  return transporter;
}

export function serializeSmtpError(err: unknown): Record<string, unknown> {
  if (err == null) {
    return {};
  }
  if (typeof err !== 'object') {
    return { raw: String(err) };
  }
  const e = err as {
    message?: string;
    code?: string;
    response?: string;
    responseCode?: number;
    command?: string;
  };
  return {
    message: e.message,
    code: e.code,
    response: e.response,
    responseCode: e.responseCode,
    command: e.command,
  };
}

export async function sendEmailCode(options: {
  to: string;
  code: string;
  type: EmailCodeType;
}): Promise<void> {
  const { to, type } = options;
  const action = ACTION_BY_TYPE[type];
  const from = formatMailFrom();
  const subject = getSubject(type, options.code);

  try {
    const transport = getTransporter();
    const info = await transport.sendMail({
      from,
      to,
      subject,
      html: buildEmailHtml(options.code, action),
      text: buildEmailText(options.code, action),
    });

    logger.info(
      {
        to,
        type,
        from,
        messageId: info.messageId,
        provider: 'gmail_smtp',
        smtpHost: CONFIG.smtpHost,
        smtpUser: CONFIG.smtpUser,
      },
      'verification email sent'
    );
  } catch (err) {
    logger.error(
      {
        to,
        type,
        from,
        provider: 'gmail_smtp',
        smtpHost: CONFIG.smtpHost,
        smtpUser: CONFIG.smtpUser,
        smtpError: serializeSmtpError(err),
      },
      'smtp send failed'
    );
    throw new Error('Failed to send verification email');
  }
}
