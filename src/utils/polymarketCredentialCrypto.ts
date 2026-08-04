import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function getKey(): Buffer {
  const raw = (process.env.SECRET_KEY ?? '').trim();
  if (!raw) {
    throw new Error('SECRET_KEY is not set (32-byte key as hex or base64, required for Polymarket credential encryption)');
  }
  const looksHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0;
  const buf = Buffer.from(raw, looksHex ? 'hex' : 'base64');
  if (buf.length !== 32) {
    throw new Error(`SECRET_KEY must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}

/** AES-256-GCM; ciphertext format: iv.tag.ct (base64 each) */
export function encryptPolymarketSecret(plainText: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptPolymarketSecret(payload: string): string {
  const key = getKey();
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted payload');
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
