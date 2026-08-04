import type { PublishRobotControlInput, RobotControlEventPayload } from './robotControlTypes';

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

export function buildRobotControlPayload(
  input: PublishRobotControlInput
): RobotControlEventPayload {
  return {
    subscriptionId: input.subscriptionId,
    event: input.event,
    userId: input.userId,
    leaderId: input.leaderId,
    leaderAddress: input.leaderAddress.toLowerCase(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
}

export function assertRobotControlPayloadSafe(payload: RobotControlEventPayload): void {
  for (const key of Object.keys(payload as unknown as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    for (const blocked of SENSITIVE_PAYLOAD_KEYS) {
      if (normalized.includes(blocked)) {
        throw new Error(`robot control payload must not include sensitive field: ${key}`);
      }
    }
  }
}
