import type { Request } from 'express';
import { getClientIp } from '../../lib/clientIp';
import { recordAuditEvent } from './events';

function auditContext(req?: Request) {
  return {
    ip: req ? getClientIp(req) : null,
    userAgent: req?.header('user-agent') ?? null,
    requestId:
      typeof (req?.res?.locals as { requestId?: unknown } | undefined)?.requestId === 'string'
        ? ((req?.res?.locals as { requestId: string }).requestId)
        : null,
  };
}

export async function recordTotpSetupStarted(params: {
  userId: number;
  req?: Request;
}): Promise<void> {
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.totp.setup_started',
    targetType: 'totp',
    result: 'success',
    ...auditContext(params.req),
  });
}

export async function recordTotpEnabled(params: {
  userId: number;
  req?: Request;
}): Promise<void> {
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.totp.enabled',
    targetType: 'totp',
    result: 'success',
    ...auditContext(params.req),
  });
}

export async function recordTotpVerifySuccess(params: {
  userId: number;
  purpose: string;
  req?: Request;
}): Promise<void> {
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.totp.verify.success',
    targetType: 'totp',
    result: 'success',
    metadata: { purpose: params.purpose },
    ...auditContext(params.req),
  });
}

export async function recordTotpVerifyFailed(params: {
  userId: number;
  purpose: string;
  reasonCode: string;
  req?: Request;
}): Promise<void> {
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.totp.verify.failed',
    targetType: 'totp',
    result: 'failure',
    reasonCode: params.reasonCode,
    metadata: { purpose: params.purpose },
    ...auditContext(params.req),
  });
}

export async function recordTotpDisabled(params: {
  userId: number;
  req?: Request;
}): Promise<void> {
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.totp.disabled',
    targetType: 'totp',
    result: 'success',
    ...auditContext(params.req),
  });
}
