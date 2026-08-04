/**
 * In-memory one-time step-up token registry (jti → entry).
 *
 * DEPLOYMENT LIMITATION — single Node process / single server instance only.
 * This store is NOT shared across workers. If you run PM2 cluster mode, multiple
 * replicas behind a load balancer, or horizontal scaling, step-up tokens issued on
 * instance A will not be visible on instance B. Migrate to PostgreSQL or Redis before
 * enabling multi-instance deployment.
 */

export type StepUpTokenEntry = {
  userId: number;
  purpose: string;
  method: string;
  expiresAt: number;
  usedAt?: number;
};

export type StepUpConsumeFailure =
  | 'NOT_FOUND'
  | 'ALREADY_USED'
  | 'EXPIRED'
  | 'INVALID'
  | 'PURPOSE_MISMATCH';

const store = new Map<string, StepUpTokenEntry>();

const CLEANUP_INTERVAL_MS = 60_000;

function cleanupExpired(): void {
  const now = Date.now();
  for (const [jti, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(jti);
    }
  }
}

const cleanupTimer = setInterval(() => {
  cleanupExpired();
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

export function save(jti: string, data: StepUpTokenEntry): void {
  cleanupExpired();
  store.set(jti, { ...data });
}

export function get(jti: string): StepUpTokenEntry | undefined {
  cleanupExpired();
  return store.get(jti);
}

/**
 * Mark jti as used. Synchronous; must complete before withdraw handler runs.
 */
export function consume(
  jti: string,
  userId: number,
  purpose: string
): { ok: true; entry: StepUpTokenEntry } | { ok: false; reason: StepUpConsumeFailure } {
  const row = store.get(jti);
  if (!row) {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  if (row.usedAt != null) {
    return { ok: false, reason: 'ALREADY_USED' };
  }
  if (row.expiresAt <= Date.now()) {
    store.delete(jti);
    return { ok: false, reason: 'EXPIRED' };
  }
  if (row.userId !== userId) {
    return { ok: false, reason: 'INVALID' };
  }
  if (row.purpose !== purpose) {
    return { ok: false, reason: 'PURPOSE_MISMATCH' };
  }
  row.usedAt = Date.now();
  store.set(jti, row);
  return { ok: true, entry: row };
}

export { cleanupExpired };

/** Test-only: clear in-memory store between unit tests. */
export function resetStepUpTokenStoreForTests(): void {
  store.clear();
}
