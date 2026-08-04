import { Prisma } from '../../generated/prisma/client';
import { ethers } from 'ethers';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from './userWalletLedger';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { normalizeInviteCode } from '../../lib/inviteCode';
import { goCreateWallet, isGoWalletCustodyConfigured } from '../walletApi/goWalletClient';
import { GoRemoteEthersSigner } from '../walletApi/goRemoteEthersSigner';
import { createGoWalletViemAccount } from '../walletApi/goWalletViemAccount';
import { maskWalletAddress, recordAdminActivity } from '../adminDashboard/adminActivityLog.js';
import { generateWalletPassword } from './walletPasswordCrypto';
import {
  isWalletDerivationEncryptionConfigured,
  loadWalletPassword,
  upsertWalletPassword,
} from '../walletApi/walletDerivationCredential';
import type { GoWithdrawalAuthorization } from '../walletApi/goWalletClient';

const chain = { ...polygon, id: CONFIG.chainId || polygon.id };
const transport = http(CONFIG.rpcUrl || polygon.rpcUrls.default.http[0]);

async function goReferCodeForUser(userId: number): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { inviteCode: true },
  });
  const code = normalizeInviteCode(user?.inviteCode ?? null);
  if (!code) {
    throw new Error(`User ${userId} has no valid invite code for wallet refer_code`);
  }
  return code;
}

function ethersJsonRpcProvider(): ethers.providers.JsonRpcProvider {
  if (!CONFIG.rpcUrl) {
    throw new Error('RPC_URL is required for Go-remote custodial signing');
  }
  return new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl, {
    chainId: CONFIG.chainId || 137,
    name: 'polygon',
  });
}

export type CustodialWalletBundle = {
  account: any;
  signer: GoRemoteEthersSigner;
  walletClient: ReturnType<typeof createWalletClient>;
  address: string;
  walletId?: number;
  signingProvider?: string;
  walletIndex?: number | null;
  referCode?: string;
  walletPassword?: string;
  /** Polymarket CLOB funder（如 deposit wallet）；见 Wallet.polymarketFunderAddress */
  polymarketFunderAddress?: string | null;
};

function normalizeHexAddress(value: string): `0x${string}` {
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error('CUSTODY_TREASURY_ADDRESS is invalid');
  }
  return trimmed as `0x${string}`;
}

export function getCustodyTreasuryAddress(): `0x${string}` {
  const configured = (CONFIG.custodyTreasuryAddress ?? '').trim();
  if (!configured) {
    throw new Error(
      'CUSTODY_TREASURY_ADDRESS is not configured. Set env CUSTODY_TREASURY_ADDRESS to your Polygon treasury address (0x + 40 hex).'
    );
  }
  return normalizeHexAddress(configured);
}

/**
 * Gas 套餐收款、佣金领取打款源等使用：`CUSTODY_TREASURY_ADDRESS`。
 * 必须与 Go wallet `security.treasury_address`（mnemonicWithdraw 派生地址）一致。
 * 保持 async 以便调用方无需改动。
 */
export async function resolveCustodyTreasuryAddress(): Promise<`0x${string}`> {
  return getCustodyTreasuryAddress();
}

export async function createCustodialWalletForUser(userId: number) {
  if (!isGoWalletCustodyConfigured()) {
    throw new Error(
      'Custodial wallets require Go wallet-api: set GO_WALLET_SERVICE_URL, GO_WALLET_APP_KEY, and GO_WALLET_APP_TOKEN.'
    );
  }
  if (!isWalletDerivationEncryptionConfigured()) {
    throw new Error(
      'Custodial wallets require NODE_WALLET_DERIVATION_ENCRYPTION_KEY (32-byte hex/base64).',
    );
  }
  const existingCustodial = await prisma.wallet.findFirst({
    where: { userId, type: 'CUSTODIAL' } as any,
    select: { id: true },
  });
  if (existingCustodial) {
    throw new Error('Custodial wallet already exists for this user.');
  }
  const referCode = await goReferCodeForUser(userId);
  // Persist plaintext wallet_password by referCode; signing sends it back to Go.
  const walletPassword = generateWalletPassword(referCode);
  const { polygonAddress, walletIndex } = await goCreateWallet(referCode, walletPassword);
  const checksummed = ethers.utils.getAddress(polygonAddress);
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.create({
      data: {
        address: checksummed,
        userId,
        type: 'CUSTODIAL',
        walletIndex,
        signingProvider: 'GO_REMOTE',
        derivationScheme: 'v3_refer_pass',
      } as any,
    });
    const key = await (tx as any).userCustodialKey.create({
      data: {
        userId,
        walletId: wallet.id,
        encryptedPrivateKey: null,
      },
    });
    await upsertWalletPassword({ referCode, userId, walletPassword }, tx);
    const result = { wallet, key };
    recordAdminActivity({
      eventType: 'wallet.linked',
      title: 'New Wallet Linked',
      level: 'info',
      actorType: 'user',
      actorId: String(userId),
      targetType: 'Wallet',
      targetId: String(wallet.id),
      content: maskWalletAddress(checksummed),
    });
    return result;
  });
}

