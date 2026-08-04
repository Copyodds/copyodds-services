import type { RobotRuntimeManager } from '../runtime/RobotRuntimeManager';
import { parseRobotControlSubject, type RobotControlEventType } from './robotControlSubjects';
import type { RobotControlEventPayload } from './robotControlTypes';

export type RobotControlHandlerResult = {
  ok: boolean;
  action: string;
  subscriptionId: string;
  event: RobotControlEventType | 'unknown';
  reloadResult?: 'upsert' | 'remove' | 'missing';
  error?: string;
  ignored?: boolean;
};

function isValidPayload(raw: unknown): raw is RobotControlEventPayload {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const p = raw as Record<string, unknown>;
  return (
    typeof p.subscriptionId === 'string' &&
    p.subscriptionId.length > 0 &&
    typeof p.event === 'string' &&
    (p.event === 'modify' ||
      p.event === 'pause' ||
      p.event === 'resume' ||
      p.event === 'reload')
  );
}

/**
 * Subject subscriptionId is advisory; payload.subscriptionId is authoritative.
 * Mismatch → warn and still process payload id.
 */
export function resolveSubscriptionIdForRobotEvent(params: {
  subject: string;
  payload: RobotControlEventPayload | null;
}): { subscriptionId: string | null; event: RobotControlEventType | null; subjectMismatch: boolean } {
  const fromSubject = parseRobotControlSubject(params.subject);
  const payload = params.payload;

  if (!payload) {
    return {
      subscriptionId: fromSubject?.subscriptionId ?? null,
      event: fromSubject?.event ?? null,
      subjectMismatch: false,
    };
  }

  const subjectId = fromSubject?.subscriptionId;
  const payloadId = payload.subscriptionId;
  const subjectMismatch = Boolean(subjectId && subjectId !== payloadId);

  return {
    subscriptionId: payloadId,
    event: payload.event,
    subjectMismatch,
  };
}

export async function handleRobotControlEvent(
  runtime: Pick<RobotRuntimeManager, 'reloadSubscriptionFromDb' | 'size'>,
  params: {
    subject: string;
    rawPayload: unknown;
  }
): Promise<RobotControlHandlerResult> {
  const payload = isValidPayload(params.rawPayload) ? params.rawPayload : null;
  const resolved = resolveSubscriptionIdForRobotEvent({
    subject: params.subject,
    payload,
  });

  if (resolved.subjectMismatch) {
    console.warn('[robot-control] subject/payload subscriptionId mismatch; using payload', {
      subject: params.subject,
      subjectSubscriptionId: parseRobotControlSubject(params.subject)?.subscriptionId,
      payloadSubscriptionId: payload?.subscriptionId,
    });
  }

  const subscriptionId = resolved.subscriptionId;
  const event = resolved.event ?? payload?.event ?? 'unknown';

  if (!subscriptionId) {
    return {
      ok: true,
      ignored: true,
      action: 'ignore_invalid',
      subscriptionId: '',
      event: event === 'unknown' ? 'unknown' : event,
    };
  }

  if (!payload) {
    return {
      ok: true,
      ignored: true,
      action: 'ignore_invalid_payload',
      subscriptionId,
      event: event === 'unknown' ? 'unknown' : event,
    };
  }

  try {
    switch (payload.event) {
      case 'modify':
      case 'reload':
      case 'resume': {
        const reloadResult = await runtime.reloadSubscriptionFromDb(subscriptionId);
        return {
          ok: true,
          action: `reload_${reloadResult}`,
          subscriptionId,
          event: payload.event,
          reloadResult,
        };
      }
      case 'pause': {
        const reloadResult = await runtime.reloadSubscriptionFromDb(subscriptionId);
        return {
          ok: true,
          action: `pause_${reloadResult}`,
          subscriptionId,
          event: 'pause',
          reloadResult,
        };
      }
      default:
        return {
          ok: true,
          ignored: true,
          action: 'ignore_unknown_event',
          subscriptionId,
          event: 'unknown',
        };
    }
  } catch (error) {
    return {
      ok: false,
      action: 'handler_error',
      subscriptionId,
      event: payload.event,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
