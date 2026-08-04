import { randomBytes } from 'node:crypto';

export const INVITE_CODE_LENGTH = 11;

/** Excludes ambiguous glyphs: 0/O/o, 1/l/L/i/I */
export const INVITE_CODE_ALPHABET =
  'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

function inviteCodeCharClass(): string {
  return INVITE_CODE_ALPHABET.replace(/[\\\]^-]/g, '\\$&');
}

export const INVITE_CODE_REGEX = new RegExp(
  `^[${inviteCodeCharClass()}]{${INVITE_CODE_LENGTH}}$`,
);

export function isValidInviteCode(value: string): boolean {
  return INVITE_CODE_REGEX.test(value);
}

export function normalizeInviteCode(inviteCode?: string | null): string | undefined {
  const normalized = inviteCode?.trim();
  if (!normalized) return undefined;
  if (!isValidInviteCode(normalized)) return undefined;
  return normalized;
}

export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    out += INVITE_CODE_ALPHABET[bytes[i]! % INVITE_CODE_ALPHABET.length];
  }
  return out;
}
