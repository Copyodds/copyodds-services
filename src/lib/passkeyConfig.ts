export type PasskeyUserVerification = 'required' | 'preferred' | 'discouraged';

function getStringListEnv(key: string): string[] {
  return (process.env[key] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isLocalHostRpId(rpId: string): boolean {
  return rpId === 'localhost' || rpId === '127.0.0.1';
}

/** WebAuthn origin must include scheme; allow bare hostnames in env for convenience. */
export function normalizePasskeyOrigin(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/\/+$/, '');
  }
  if (value.startsWith('localhost') || value.startsWith('127.0.0.1')) {
    const withPort = value.includes(':') ? value : `${value}:3000`;
    return `http://${withPort}`.replace(/\/+$/, '');
  }
  return `https://${value}`.replace(/\/+$/, '');
}

function normalizePasskeyOrigins(rawOrigins: string[]): string[] {
  const normalized = rawOrigins.map(normalizePasskeyOrigin).filter(Boolean);
  return ensureHttpsOriginVariants([...new Set(normalized)]);
}

/** Browsers use https:// on deployed sites; PM2 may still inject http:// from an old env. */
export function ensureHttpsOriginVariants(origins: string[]): string[] {
  const out = new Set(origins);
  for (const origin of origins) {
    if (!origin.startsWith('http://')) continue;
    const host = origin.slice('http://'.length).replace(/\/+$/, '');
    if (isLocalHostRpId(host.split(':')[0] ?? host)) continue;
    out.add(`https://${host}`);
  }
  return [...out];
}

function getPasskeyUserVerification(): PasskeyUserVerification {
  const raw = (process.env.PASSKEY_USER_VERIFICATION ?? 'preferred').trim().toLowerCase();
  if (raw === 'required' || raw === 'discouraged') {
    return raw;
  }
  return 'preferred';
}

function isProd(): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

function resolvePasskeyConfig(): { rpId: string; origins: string[] } {
  const rpId = (process.env.PASSKEY_RP_ID ?? '').trim();
  const envOrigins = normalizePasskeyOrigins(getStringListEnv('PASSKEY_ORIGINS'));

  if (rpId && envOrigins.length > 0) {
    return { rpId, origins: envOrigins };
  }

  if (rpId && !isLocalHostRpId(rpId)) {
    const derived = normalizePasskeyOrigin(rpId);
    console.warn(
      `[passkey] PASSKEY_ORIGINS not set — derived origin ${derived} from PASSKEY_RP_ID=${rpId}`
    );
    return { rpId, origins: [derived] };
  }

  if (isProd()) {
    return { rpId, origins: envOrigins };
  }

  console.warn(
    '[passkey] Using localhost dev defaults. For deployed sites set PASSKEY_RP_ID and PASSKEY_ORIGINS=https://your-domain'
  );

  return {
    rpId: rpId || 'localhost',
    origins:
      envOrigins.length > 0
        ? envOrigins
        : [
            'http://localhost:3000',
            'http://localhost:3001',
            'http://127.0.0.1:3000',
            'http://127.0.0.1:3001',
          ],
  };
}

const resolved = resolvePasskeyConfig();

if (resolved.rpId) {
  console.log(`[passkey] rpId=${resolved.rpId} origins=${resolved.origins.join(', ')}`);
}

export const PASSKEY_CHALLENGE_KIND = {
  REGISTER: 1,
  LOGIN: 2,
  /** Withdraw step-up (logged-in user, userVerification required) */
  STEP_UP_WITHDRAW: 3,
} as const;

export type PasskeyChallengeKind = (typeof PASSKEY_CHALLENGE_KIND)[keyof typeof PASSKEY_CHALLENGE_KIND];

export const passkeyConfig = {
  rpId: resolved.rpId,
  rpName: (process.env.PASSKEY_RP_NAME ?? 'CopyOdds').trim() || 'CopyOdds',
  origins: resolved.origins,
  challengeTtlSeconds: Math.max(60, Number(process.env.PASSKEY_CHALLENGE_TTL_SECONDS ?? 600) || 600),
  timeoutMs: Math.max(10_000, Number(process.env.PASSKEY_TIMEOUT_MS ?? 60_000) || 60_000),
  userVerification: getPasskeyUserVerification(),
};

/** WebAuthn allows multiple acceptable RP IDs during verify (e.g. localhost vs 127.0.0.1 in dev). */
export function getExpectedRpIds(): string[] {
  const ids = new Set<string>();
  if (passkeyConfig.rpId) ids.add(passkeyConfig.rpId);
  if (!isProd()) {
    if (passkeyConfig.rpId === 'localhost') ids.add('127.0.0.1');
    if (passkeyConfig.rpId === '127.0.0.1') ids.add('localhost');
  }
  return [...ids];
}

export function isPasskeyConfigured(): boolean {
  return Boolean(passkeyConfig.rpId && passkeyConfig.origins.length > 0);
}

export function assertPasskeyConfigured(): void {
  if (!isPasskeyConfigured()) {
    throw new Error('Passkey is not configured (PASSKEY_RP_ID / PASSKEY_ORIGINS)');
  }
}
