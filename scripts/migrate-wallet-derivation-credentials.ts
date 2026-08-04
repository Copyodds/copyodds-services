/**
 * Backfill plaintext wallet_password (by referCode) for GO_REMOTE custodial wallets.
 *
 * Password source (in order):
 *   1. User.encryptedWalletPassword (legacy plaintext)
 *   2. generateWalletPassword(referCode) — same bootstrap used at create time
 *
 * Verifies via Go createWallet (idempotent address check), then stores plaintext password.
 *
 * Dry run:
 *   npm run migrate:wallet-derivation-credentials
 * Execute (clears legacy password by default):
 *   MIGRATE_EXECUTE=1 npm run migrate:wallet-derivation-credentials
 * Preserve legacy field temporarily:
 *   MIGRATE_EXECUTE=1 MIGRATE_CLEAR_LEGACY_PASSWORD=0 npm run migrate:wallet-derivation-credentials
 */
import '../src/loadEnv';
import { ethers } from 'ethers';
import { prisma } from '../src/db';
import { normalizeInviteCode } from '../src/lib/inviteCode';
import { goCreateWallet, isGoWalletCustodyConfigured } from '../src/services/walletApi/goWalletClient';
import {
  isWalletDerivationEncryptionConfigured,
  loadWalletPassword,
  upsertWalletPassword,
  WALLET_PASSWORD_STORE_VERSION,
} from '../src/services/walletApi/walletDerivationCredential';
import { generateWalletPassword } from '../src/services/custody/walletPasswordCrypto';
import { WALLET_DERIVE_MIGRATION_STATUS } from '../src/services/custody/walletDeriveMigration';

const execute = ['1', 'true'].includes((process.env.MIGRATE_EXECUTE ?? '').toLowerCase());
const clearLegacy = !['0', 'false'].includes(
  (process.env.MIGRATE_CLEAR_LEGACY_PASSWORD ?? '1').toLowerCase(),
);
const forceRewrite = ['1', 'true'].includes((process.env.MIGRATE_FORCE_REWRITE ?? '').toLowerCase());
const requestedUserId = Number(process.env.MIGRATE_USER_ID ?? '');

async function migrateUser(userId: number): Promise<'applied' | 'dry_run' | 'skipped'> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      inviteCode: true,
      encryptedWalletPassword: true,
      walletDerivationCredential: { select: { referCode: true, cipher: true, version: true } },
      wallets: {
        where: { type: 'CUSTODIAL' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: {
          address: true,
          walletIndex: true,
          signingProvider: true,
          derivationScheme: true,
        },
      },
    },
  });
  if (!user) throw new Error(`userId=${userId}: user not found`);
  const referCode = normalizeInviteCode(user.inviteCode);
  if (!referCode) throw new Error(`userId=${userId}: invalid inviteCode`);

  const existing = user.walletDerivationCredential;
  const looksPlaintext =
    existing &&
    !existing.cipher.startsWith('aes-256-gcm.') &&
    existing.version >= WALLET_PASSWORD_STORE_VERSION;

  if (looksPlaintext && !forceRewrite) {
    await loadWalletPassword(referCode);
    if (execute && clearLegacy && user.encryptedWalletPassword) {
      await prisma.user.update({
        where: { id: userId },
        data: { encryptedWalletPassword: null },
      });
    }
    console.log({
      userId,
      referCode,
      outcome: 'skipped_existing_plaintext_password',
      clearedLegacyPassword: Boolean(execute && clearLegacy && user.encryptedWalletPassword),
    });
    return 'skipped';
  }

  const wallet = user.wallets[0];
  if (!wallet) throw new Error(`userId=${userId}: custodial wallet not found`);
  if (wallet.signingProvider !== 'GO_REMOTE') {
    throw new Error(`userId=${userId}: signingProvider=${wallet.signingProvider}, expected GO_REMOTE`);
  }
  if (wallet.walletIndex == null) {
    throw new Error(`userId=${userId}: walletIndex is missing`);
  }

  const walletPassword =
    user.encryptedWalletPassword?.trim() || generateWalletPassword(referCode);

  const created = await goCreateWallet(referCode, walletPassword);
  const expectedAddress = ethers.utils.getAddress(wallet.address);
  const returnedAddress = ethers.utils.getAddress(created.polygonAddress);
  if (returnedAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      `userId=${userId}: address mismatch expected=${expectedAddress} returned=${returnedAddress}`,
    );
  }
  if (created.walletIndex !== wallet.walletIndex) {
    throw new Error(
      `userId=${userId}: walletIndex mismatch expected=${wallet.walletIndex} returned=${created.walletIndex}`,
    );
  }

  if (!execute) {
    console.log({
      userId,
      referCode,
      outcome: 'dry_run_verified',
      address: returnedAddress,
      walletIndex: created.walletIndex,
      passwordSource: user.encryptedWalletPassword?.trim() ? 'legacy' : 'bootstrap',
      clearLegacy,
      rewritingEncryptedRow: Boolean(existing?.cipher.startsWith('aes-256-gcm.')),
    });
    return 'dry_run';
  }

  await prisma.$transaction(async (tx) => {
    await upsertWalletPassword(
      {
        referCode,
        userId,
        walletPassword,
        scheme: wallet.derivationScheme ?? undefined,
      },
      tx,
    );
    await tx.user.update({
      where: { id: userId },
      data: {
        encryptedWalletPassword: clearLegacy ? null : walletPassword,
        walletDeriveMigrationStatus: WALLET_DERIVE_MIGRATION_STATUS.COMPLETED,
      },
    });
  });
  console.log({
    userId,
    referCode,
    outcome: 'applied',
    address: returnedAddress,
    walletIndex: created.walletIndex,
    passwordSource: user.encryptedWalletPassword?.trim() ? 'legacy' : 'bootstrap',
    clearedLegacyPassword: clearLegacy,
  });
  return 'applied';
}

async function main(): Promise<void> {
  if (!isGoWalletCustodyConfigured()) {
    throw new Error('GO_WALLET_SERVICE_URL, GO_WALLET_APP_KEY and GO_WALLET_APP_TOKEN are required');
  }
  if (!isWalletDerivationEncryptionConfigured()) {
    throw new Error('NODE_WALLET_DERIVATION_ENCRYPTION_KEY must be configured (bootstrap HMAC key)');
  }
  const users = Number.isSafeInteger(requestedUserId) && requestedUserId > 0
    ? [{ id: requestedUserId }]
    : await prisma.user.findMany({
        where: {
          wallets: { some: { type: 'CUSTODIAL', signingProvider: 'GO_REMOTE' } },
          OR: [
            { encryptedWalletPassword: { not: null } },
            { walletDerivationCredential: { is: null } },
            {
              walletDerivationCredential: {
                OR: [
                  { cipher: { startsWith: 'aes-256-gcm.' } },
                  { version: { lt: WALLET_PASSWORD_STORE_VERSION } },
                ],
              },
            },
          ],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
  const summary = { applied: 0, dry_run: 0, skipped: 0, failed: 0 };
  for (const { id } of users) {
    try {
      summary[await migrateUser(id)]++;
    } catch (error) {
      summary.failed++;
      console.error({
        userId: id,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  console.log({ execute, clearLegacy, forceRewrite, total: users.length, ...summary });
  if (summary.failed > 0) process.exitCode = 1;
}

void main().finally(() => prisma.$disconnect());
