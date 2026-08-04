/**
 * 用户侧 Polymarket Bridge 充值：为 deposit wallet 获取官方桥接地址并查询状态。
 */
import { ethers } from 'ethers';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { getCustodialWalletForUser } from '../custody/custody';
import { syncCustodialPolymarketDepositFunderIfEmpty } from './polymarketAuth';
import { createConflictError } from '../../utils/appError';
import {
  createPolymarketBridgeDepositAddresses,
  getPolymarketBridgeDepositStatus,
  getPolymarketBridgeSupportedAssets,
  POLYMARKET_BRIDGE_DEPOSIT_GUIDANCE,
  type PolymarketBridgeCreateDepositResult,
  type PolymarketBridgeDepositAddresses,
  type PolymarketBridgeTransaction,
} from './polymarketBridgeClient';

export type PolymarketBridgeDepositInfo = {
  enabled: boolean;
  polymarketWalletAddress: string;
  custodialAddress: string;
  addresses: PolymarketBridgeDepositAddresses;
  note?: string;
  guidance: typeof POLYMARKET_BRIDGE_DEPOSIT_GUIDANCE & {
    directDepositAddress: string;
  };
};

const BRIDGE_ADDRESS_CACHE_TTL_MS = 24 * 60 * 60_000;
const bridgeAddressCache = new Map<
  string,
  { expiresAt: number; data: PolymarketBridgeCreateDepositResult }
>();

export function isPolymarketBridgeDepositEnabled(): boolean {
  return CONFIG.polymarketBridgeDepositEnabled;
}

async function resolveUserDepositWallet(userId: number): Promise<{
  custodialAddress: string;
  depositAddress: string;
  walletId: number;
}> {
  const bundle = await getCustodialWalletForUser(userId);
  if (!bundle.walletId) {
    throw createConflictError('Custodial wallet id missing');
  }
  let depositRaw = (bundle.polymarketFunderAddress ?? '').trim();
  if (!depositRaw) {
    await syncCustodialPolymarketDepositFunderIfEmpty({
      userId,
      walletId: bundle.walletId,
      ownerAddress: bundle.address,
    });
    const w = await prisma.wallet.findUnique({
      where: { id: bundle.walletId },
      select: { polymarketFunderAddress: true },
    });
    depositRaw = (w?.polymarketFunderAddress ?? '').trim();
  }
  if (!depositRaw) {
    throw createConflictError('未配置 Polymarket deposit 地址，请先完成托管开通与 Polymarket 授权', {
      hint: 'POST /api/custody/open 或 /api/custody/authorize-polymarket',
      reasonCode: 'NO_POLYMARKET_DEPOSIT_WALLET',
    });
  }
  const custodial = ethers.utils.getAddress(bundle.address);
  const deposit = ethers.utils.getAddress(depositRaw);
  if (deposit.toLowerCase() === custodial.toLowerCase()) {
    throw createConflictError('Polymarket deposit 地址与托管地址相同，无法使用 Bridge 充值', {
      reasonCode: 'DEPOSIT_MATCHES_CUSTODIAL',
    });
  }
  return { custodialAddress: custodial, depositAddress: deposit, walletId: bundle.walletId };
}

async function fetchBridgeAddressesCached(
  depositAddress: string,
): Promise<PolymarketBridgeCreateDepositResult> {
  const key = depositAddress.toLowerCase();
  const cached = bridgeAddressCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const data = await createPolymarketBridgeDepositAddresses(depositAddress);
  bridgeAddressCache.set(key, { data, expiresAt: Date.now() + BRIDGE_ADDRESS_CACHE_TTL_MS });
  return data;
}

export async function getPolymarketBridgeDepositInfoForUser(
  userId: number,
  options?: { refresh?: boolean },
): Promise<PolymarketBridgeDepositInfo> {
  if (!isPolymarketBridgeDepositEnabled()) {
    throw createConflictError('Polymarket Bridge 充值未启用', {
      reasonCode: 'POLYMARKET_BRIDGE_DISABLED',
    });
  }
  const { custodialAddress, depositAddress } = await resolveUserDepositWallet(userId);
  if (options?.refresh) {
    bridgeAddressCache.delete(depositAddress.toLowerCase());
  }
  const { addresses, note } = await fetchBridgeAddressesCached(depositAddress);
  return {
    enabled: true,
    polymarketWalletAddress: depositAddress,
    custodialAddress,
    addresses,
    note,
    guidance: {
      ...POLYMARKET_BRIDGE_DEPOSIT_GUIDANCE,
      directDepositAddress: depositAddress,
    },
  };
}

export type PolymarketBridgeDepositStatusForUser = {
  polymarketWalletAddress: string;
  bridgeAddress: string;
  bridgeAddressType: 'evm' | 'svm' | 'btc' | 'tvm';
  transactions: PolymarketBridgeTransaction[];
};

export async function getPolymarketBridgeDepositStatusForUser(
  userId: number,
  bridgeAddressType: 'evm' | 'svm' | 'btc' | 'tvm' = 'evm',
): Promise<PolymarketBridgeDepositStatusForUser> {
  if (!isPolymarketBridgeDepositEnabled()) {
    throw createConflictError('Polymarket Bridge 充值未启用', {
      reasonCode: 'POLYMARKET_BRIDGE_DISABLED',
    });
  }
  const info = await getPolymarketBridgeDepositInfoForUser(userId);
  const bridgeAddress = info.addresses[bridgeAddressType]?.trim();
  if (!bridgeAddress) {
    throw createConflictError(`该用户无 ${bridgeAddressType} 桥接地址`, {
      reasonCode: 'POLYMARKET_BRIDGE_ADDRESS_MISSING',
      bridgeAddressType,
    });
  }
  const { transactions } = await getPolymarketBridgeDepositStatus(bridgeAddress);
  return {
    polymarketWalletAddress: info.polymarketWalletAddress,
    bridgeAddress,
    bridgeAddressType,
    transactions,
  };
}

export async function getPolymarketBridgeSupportedAssetsCached(): Promise<{
  assets: Awaited<ReturnType<typeof getPolymarketBridgeSupportedAssets>>['assets'];
  cachedAt: number;
}> {
  const now = Date.now();
  const ttl = CONFIG.polymarketBridgeSupportedAssetsCacheMs;
  if (
    supportedAssetsCache &&
    supportedAssetsCache.expiresAt > now
  ) {
    return { assets: supportedAssetsCache.assets, cachedAt: supportedAssetsCache.cachedAt };
  }
  const { assets } = await getPolymarketBridgeSupportedAssets();
  supportedAssetsCache = { assets, expiresAt: now + ttl, cachedAt: now };
  return { assets, cachedAt: now };
}

let supportedAssetsCache: {
  assets: Awaited<ReturnType<typeof getPolymarketBridgeSupportedAssets>>['assets'];
  expiresAt: number;
  cachedAt: number;
} | null = null;
