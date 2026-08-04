import type { CopyTradingDispatchPayload, PublishCopyTradingDispatchInput } from './copyTradingTypes';

const SENSITIVE_PAYLOAD_KEYS = new Set([
  'apikey',
  'apisecret',
  'passphrase',
  'privatekey',
  'apikeyencrypted',
  'secret',
  'password',
  'token',
  'credential',
  'encrypted',
]);

export function buildCopyTradingDispatchPayload(
  input: PublishCopyTradingDispatchInput
): CopyTradingDispatchPayload {
  return {
    leaderTradeId: input.leaderTradeId,
    leaderAddress: input.leaderAddress.trim().toLowerCase(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    ...(input.reason !== undefined && { reason: input.reason }),
    ...(input.signalSource !== undefined && { signalSource: input.signalSource }),
    ...(input.txHash !== undefined && { txHash: input.txHash }),
    ...(input.logIndex !== undefined && { logIndex: input.logIndex }),
  };
}

export function assertCopyTradingDispatchPayloadSafe(payload: CopyTradingDispatchPayload): void {
  for (const key of Object.keys(payload as unknown as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    for (const blocked of SENSITIVE_PAYLOAD_KEYS) {
      if (normalized.includes(blocked)) {
        throw new Error(`copy trading dispatch payload must not include sensitive field: ${key}`);
      }
    }
  }
}
