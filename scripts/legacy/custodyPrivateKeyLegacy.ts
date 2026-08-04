/**
 * 历史托管私钥加解密（仅迁移脚本 migrate-custodial-to-go 使用；生产 Node 不持钥）。
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { CONFIG } from '../../src/config/env';

const CUSTODY_KEY = CONFIG.custodyEncryptKey;

function getCipherKey() {
  const raw = CUSTODY_KEY && CUSTODY_KEY.length >= 32 ? CUSTODY_KEY : 'insecure-custody-key-in-dev-mode-123456';
  return Buffer.from(raw.slice(0, 32));
}

export function encryptPrivateKey(pk: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', getCipherKey(), iv);
  const enc = Buffer.concat([cipher.update(pk, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptPrivateKey(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const data = buf.subarray(32);
  const decipher = createDecipheriv('aes-256-gcm', getCipherKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}
