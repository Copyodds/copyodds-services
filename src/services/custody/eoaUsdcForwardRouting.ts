/**
 * Custodial EOA 自动归集路由：
 * - USDC.e → Polymarket deposit wallet（再 Onramp wrap pUSD）
 * - 原生 USDC / USDT / USDT0 → Polymarket Bridge evm 地址（官方桥接 → pUSD 进 deposit）
 */
import { getAddress } from 'viem';
import { CONFIG } from '../../config/env';
import { createConflictError } from '../../utils/appError';
import { getPolymarketBridgeDepositInfoForUser } from '../polymarket/polymarketBridgeDepositService';
import { getCustodialWalletForUser } from './custody';
import { syncCustodialPolymarketDepositFunderIfEmpty } from '../polymarket/polymarketAuth';
import { prisma } from '../../db';
import type { FundPolymarketDepositSource, UsdcTokenVariant } from './fundPolymarketDepositService';

export type EoaUsdcForwardDestination = 'deposit' | 'bridge_evm';

export type EoaUsdcForwardRoute = {
  destination: EoaUsdcForwardDestination;
  transferTo: `0x${string}`;
  depositAddress: `0x${string}`;
  bridgeEvmAddress?: string;
};

async function resolveDepositAddress(userId: number): Promise<`0x${string}`> {
  const bundle = await getCustodialWalletForUser(userId);
  const wid = bundle.walletId;
  if (wid == null) {
    throw createConflictError('Custodial wallet id missing');
  }
  let depositRaw = (bundle.polymarketFunderAddress ?? '').trim();
  if (!depositRaw) {
    await syncCustodialPolymarketDepositFunderIfEmpty({
      userId,
      walletId: wid,
      ownerAddress: bundle.address,
    });
    const w = await prisma.wallet.findUnique({
      where: { id: wid },
      select: { polymarketFunderAddress: true },
    });
    depositRaw = (w?.polymarketFunderAddress ?? '').trim();
  }
  if (!depositRaw) {
    throw createConflictError('未配置 Polymarket deposit 地址，请先完成托管开通与 Polymarket 授权', {
      hint: 'POST /api/custody/open 或 /api/custody/authorize-polymarket',
    });
  }
  return getAddress(depositRaw) as `0x${string}`;
}

/** 原生 USDC / USDT 经 Bridge 入账 pUSD 的开关（同一配置）。 */
export function shouldRouteNativeUsdcEoaToBridge(_fundSource?: FundPolymarketDepositSource): boolean {
  return CONFIG.polymarketBridgeDepositEnabled && CONFIG.polymarketBridgeEoaNativeForward;
}

function isBridgeStablecoinToken(token: UsdcTokenVariant): boolean {
  return token === 'native' || token === 'usdt' || token === 'usdt0';
}

export async function resolveEoaUsdcForwardRoute(
  userId: number,
  token: UsdcTokenVariant,
  fundSource: FundPolymarketDepositSource = 'manual_api',
): Promise<EoaUsdcForwardRoute> {
  const depositAddress = await resolveDepositAddress(userId);

  if (token === 'usdce') {
    return { destination: 'deposit', transferTo: depositAddress, depositAddress };
  }

  if (!isBridgeStablecoinToken(token)) {
    throw createConflictError(`不支持的 EOA 归集代币: ${token}`, {
      reasonCode: 'UNSUPPORTED_EOA_FORWARD_TOKEN',
    });
  }

  if (!shouldRouteNativeUsdcEoaToBridge(fundSource)) {
    const label =
      token === 'usdt0' ? 'USDT0' : token === 'usdt' ? 'USDT' : '原生 USDC';
    throw createConflictError(
      `${label} 仅支持 Polymarket Bridge 入账，请开启 POLYMARKET_BRIDGE_DEPOSIT_ENABLED 或充值 USDC.e`,
      { reasonCode: 'NATIVE_USDC_BRIDGE_REQUIRED', token },
    );
  }

  const info = await getPolymarketBridgeDepositInfoForUser(userId);
  const bridgeEvm = info.addresses.evm?.trim();
  if (!bridgeEvm) {
    throw createConflictError('Polymarket Bridge 未返回 EVM 桥接地址', {
      reasonCode: 'POLYMARKET_BRIDGE_EVM_MISSING',
    });
  }
  return {
    destination: 'bridge_evm',
    transferTo: getAddress(bridgeEvm) as `0x${string}`,
    depositAddress,
    bridgeEvmAddress: getAddress(bridgeEvm),
  };
}
