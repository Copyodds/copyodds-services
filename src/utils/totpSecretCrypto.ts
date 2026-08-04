import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CONFIG } from '../config/env';

function getKey(): Buffer {
  const raw = CONFIG.totpSecretEncryptionKey.trim();
  if (!raw) {
    throw new Error('TOTP_SECRET_ENCRYPTION_KEY is not set');
  }
  const looksHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0;
  const buf = Buffer.from(raw, looksHex ? 'hex' : 'base64');
  if (buf.length !== 32) {
    throw new Error(`TOTP_SECRET_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}

/** AES-256-GCM; ciphertext format: iv.tag.ct (base64 each) */
export function encryptTotpSecret(plainText: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptTotpSecret(payload: string): string {
  const key = getKey();
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted TOTP payload');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function isTotpEncryptionConfigured(): boolean {
  return CONFIG.totpSecretEncryptionKey.trim().length > 0;
}
