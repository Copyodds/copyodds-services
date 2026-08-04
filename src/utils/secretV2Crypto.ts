/**
 * 与 wallet/pkg/utils/encrypt_mnemonic.go 的 v2 格式兼容：
 * v2: + base64.RawStdEncoding(salt(16) || nonce(12) || aes-gcm-ciphertext || tag(16))
 * 密钥：Argon2id(passphrase, salt, t=3, m=65536 KiB, p=4, dkLen=32)
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { argon2id } from '@noble/hashes/argon2';

const V2_PREFIX = 'v2:';
const GCM_NONCE_SIZE = 12;
const GCM_TAG_SIZE = 16;

const ARGON2_OPTS = { t: 3, m: 65536, p: 4, dkLen: 32 } as const;

function deriveKey(passphrase: string, salt: Uint8Array): Buffer {
  return Buffer.from(argon2id(passphrase, salt, ARGON2_OPTS));
}

function encodeRawBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}

function decodeRawBase64(s: string): Buffer {
  const pad = (4 - (s.length % 4)) % 4;
  return Buffer.from(s + '='.repeat(pad), 'base64');
}

export function encryptSecretV2(plaintext: string, passphrase: string): string {
  if (!plaintext.trim()) {
    throw new Error('empty plaintext');
  }
  if (!passphrase) {
    throw new Error('empty passphrase');
  }
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const nonce = randomBytes(GCM_NONCE_SIZE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([salt, nonce, enc, tag]);
  return V2_PREFIX + encodeRawBase64(out);
}

export function decryptSecretV2(ciphertext: string, passphrase: string): string {
  const raw = ciphertext.trim();
  if (!raw) {
    throw new Error('empty ciphertext');
  }
  if (!raw.startsWith(V2_PREFIX)) {
    throw new Error('unsupported secret format: expected v2');
  }
  if (!passphrase) {
    throw new Error('empty passphrase');
  }
  const buf = decodeRawBase64(raw.slice(V2_PREFIX.length));
  if (buf.length < 16 + GCM_NONCE_SIZE + GCM_TAG_SIZE) {
    throw new Error('invalid v2 payload');
  }
  const salt = buf.subarray(0, 16);
  const rest = buf.subarray(16);
  const key = deriveKey(passphrase, salt);
  if (rest.length < GCM_NONCE_SIZE + GCM_TAG_SIZE) {
    throw new Error('invalid v2 ciphertext');
  }
  const nonce = rest.subarray(0, GCM_NONCE_SIZE);
  const encWithTag = rest.subarray(GCM_NONCE_SIZE);
  const tag = encWithTag.subarray(encWithTag.length - GCM_TAG_SIZE);
  const data = encWithTag.subarray(0, encWithTag.length - GCM_TAG_SIZE);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString('utf8');
}
