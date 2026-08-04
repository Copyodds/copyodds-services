/**
 * 将单个用户的 LOCAL_DB 托管钱包链上资金划转到 Go wallet-api 派生的同 refer_code 地址，
 * 并把同一 Wallet 行更新为 GO_REMOTE（地址/walletIndex），清空 UserCustodialKey 私钥列，
 * 删除 ApiCredential 以便重新 POST /api/custody/authorize-polymarket。
 *
 * 若用户已是 GO_REMOTE，但你在 Go 侧更换了 mnemonic/xpub（本地联调常见）：设 MIGRATE_FORCE_RESYNC=1，
 * 会再次调用 createWallet（同 refer_code）并只更新 Prisma 中的 address/walletIndex，不做链上归集。
 *
 * 前置：GO_WALLET_SERVICE_URL / GO_WALLET_APP_KEY / GO_WALLET_APP_TOKEN、RPC_URL、CUSTODY_ENCRYPT_KEY。
 * 演练：  MIGRATE_USER_ID=1 npx tsx scripts/migrate-custodial-to-go.ts
 * 广播：  MIGRATE_USER_ID=1 MIGRATE_EXECUTE=1 npx tsx scripts/migrate-custodial-to-go.ts
 * GO_REMOTE 重绑：MIGRATE_USER_ID=27 MIGRATE_FORCE_RESYNC=1 MIGRATE_EXECUTE=1 npx tsx scripts/migrate-custodial-to-go.ts
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { prisma } from '../src/db';
import { decryptPrivateKey } from './legacy/custodyPrivateKeyLegacy';
import { goCreateWallet, isGoWalletCustodyConfigured } from '../src/services/walletApi/goWalletClient';
import { CONFIG } from '../src/config/env';
import { normalizeInviteCode } from '../src/lib/inviteCode';
import {
  isWalletDerivationEncryptionConfigured,
  upsertWalletPassword,
} from '../src/services/walletApi/walletDerivationCredential';

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = [
  'function transfer(address to, uint256 v) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

async function sweepNative(
  signer: ethers.Wallet,
  dest: string,
  provider: ethers.providers.Provider
): Promise<string | null> {
  const from = await signer.getAddress();
  const bal = await provider.getBalance(from);
  const gasPrice = await provider.getGasPrice();
  const gasLimit = ethers.BigNumber.from(21000);
  const fee = gasPrice.mul(gasLimit);
  const value = bal.sub(fee);
  if (value.lte(0)) {
    console.log('Native MATIC/POL balance too low to sweep after fees; skip native transfer.');
    return null;
  }
  const tx = await signer.sendTransaction({
    to: dest,
    value,
    gasLimit,
    gasPrice,
  });
  console.log('native sweep submitted', tx.hash);
  const rc = await tx.wait(1);
  console.log('native sweep mined', rc?.transactionHash, 'status', rc?.status);
  return tx.hash;
}

async function main() {
  const userId = Number(process.env.MIGRATE_USER_ID ?? '');
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('Set MIGRATE_USER_ID to a positive integer');
  }
  if (!isGoWalletCustodyConfigured()) {
    throw new Error('Go wallet env not fully configured (GO_WALLET_SERVICE_URL, GO_WALLET_APP_KEY, GO_WALLET_APP_TOKEN)');
  }
  if (!isWalletDerivationEncryptionConfigured()) {
    throw new Error('NODE_WALLET_DERIVATION_ENCRYPTION_KEY is required');
  }
  if (!CONFIG.rpcUrl) {
    throw new Error('RPC_URL is required');
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { inviteCode: true },
  });
  const referCode = normalizeInviteCode(user?.inviteCode ?? null);
  if (!referCode) {
    throw new Error(`User ${userId} has no valid inviteCode for wallet refer_code`);
  }
  const walletPassword = process.env.MIGRATE_WALLET_PASSWORD ?? 'MigrateTest99';

  const wallet = await prisma.wallet.findFirst({
    where: { userId, type: 'CUSTODIAL' } as any,
    orderBy: { createdAt: 'asc' },
    include: { custodialKeys: true } as any,
  });
  if (!wallet) {
    throw new Error(`No CUSTODIAL wallet for userId=${userId}`);
  }
  const sp = String((wallet as any).signingProvider ?? 'LOCAL_DB');
  if (sp === 'GO_REMOTE') {
    const forceResync =
      process.env.MIGRATE_FORCE_RESYNC === '1' || process.env.MIGRATE_FORCE_RESYNC === 'true';
    if (!forceResync) {
      console.log(
        'Wallet already GO_REMOTE; nothing to do. If Go mnemonic/xpub changed, set MIGRATE_FORCE_RESYNC=1 (and MIGRATE_EXECUTE=1 to write DB).'
      );
      return;
    }

    const { polygonAddress, walletIndex } = await goCreateWallet(
      referCode,
      walletPassword,
    );
    const dest = ethers.utils.getAddress(polygonAddress);
    const from = ethers.utils.getAddress(wallet.address);
    console.log({
      userId,
      note: 'MIGRATE_FORCE_RESYNC: refresh GO_REMOTE row from Go createWallet (no on-chain sweep)',
      previousAddress: from,
      nextAddress: dest,
      walletIndex,
    });
    if (from.toLowerCase() === dest.toLowerCase()) {
      console.warn(
        '[migrate] Go returned the same address as Prisma. If you changed Go mnemonic/xpub, the wallet DB likely still caches this refer_code — signing will use the NEW seed but the address stays OLD, and Polymarket authorize will fail. Dev fix: reset Go wallet DB / delete rows for this refer_code, then re-run with MIGRATE_EXECUTE=1.'
      );
    }

    const execute = process.env.MIGRATE_EXECUTE === '1' || process.env.MIGRATE_EXECUTE === 'true';
    if (!execute) {
      console.log('Dry run only. Set MIGRATE_EXECUTE=1 to apply DB update + delete ApiCredential.');
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.apiCredential.deleteMany({ where: { walletId: wallet.id } });
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { address: dest, walletIndex, signingProvider: 'GO_REMOTE' },
      });
      await tx.userCustodialKey.updateMany({
        where: { walletId: wallet.id },
        data: { encryptedPrivateKey: null },
      });
      await upsertWalletPassword({ referCode, userId, walletPassword }, tx);
    });
    console.log('DB updated. Re-run POST /api/custody/authorize-polymarket for this user.');
    return;
  }
  const keyRow =
    (wallet as any).custodialKeys?.[0] ??
    (await (prisma as any).userCustodialKey.findFirst({ where: { userId, walletId: wallet.id } }));
  if (!keyRow?.encryptedPrivateKey) {
    throw new Error('Missing encrypted private key for LOCAL_DB wallet');
  }
  const pkHex = decryptPrivateKey(keyRow.encryptedPrivateKey as string);
  const pk = pkHex.startsWith('0x') ? pkHex : `0x${pkHex}`;

  const { polygonAddress, walletIndex } = await goCreateWallet(
    referCode,
    walletPassword,
  );
  const dest = ethers.utils.getAddress(polygonAddress);
  const from = ethers.utils.getAddress(wallet.address);
  if (from.toLowerCase() === dest.toLowerCase()) {
    console.log('Local address already matches Go-derived address; applying DB GO_REMOTE update only.');
    const execute = process.env.MIGRATE_EXECUTE === '1' || process.env.MIGRATE_EXECUTE === 'true';
    if (!execute) {
      console.log('Dry run: would set signingProvider=GO_REMOTE, walletIndex, clear encryptedPrivateKey, delete ApiCredential.');
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.apiCredential.deleteMany({ where: { walletId: wallet.id } });
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { address: dest, walletIndex, signingProvider: 'GO_REMOTE' },
      });
      await tx.userCustodialKey.updateMany({
        where: { walletId: wallet.id },
        data: { encryptedPrivateKey: null },
      });
      await upsertWalletPassword({ referCode, userId, walletPassword }, tx);
    });
    console.log('DB updated. Re-run POST /api/custody/authorize-polymarket for this user.');
    return;
  }

  const provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl, {
    chainId: CONFIG.chainId || 137,
    name: 'polygon',
  });
  const signer = new ethers.Wallet(pk, provider);
  const usdc = new ethers.Contract(USDC_E, ERC20_ABI, signer);
  const usdcBal: ethers.BigNumber = await usdc.balanceOf(from);
  const nativeBal = await provider.getBalance(from);
  console.log({
    userId,
    from,
    dest,
    walletIndex,
    usdcBalance: usdcBal.toString(),
    nativeWei: nativeBal.toString(),
  });

  const execute = process.env.MIGRATE_EXECUTE === '1' || process.env.MIGRATE_EXECUTE === 'true';
  if (!execute) {
    console.log('Dry run only. Set MIGRATE_EXECUTE=1 to broadcast transfers + update DB.');
    return;
  }

  if (!usdcBal.isZero()) {
    const tx = await usdc.transfer(dest, usdcBal);
    console.log('USDC transfer submitted', tx.hash);
    const rc = await tx.wait(1);
    console.log('USDC mined', rc?.transactionHash, 'status', rc?.status);
  } else {
    console.log('USDC balance zero; skip USDC transfer.');
  }

  await sweepNative(signer, dest, provider);

  await prisma.$transaction(async (tx) => {
    await tx.apiCredential.deleteMany({ where: { walletId: wallet.id } });
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { address: dest, walletIndex, signingProvider: 'GO_REMOTE' },
    });
    await tx.userCustodialKey.updateMany({
      where: { walletId: wallet.id },
      data: { encryptedPrivateKey: null },
    });
    await upsertWalletPassword({ referCode, userId, walletPassword }, tx);
  });
  console.log('DB updated to GO_REMOTE. User must POST /api/custody/authorize-polymarket (or open flow).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
