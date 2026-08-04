import { formatUnits } from 'viem';
import { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { getExecutionWalletForUser } from '../../services/polymarket/automationSession';
import { getUsdcBalance, getPusdBalance } from '../../services/polymarket/web3';
import { ethers } from 'ethers';
import {
  evaluateBuyCollateralPrecheck,
  type CopyOrderFundingPrecheckResult,
} from './copyOrderFundingPrecheckLogic';
import { COPY_GAS_INSUFFICIENT_ERROR_CODE } from './copyFundingMonitor';

export type { CopyOrderFundingPrecheckResult } from './copyOrderFundingPrecheckLogic';
export { evaluateBuyCollateralPrecheck, requiredUsdWithBuffer } from './copyOrderFundingPrecheckLogic';

type DepositCollateralCacheEntry = {
  at: number;
  depositAddress: string | null;
  usd: number;
};

const depositCollateralCache = new Map<number, DepositCollateralCacheEntry>();

function fundingCacheTtlMs(): number {
  return CONFIG.copyPositionsCacheMs > 0 ? CONFIG.copyPositionsCacheMs : 30_000;
}

async function getDepositCollateralUsdCached(userId: number): Promise<DepositCollateralCacheEntry> {
  const ttl = fundingCacheTtlMs();
  const hit = depositCollateralCache.get(userId);
  if (hit && ttl > 0 && Date.now() - hit.at < ttl) {
    return hit;
  }

  const ctx = await getExecutionWalletForUser(userId);
  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  if (!deposit || deposit.toLowerCase() === ctx.address.toLowerCase()) {
    const entry: DepositCollateralCacheEntry = {
      at: Date.now(),
      depositAddress: null,
      usd: 0,
    };
    depositCollateralCache.set(userId, entry);
    return entry;
  }

  const depAddr = ethers.utils.getAddress(deposit) as `0x${string}`;
  const [usdcE, pUsd] = await Promise.all([getUsdcBalance(depAddr), getPusdBalance(depAddr)]);
  const totalRaw = usdcE.raw + pUsd.raw;
  const entry: DepositCollateralCacheEntry = {
    at: Date.now(),
    depositAddress: deposit,
    usd: Number(formatUnits(totalRaw, 6)),
  };
  depositCollateralCache.set(userId, entry);
  return entry;
}

/** dispatch 热路径：买单在链上抵押明显不足时提前 skipped，避免无意义打 CLOB */
export async function evaluateCopyOrderFundingPrecheck(params: {
  userId: number;
  side: 'BUY' | 'SELL';
  requiredUsd: number;
}): Promise<CopyOrderFundingPrecheckResult> {
  const { userId, side, requiredUsd } = params;

  if (side === 'SELL') {
    return { ok: true };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { gasBalance: true },
  });
  const gasBal =
    user?.gasBalance instanceof Prisma.Decimal
      ? user.gasBalance
      : new Prisma.Decimal(user?.gasBalance ?? 0);
  if (!gasBal.gt(0)) {
    return {
      ok: false,
      errorCode: COPY_GAS_INSUFFICIENT_ERROR_CODE,
      errorMsg: '平台 Gas 不足，买单已跳过；有持仓时仍可跟卖，请充值 Gas 后恢复买入。',
    };
  }

  const collateral = await getDepositCollateralUsdCached(userId);
  return evaluateBuyCollateralPrecheck({
    depositUsd: collateral.usd,
    hasDeposit: collateral.depositAddress != null,
    requiredUsd,
  });
}

export function invalidateCopyFundingPrecheckCache(userId: number): void {
  depositCollateralCache.delete(userId);
}
