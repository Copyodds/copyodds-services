import type { EmailCodeType } from '../services/email/emailCodeTypes';

const SWEEP_INTERVAL_MS = 60_000;
const SEND_EVENT_RETENTION_MS = 25 * 3600 * 1000;

export type EmailCodeEntry = {
  codeHash: string;
  email: string;
  type: EmailCodeType;
  attempts: number;
  maxAttempts: number;
  expiresAt: number;
  createdAt: number;
};

export type EmailCodeSendEvent = {
  email: string;
  type: EmailCodeType;
  ip: string;
  createdAt: number;
};

function codeKey(type: EmailCodeType, email: string): string {
  return `${type}:${email}`;
}

const activeCodes = new Map<string, EmailCodeEntry>();
const sendEvents: EmailCodeSendEvent[] = [];

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of activeCodes) {
    if (entry.expiresAt <= now) {
      activeCodes.delete(key);
    }
  }
  while (sendEvents.length > 0 && sendEvents[0]!.createdAt < now - SEND_EVENT_RETENTION_MS) {
    sendEvents.shift();
  }
}

const sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === 'function') {
  sweepTimer.unref();
}

export function getActiveCode(email: string, type: EmailCodeType): EmailCodeEntry | null {
  sweepExpired();
  const entry = activeCodes.get(codeKey(type, email));
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) {
      activeCodes.delete(codeKey(type, email));
    }
    return null;
  }
  return entry;
}

export function setActiveCode(entry: EmailCodeEntry): void {
  activeCodes.set(codeKey(entry.type, entry.email), entry);
}

export function updateActiveCode(
  email: string,
  type: EmailCodeType,
  patch: Partial<Pick<EmailCodeEntry, 'attempts'>>
): void {
  const key = codeKey(type, email);
  const entry = activeCodes.get(key);
  if (!entry) return;
  activeCodes.set(key, { ...entry, ...patch });
}

export function deleteActiveCode(email: string, type: EmailCodeType): void {
  activeCodes.delete(codeKey(type, email));
}

export function recordSendEvent(event: EmailCodeSendEvent): void {
  sendEvents.push(event);
}

export function listSendEventsSince(sinceMs: number): EmailCodeSendEvent[] {
  sweepExpired();
  return sendEvents.filter((e) => e.createdAt >= sinceMs);
}

/** 测试用：清空进程内状态 */
export function resetEmailCodeMemoryStoreForTests(): void {
  activeCodes.clear();
  sendEvents.length = 0;
}