/** 生成新的托管钱包（Go 派生）；无私钥返回，签名一律走 Go wallet-api */
export async function generateWalletForUser(userId: number) {
  const { wallet } = await createCustodialWalletForUser(userId);
  return {
    address: (wallet as any).address as string,
    privateKey: null as string | null,
    created: true,
  };
}

async function loadCustodialWalletBundle(
  userId: number,
  expectedAddress?: string,
  options?: {
    withdrawalAuthorization?: GoWithdrawalAuthorization;
  },
): Promise<CustodialWalletBundle> {
  type WalletRow = {
    id: number;
    address: string;
    createdAt: Date;
    walletIndex: number | null;
    signingProvider: string | null;
    polymarketFunderAddress: string | null;
    derivationScheme: string | null;
  };
  const wallets = (await prisma.wallet.findMany({
    where: { userId, type: 'CUSTODIAL' } as any,
    select: {
      id: true,
      address: true,
      createdAt: true,
      walletIndex: true,
      signingProvider: true,
      polymarketFunderAddress: true,
      derivationScheme: true,
    } as any,
    orderBy: { createdAt: 'asc' },
  })) as unknown as WalletRow[];
  const loweredExpected = expectedAddress?.trim().toLowerCase();
  let selected: WalletRow | undefined;
  if (!loweredExpected) {
    // 默认选「已配置 Polymarket deposit」的托管钱包（与站内 USDC 入金一致）；否则最早一张。
    selected =
      wallets.find((w) => (w.polymarketFunderAddress ?? '').trim().length > 0) ?? wallets[0];
  } else {
    // 产品约定：address 优先为 Polymarket deposit（funder）；兼容传托管执行地址。
    selected =
      wallets.find((w) => (w.polymarketFunderAddress ?? '').trim().toLowerCase() === loweredExpected) ??
      wallets.find((w) => w.address.toLowerCase() === loweredExpected);
  }
  if (!selected) {
    throw new Error(
      expectedAddress
        ? 'Signed address is not the configured custodial trading wallet.'
        : 'Custodial wallet not found for user'
    );
  }

  const record = (await (prisma as any).userCustodialKey.findFirst({
    where: { userId, walletId: selected.id },
  })) as { encryptedPrivateKey: string | null } | null;
  if (!record) {
    throw new Error('Custodial wallet not found for user');
  }

  const sp = String((selected as any).signingProvider ?? 'GO_REMOTE');
  const wIdx = (selected as any).walletIndex as number | null | undefined;

  if (sp !== 'GO_REMOTE') {
    throw new Error(
      'Legacy LOCAL_DB custodial wallets are no longer supported. Migrate this wallet to Go custody (see scripts/migrate-custodial-to-go.ts) or recreate the user wallet.'
    );
  }
  if (wIdx == null || !Number.isFinite(Number(wIdx))) {
    throw new Error('GO_REMOTE custodial wallet is missing walletIndex');
  }
  if (!isGoWalletCustodyConfigured()) {
    throw new Error(
      'GO_REMOTE custodial wallet requires GO_WALLET_SERVICE_URL, GO_WALLET_APP_KEY, and GO_WALLET_APP_TOKEN'
    );
  }
  const referCode = await goReferCodeForUser(userId);
  const walletPassword = await loadWalletPassword(referCode);
  const addr = ethers.utils.getAddress(selected.address);
  const rpcProvider = ethersJsonRpcProvider();
  const signer = new GoRemoteEthersSigner(
    referCode,
    Number(wIdx),
    walletPassword,
    addr,
    rpcProvider,
  );
  const account = createGoWalletViemAccount({
    referCode,
    walletIndex: Number(wIdx),
    walletPassword,
    address: addr as `0x${string}`,
    withdrawalAuthorization: options?.withdrawalAuthorization,
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport,
  });
  return {
    account,
    signer,
    walletClient,
    address: addr,
    walletId: selected.id,
    signingProvider: sp,
    walletIndex: wIdx,
    referCode,
    walletPassword,
    polymarketFunderAddress: selected.polymarketFunderAddress ?? null,
  };
}

