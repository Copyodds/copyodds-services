/** Wallet password helpers for Go custody (plaintext store keyed by referCode). */
import { createHmac } from 'node:crypto';
import { CONFIG } from '../../config/env';

function bootstrapKey(): Buffer {
  const raw = CONFIG.nodeWalletDerivationEncryptionKey.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('NODE_WALLET_DERIVATION_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return key;
}

/**
 * Deterministic bootstrap password so a failed Node transaction can safely retry
 * Go createWallet with the same password. Persisted in plaintext by referCode.
 */
export function generateWalletPassword(referCode: string): string {
  const normalized = referCode.trim();
  if (!normalized) {
    throw new Error('referCode is required to generate a wallet bootstrap password');
  }
  return createHmac('sha256', bootstrapKey())
    .update('wallet-bootstrap-password-v1\0', 'utf8')
    .update(normalized, 'utf8')
    .digest('base64url');
}

export function encryptWalletPassword(plaintext: string): string {
  return plaintext;
}

export function decryptWalletPassword(stored: string): string {
  return stored;
}
