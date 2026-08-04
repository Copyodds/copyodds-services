import { dispatchLeaderTrade } from '../services/dispatchLeaderTrade';
import { parseCopyTradingSubject } from './copyTradingSubjects';
import type { CopyTradingDispatchPayload } from './copyTradingTypes';

export type CopyTradingNatsHandlerResult = {
  ok: boolean;
  ignored?: boolean;
  leaderTradeId?: string;
  error?: string;
};

export function parseCopyTradingNatsPayload(raw: unknown): CopyTradingDispatchPayload | null {
  return isValidPayload(raw) ? raw : null;
}

function isValidPayload(raw: unknown): raw is CopyTradingDispatchPayload {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const p = raw as Record<string, unknown>;
  return (
    typeof p.leaderTradeId === 'string' &&
    p.leaderTradeId.length > 0 &&
    typeof p.leaderAddress === 'string' &&
    p.leaderAddress.length > 0
  );
}

export async function handleCopyTradingNatsMessage(params: {
  subject: string;
  rawPayload: unknown;
}): Promise<CopyTradingNatsHandlerResult> {
  const payload = isValidPayload(params.rawPayload) ? params.rawPayload : null;
  if (!payload) {
    return { ok: true, ignored: true, error: 'invalid_payload' };
  }

  const fromSubject = parseCopyTradingSubject(params.subject);
  if (
    fromSubject &&
    fromSubject.leaderAddress !== payload.leaderAddress.trim().toLowerCase()
  ) {
    console.warn('[copy-trading-nats] subject/payload leaderAddress mismatch; using payload', {
      subject: params.subject,
      subjectAddress: fromSubject.leaderAddress,
      payloadAddress: payload.leaderAddress,
    });
  }

  try {
    await dispatchLeaderTrade(payload.leaderTradeId, 'nats');
    return { ok: true, leaderTradeId: payload.leaderTradeId };
  } catch (error) {
    return {
      ok: false,
      leaderTradeId: payload.leaderTradeId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
