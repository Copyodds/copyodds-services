import { prisma } from '../../db';
import { decryptWalletPassword } from './walletPasswordCrypto';

/** 新注册用户 v3 钱包秘密已生成就视为 ready；v2_hd 存量用户无需迁移。 */
export const WALLET_DERIVE_MIGRATION_STATUS = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
} as const;

const LEGACY_V2_SCHEME = 'v2_hd';

export async function hasLegacyV2CustodialWallet(userId: number): Promise<boolean> {
  const row = await prisma.wallet.findFirst({
    where: { userId, type: 'CUSTODIAL', derivationScheme: LEGACY_V2_SCHEME } as any,
    select: { id: true },
  });
  return row != null;
}

export async function decryptUserWalletPassword(userId: number): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { encryptedWalletPassword: true },
  });
  if (!user?.encryptedWalletPassword) {
    throw new Error(`User ${userId} has no encrypted wallet password`);
  }
  return decryptWalletPassword(user.encryptedWalletPassword);
}