export async function getCustodialWalletForUser(userId: number): Promise<CustodialWalletBundle> {
  return loadCustodialWalletBundle(userId);
}

/**
 * CLOB / 链上执行钱包：服务端生成的 CUSTODIAL 地址（与 POST /api/custody/open 同源）。
 * 不再支持用户导入 USER_EOA 私钥。
 */
export async function getCustodialExecutionWallet(
  userId: number,
  expectedAddress?: string,
  options?: {
    withdrawalAuthorization?: GoWithdrawalAuthorization;
  },
) {
  const wallets = await prisma.wallet.findMany({
    where: { userId, type: 'CUSTODIAL' } as any,
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!wallets.length) {
    throw new Error(
      'No custodial wallet yet. Open a custodial wallet first (POST /api/custody/open), then fund it on-chain for Polymarket trading.'
    );
  }
  const bundle = await loadCustodialWalletBundle(userId, expectedAddress, options);
  return {
    account: bundle.account,
    signer: bundle.signer,
    walletClient: bundle.walletClient,
    address: bundle.address,
    walletId: bundle.walletId as number,
    signingProvider: bundle.signingProvider,
    walletIndex: bundle.walletIndex,
    referCode: bundle.referCode,
    walletPassword: bundle.walletPassword,
    polymarketFunderAddress: bundle.polymarketFunderAddress ?? null,
  };
}

export async function getOrCreateUserAsset(userId: number, symbol: string) {
  return (prisma as any).userAsset.upsert({
    where: { userId_symbol: { userId, symbol } },
    create: {
      userId,
      symbol,
      available: new Prisma.Decimal(0),
      locked: new Prisma.Decimal(0),
    },
    update: {},
  });
}

export const CUSTODY_USDC_SYMBOL = 'USDC.e';

/** 最早一条 CUSTODIAL 地址（与执行钱包/open 语义一致）；无则 null */
export async function getCustodialWalletAddressForUser(userId: number): Promise<string | null> {
  const info = await getCustodialWalletPublicInfo(userId);
  return info?.address ?? null;
}

/**
 * Read-only custodial wallet metadata for UI / status APIs.
 * Does not load wallet_password or build a remote signer.
 */
export async function getCustodialWalletPublicInfo(userId: number): Promise<{
  address: string;
  signingProvider: string;
  walletIndex: number | null;
  polymarketFunderAddress: string | null;
} | null> {
  const wallets = await prisma.wallet.findMany({
    where: { userId, type: 'CUSTODIAL' } as any,
    orderBy: { createdAt: 'asc' },
    select: {
      address: true,
      signingProvider: true,
      walletIndex: true,
      polymarketFunderAddress: true,
    },
  });
  const selected =
    wallets.find((w) => (w.polymarketFunderAddress ?? '').trim().length > 0) ?? wallets[0];
  if (!selected) return null;
  return {
    address: ethers.utils.getAddress(selected.address),
    signingProvider: String(selected.signingProvider ?? 'GO_REMOTE'),
    walletIndex: selected.walletIndex ?? null,
    polymarketFunderAddress: selected.polymarketFunderAddress ?? null,
  };
}

/**
 * 用户 Polymarket 入金（deposit / CLOB funder）地址；与钱包页充值 USDC 目标一致。
 * 未开通托管、未完成 Polymarket 授权或未回填 funder 时返回 null。
 */
export async function getPolymarketFunderAddressForUser(userId: number): Promise<string | null> {
  const w = await prisma.wallet.findFirst({
    where: { userId, type: 'CUSTODIAL' } as any,
    orderBy: { createdAt: 'asc' },
    select: { polymarketFunderAddress: true },
  });
  const raw = (w?.polymarketFunderAddress ?? '').trim();
  if (!raw || !/^0x[a-fA-F0-9]{40}$/i.test(raw)) {
    return null;
  }
  try {
    return ethers.utils.getAddress(raw);
  } catch {
    return null;
  }
}

/** 与 GET /api/custody/balance 一致：用户全部托管资产行 */
export async function listUserCustodyAssets(userId: number) {
  return (prisma as any).userAsset.findMany({
    where: { userId },
  });
}

export async function getOrCreateUserAssetInTx(
  tx: Prisma.TransactionClient,
  userId: number,
  symbol: string
) {
  return (tx as any).userAsset.upsert({
    where: { userId_symbol: { userId, symbol } },
    create: {
      userId,
      symbol,
      available: new Prisma.Decimal(0),
      locked: new Prisma.Decimal(0),
    },
    update: {},
  });
}

export async function adjustUserAssetAvailableInTx(
  tx: Prisma.TransactionClient,
  userId: number,
  symbol: string,
  delta: Prisma.Decimal | number | string
) {
  const asset = await getOrCreateUserAssetInTx(tx, userId, symbol);
  const d = new Prisma.Decimal(delta);
  const next = (asset.available as Prisma.Decimal).plus(d);
  if (next.isNeg()) {
    throw new Error('Insufficient asset balance');
  }
  return (tx as any).userAsset.update({
    where: { id: asset.id },
    data: {
      available: next,
    },
  });
}

export async function adjustUserAssetAvailable(userId: number, symbol: string, delta: Prisma.Decimal | number | string) {
  const asset = await getOrCreateUserAsset(userId, symbol);
  const d = new Prisma.Decimal(delta);
  const next = (asset.available as Prisma.Decimal).plus(d);
  if (next.isNeg()) {
    throw new Error('Insufficient asset balance');
  }
  return (prisma as any).userAsset.update({
    where: { id: asset.id },
    data: {
      available: next,
    },
  });
}

/** 跟单冻结/解冻写入 UserWalletLedger 时使用同一 correlationId 配对 */
export type CustodyFollowLedgerContext = {
  correlationId: string;
  metadata?: Prisma.InputJsonValue;
};

export async function reserveUserAssetForOrder(
  userId: number,
  symbol: string,
  amount: Prisma.Decimal | number | string,
  followLedger?: CustodyFollowLedgerContext,
) {
  const d = new Prisma.Decimal(amount);
  return prisma.$transaction(async (tx) => {
    const asset = await (tx as any).userAsset.findUnique({
      where: { userId_symbol: { userId, symbol } },
    });
    if (!asset) {
      throw new Error('Asset not found');
    }
    const available = (asset.available as Prisma.Decimal) as Prisma.Decimal;
    if (available.lt(d)) {
      throw new Error('Insufficient asset balance');
    }
    const updated = await (tx as any).userAsset.update({
      where: { id: asset.id },
      data: {
        available: available.minus(d),
        locked: (asset.locked as Prisma.Decimal).plus(d),
      },
    });
    if (followLedger) {
      await appendUserWalletLedger(
        {
          userId,
          rail: WALLET_LEDGER_RAIL.INTERNAL_USDC_E,
          direction: WALLET_LEDGER_DIRECTION.LOCK,
          amount: d,
          symbol,
          category: WALLET_LEDGER_CATEGORY.COPY_RESERVE,
          refType: 'FOLLOW_ENGINE',
          refId: followLedger.correlationId,
          idempotencyKey: `wallet-copy-lock-${followLedger.correlationId}`,
          balanceAfter: (updated.available as Prisma.Decimal),
          metadata: followLedger.metadata,
        },
        tx,
      );
    }
    return updated;
  });
}

export async function releaseUserAssetFromOrder(
  userId: number,
  symbol: string,
  amount: Prisma.Decimal | number | string,
  followLedger?: CustodyFollowLedgerContext,
) {
  const d = new Prisma.Decimal(amount);
  return prisma.$transaction(async (tx) => {
    const asset = await (tx as any).userAsset.findUnique({
      where: { userId_symbol: { userId, symbol } },
    });
    if (!asset) {
      throw new Error('Asset not found');
    }
    const locked = (asset.locked as Prisma.Decimal) as Prisma.Decimal;
    if (locked.lt(d)) {
      throw new Error('Locked asset is not enough to release');
    }
    const updated = await (tx as any).userAsset.update({
      where: { id: asset.id },
      data: {
        available: (asset.available as Prisma.Decimal).plus(d),
        locked: locked.minus(d),
      },
    });
    if (followLedger) {
      await appendUserWalletLedger(
        {
          userId,
          rail: WALLET_LEDGER_RAIL.INTERNAL_USDC_E,
          direction: WALLET_LEDGER_DIRECTION.UNLOCK,
          amount: d,
          symbol,
          category: WALLET_LEDGER_CATEGORY.COPY_RELEASE,
          refType: 'FOLLOW_ENGINE',
          refId: followLedger.correlationId,
          idempotencyKey: `wallet-copy-unlock-${followLedger.correlationId}`,
          balanceAfter: (updated.available as Prisma.Decimal),
          metadata: followLedger.metadata,
        },
        tx,
      );
    }
    return updated;
  });
}

