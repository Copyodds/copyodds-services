import type { Request } from 'express';
import { getClientIp } from '../../lib/clientIp';
import type { StepUpMethod } from '../../lib/stepUpTypes';
import { recordAuditEvent } from './events';

function auditContext(req?: Request) {
  return {
    ip: req ? getClientIp(req) : null,
    userAgent: req?.header('user-agent') ?? null,
    requestId:
      typeof resLocalsRequestId(req) === 'string' ? resLocalsRequestId(req) : null,
  };
}

function resLocalsRequestId(req?: Request): string | undefined {
  const id = (req?.res?.locals as { requestId?: unknown } | undefined)?.requestId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

/** Passkey / email verification succeeded; step-up JWT issued (not yet consumed). */
export async function recordStepUpIssued(params: {
  userId: number;
  method: StepUpMethod;
  jti: string;
  req?: Request;
}): Promise<void> {
  const ctx = auditContext(params.req);
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.step_up.issued',
    targetType: 'step_up',
    targetId: params.jti,
    result: 'success',
    metadata: { method: params.method, purpose: 'withdraw' },
    ...ctx,
  });
}

/** Step-up token consumed on a protected withdraw route. */
export async function recordStepUpConsumed(params: {
  userId: number;
  method: StepUpMethod;
  jti: string;
  req?: Request;
}): Promise<void> {
  const ctx = auditContext(params.req);
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.step_up.consumed',
    targetType: 'step_up',
    targetId: params.jti,
    result: 'success',
    metadata: { method: params.method, purpose: 'withdraw' },
    ...ctx,
  });
}

/** Reuse of an already-consumed step-up jti. */
export async function recordStepUpReplayed(params: {
  userId: number;
  reasonCode: string;
  req?: Request;
}): Promise<void> {
  const ctx = auditContext(params.req);
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.step_up.replayed',
    targetType: 'step_up',
    result: 'failure',
    reasonCode: params.reasonCode,
    metadata: { purpose: 'withdraw' },
    ...ctx,
  });
}

export async function recordStepUpSuccess(params: {
  userId: number;
  method: StepUpMethod;
  req?: Request;
}): Promise<void> {
  const ctx = auditContext(params.req);
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.step_up.success',
    targetType: 'step_up',
    targetId: params.method,
    result: 'success',
    metadata: { method: params.method, purpose: 'withdraw' },
    ...ctx,
  });
}

export async function recordStepUpFailure(params: {
  userId: number;
  method: StepUpMethod;
  reasonCode: string;
  req?: Request;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const ctx = auditContext(params.req);
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'security.step_up.failed',
    targetType: 'step_up',
    targetId: params.method,
    result: 'failure',
    reasonCode: params.reasonCode,
    metadata: { method: params.method, purpose: 'withdraw', ...params.metadata },
    ...ctx,
  });
}

export async function recordWithdrawStepUpDenied(params: {
  userId: number;
  reasonCode: string;
  req?: Request;
}): Promise<void> {
  const ctx = auditContext(params.req);
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'custody.withdraw.denied',
    targetType: 'withdraw',
    result: 'failure',
    reasonCode: params.reasonCode,
    metadata: { stage: 'step_up' },
    ...ctx,
  });
}

export async function recordWithdrawApproved(params: {
  userId: number;
  method: StepUpMethod;
  endpoint: string;
  req?: Request;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const ctx = auditContext(params.req);
  await recordAuditEvent({
    actorType: 'user',
    actorId: String(params.userId),
    userId: params.userId,
    action: 'custody.withdraw.approved',
    targetType: 'withdraw',
    targetId: params.endpoint,
    result: 'success',
    metadata: { method: params.method, ...params.metadata },
    ...ctx,
  });
}
