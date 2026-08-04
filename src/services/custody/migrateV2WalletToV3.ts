import { ethers } from 'ethers';
import { prisma } from '../../db';
import { normalizeInviteCode } from '../../lib/inviteCode';
import { goCreateWallet } from '../walletApi/goWalletClient';
import { generateWalletPassword } from './walletPasswordCrypto';
import { WALLET_DERIVE_MIGRATION_STATUS } from './walletDeriveMigration';
import { upsertWalletPassword } from '../walletApi/walletDerivationCredential';

export type MigrateV2WalletToV3Outcome =
  | 'applied'
  | 'dry_run'
  | 'skipped_already_v3'
  | 'skipped_invalid_scheme'
  | 'skipped_signing_provider'
  | 'skipped_no_invite_code'
  | 'skipped_no_wallet'
  | 'skipped_user_not_found'
  | 'skipped_has_balance'
  | 'failed';

export type MigrateV2WalletToV3Result = {
  userId: number;
  outcome: MigrateV2WalletToV3Outcome;
  referCode?: string;
  previousAddress?: string;
  nextAddress?: string;
  addressChanged?: boolean;
  previousWalletIndex?: number | null;
  nextWalletIndex?: number;
  previousScheme?: string;
  generatedPassword?: boolean;
  error?: string;
};

export async function migrateV2WalletToV3ForUser(input: {
  userId: number;
  execute: boolean;
  force?: boolean;
  skipIfBalance?: boolean;
}): Promise<MigrateV2WalletToV3Result> {
  const { userId, execute, force = false, skipIfBalance = false } = input;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        inviteCode: true,
        encryptedWalletPassword: true,
        walletDeriveMigrationStatus: true,
      },
    });
    if (!user) {
      return { userId, outcome: 'skipped_user_not_found' };
    }

    const referCode = normalizeInviteCode(user.inviteCode);
    if (!referCode) {
      return { userId, outcome: 'skipped_no_invite_code' };
    }

    const wallet = await prisma.wallet.findFirst({
      where: { userId, type: 'CUSTODIAL' } as any,
      orderBy: { createdAt: 'asc' },
    });
    if (!wallet) {
      return { userId, outcome: 'skipped_no_wallet' };
    }

    const scheme = String((wallet as any).derivationScheme ?? 'v3_refer_pass');
    if (scheme === 'v3_refer_pass' && !force) {
      return { userId, outcome: 'skipped_already_v3', referCode, previousScheme: scheme };
    }
    if (scheme !== 'v2_hd' && !force) {
      return {
        userId,
        outcome: 'skipped_invalid_scheme',
        referCode,
        previousScheme: scheme,
      };
    }

    const signingProvider = String((wallet as any).signingProvider ?? '');
    if (signingProvider !== 'GO_REMOTE') {
      return {
        userId,
        outcome: 'skipped_signing_provider',
        referCode,
        error: `signingProvider=${signingProvider}`,
      };
    }

    if (skipIfBalance) {
      const [assets, balanceCache] = await Promise.all([
        prisma.userAsset.findMany({
          where: { userId },
          select: { available: true, locked: true },
        }),
        prisma.userBalanceCache.findUnique({
          where: { userId },
          select: { depositUsdc: true, depositPusd: true, custodyUsdc: true },
        }),
      ]);
      const assetTotal = assets.reduce(
        (sum, row) => sum + Number(row.available) + Number(row.locked),
        0
      );
      const cacheTotal = balanceCache
        ? Number(balanceCache.depositUsdc) +
          Number(balanceCache.depositPusd) +
          Number(balanceCache.custodyUsdc)
        : 0;
      if (assetTotal > 0.01 || cacheTotal > 0.01) {
        return {
          userId,
          outcome: 'skipped_has_balance',
          referCode,
          previousAddress: wallet.address,
          error: `assetTotal=${assetTotal.toFixed(4)} cacheTotal=${cacheTotal.toFixed(4)}`,
        };
      }
    }

    const previousAddress = ethers.utils.getAddress(wallet.address);
    const previousWalletIndex = (wallet as any).walletIndex as number | null;

    let walletPassword = user.encryptedWalletPassword?.trim() || null;
    let generatedPassword = false;
    if (!walletPassword) {
      walletPassword = generateWalletPassword(referCode);
      generatedPassword = true;
    }

    const { polygonAddress, walletIndex } = await goCreateWallet(
      referCode,
      walletPassword,
    );
    const nextAddress = ethers.utils.getAddress(polygonAddress);
    const addressChanged = previousAddress.toLowerCase() !== nextAddress.toLowerCase();

    if (!execute) {
      return {
        userId,
        outcome: 'dry_run',
        referCode,
        previousAddress,
        nextAddress,
        addressChanged,
        previousWalletIndex,
        nextWalletIndex: walletIndex,
        previousScheme: scheme,
        generatedPassword,
      };
    }

    await prisma.$transaction(async (tx) => {
      await (tx as any).user.update({
        where: { id: userId },
        data: {
          encryptedWalletPassword: null,
          walletDeriveMigrationStatus: WALLET_DERIVE_MIGRATION_STATUS.COMPLETED,
        },
      });
      await upsertWalletPassword({ referCode, userId, walletPassword }, tx);

      await (tx as any).apiCredential.deleteMany({ where: { walletId: wallet.id } });

      await (tx as any).wallet.update({
        where: { id: wallet.id },
        data: {
          address: nextAddress,
          walletIndex,
          derivationScheme: 'v3_refer_pass',
          supersededAddress: addressChanged ? previousAddress : (wallet as any).supersededAddress ?? null,
          polymarketFunderAddress: null,
          polymarketSellPrepReadyAt: null,
          polymarketSellPrepDeposit: null,
          polymarketWalletCreateRelayerTxId: null,
        },
      });
    });

    return {
      userId,
      outcome: 'applied',
      referCode,
      previousAddress,
      nextAddress,
      addressChanged,
      previousWalletIndex,
      nextWalletIndex: walletIndex,
      previousScheme: scheme,
      generatedPassword,
    };
  } catch (error) {
    return {
      userId,
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listV2HdCustodialUserIds(): Promise<number[]> {
  const rows = await prisma.wallet.findMany({
    where: { type: 'CUSTODIAL', derivationScheme: 'v2_hd' } as any,
    select: { userId: true },
    orderBy: { userId: 'asc' },
  });
  return rows
    .map((row) => row.userId)
    .filter((userId): userId is number => userId != null);
}
