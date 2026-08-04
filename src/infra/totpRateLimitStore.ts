/** In-memory TOTP verify rate limit (userId + IP). Single-instance only. */

export const TOTP_VERIFY_MAX_FAILURES = Math.max(
  3,
  Number(process.env.TOTP_VERIFY_MAX_FAILURES ?? 5) || 5
);
export const TOTP_VERIFY_LOCK_SEC = Math.max(
  60,
  Number(process.env.TOTP_VERIFY_LOCK_SEC ?? 300) || 300
);
export const TOTP_VERIFY_WINDOW_SEC = Math.max(
  60,
  Number(process.env.TOTP_VERIFY_WINDOW_SEC ?? 900) || 900
);

type TotpRateEntry = {
  failures: number;
  windowStart: number;
  lockedUntil: number;
};

function rateKey(userId: number, ip: string): string {
  return `${userId}:${ip.trim() || 'unknown'}`;
}

const entries = new Map<string, TotpRateEntry>();

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (entry.lockedUntil <= now && entry.windowStart + TOTP_VERIFY_WINDOW_SEC * 1000 <= now) {
      entries.delete(key);
    }
  }
}, 60_000);
if (typeof sweepTimer.unref === 'function') {
  sweepTimer.unref();
}

export type TotpRateLimitCheck = { ok: true } | { ok: false; retryAfterSec: number };

export function checkTotpRateLimit(userId: number, ip: string): TotpRateLimitCheck {
  const now = Date.now();
  const key = rateKey(userId, ip);
  const entry = entries.get(key);
  if (!entry) {
    return { ok: true };
  }
  if (entry.lockedUntil > now) {
    return { ok: false, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (entry.windowStart + TOTP_VERIFY_WINDOW_SEC * 1000 <= now) {
    entries.delete(key);
    return { ok: true };
  }
  return { ok: true };
}

export function recordTotpVerifyFailure(userId: number, ip: string): void {
  const now = Date.now();
  const key = rateKey(userId, ip);
  let entry = entries.get(key);
  if (!entry || entry.windowStart + TOTP_VERIFY_WINDOW_SEC * 1000 <= now) {
    entry = { failures: 0, windowStart: now, lockedUntil: 0 };
  }
  entry.failures += 1;
  if (entry.failures >= TOTP_VERIFY_MAX_FAILURES) {
    entry.lockedUntil = now + TOTP_VERIFY_LOCK_SEC * 1000;
  }
  entries.set(key, entry);
}

export function clearTotpRateLimit(userId: number, ip: string): void {
  entries.delete(rateKey(userId, ip));
}

export function resetTotpRateLimitStoreForTests(): void {
  entries.clear();
}
