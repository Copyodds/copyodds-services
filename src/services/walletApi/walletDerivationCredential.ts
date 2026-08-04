import type { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { scheduleWalletPasswordCosBackup } from '../backup/walletPasswordCosBackup';

/** Plaintext wallet_password rows (no AEAD). */
export const WALLET_PASSWORD_STORE_VERSION = 2;
export const WALLET_DERIVATION_SCHEME = 'v3_refer_pass';

type CredentialStore = Pick<Prisma.TransactionClient, 'walletDerivationCredential'>;

/** True when the bootstrap HMAC key for generateWalletPassword is configured. */
export function isWalletDerivationEncryptionConfigured(): boolean {
  const raw = CONFIG.nodeWalletDerivationEncryptionKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return true;
  if (!raw) return false;
  try {
    return Buffer.from(raw, 'base64').length === 32;
  } catch {
    return false;
  }
}

export function normalizeWalletPassword(value: string): string {
  const password = value.trim();
  if (!password) {
    throw new Error('wallet_password is required');
  }
  if (password.startsWith('aes-256-gcm.')) {
    throw new Error(
      'Invalid wallet derivation credential ciphertext: still aes-256-gcm.*; run migrate:wallet-derivation-credentials to store plaintext wallet_password',
    );
  }
  return password;
}

export async function upsertWalletPassword(
  params: {
    referCode: string;
    userId: number;
    walletPassword: string;
    scheme?: string;
    version?: number;
  },
  store: CredentialStore = prisma,
): Promise<void> {
  const referCode = params.referCode.trim();
  if (!referCode) throw new Error('referCode is required');
  const scheme = params.scheme ?? WALLET_DERIVATION_SCHEME;
  const version = params.version ?? WALLET_PASSWORD_STORE_VERSION;
  const cipher = normalizeWalletPassword(params.walletPassword);
  await store.walletDerivationCredential.upsert({
    where: { referCode },
    create: { referCode, userId: params.userId, cipher, scheme, version },
    update: { userId: params.userId, cipher, scheme, version },
  });
  scheduleWalletPasswordCosBackup({
    referCode,
    userId: params.userId,
    cipher,
    scheme,
    version,
  });
}

/** @deprecated Use upsertWalletPassword */
export async function upsertWalletDerivationCredential(
  params: {
    referCode: string;
    userId: number;
    credential: string;
    scheme?: string;
    version?: number;
  },
  store: CredentialStore = prisma,
): Promise<void> {
  return upsertWalletPassword(
    {
      referCode: params.referCode,
      userId: params.userId,
      walletPassword: params.credential,
      scheme: params.scheme,
      version: params.version,
    },
    store,
  );
}

export async function loadWalletPassword(
  referCode: string,
  store: CredentialStore = prisma,
): Promise<string> {
  const normalizedReferCode = referCode.trim();
  const row = await store.walletDerivationCredential.findUnique({
    where: { referCode: normalizedReferCode },
    select: { cipher: true, version: true },
  });
  if (!row) {
    throw new Error(`Wallet password is missing for referCode=${normalizedReferCode}`);
  }
  return normalizeWalletPassword(row.cipher);
}

/** @deprecated Use loadWalletPassword */
export async function loadWalletDerivationCredential(
  referCode: string,
  store: CredentialStore = prisma,
): Promise<string> {
  return loadWalletPassword(referCode, store);
}
