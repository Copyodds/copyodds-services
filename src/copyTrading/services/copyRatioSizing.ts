import {
  getCachedDepositCollateralUsd,
  persistDepositBalanceCache,
} from '../../services/custody/userBalanceCache.js';
import {
  getPolymarketDepositUsdcBalance,
  invalidatePolymarketDepositUsdcBalanceCache,
} from '../../services/polymarket/polymarketDepositWithdraw.js';
import { invalidateCopyFundingPrecheckCache } from './copyOrderFundingPrecheck.js';

/** RATIO BUY: size = (availableUsd × copyRatio) / price */
export function computeRatioBuySize(params: {
  availableUsd: number;
  copyRatio: number;
  price: number;
}): number {
  const { availableUsd, copyRatio, price } = params;
  if (!(availableUsd > 0) || !(copyRatio > 0) || !(price > 0)) return 0;
  const notionalUsd = availableUsd * copyRatio;
  if (!(notionalUsd > 0)) return 0;
  return Math.max(0, notionalUsd / price);
}

/**
 * Force on-chain deposit collateral read and persist UserBalanceCache.
 * Best-effort: returns 0 when wallet/deposit is unavailable.
 */
export async function refreshDepositBalanceCacheFromChain(userId: number): Promise<number> {
  invalidatePolymarketDepositUsdcBalanceCache(userId);
  invalidateCopyFundingPrecheckCache(userId);
  try {
    const bal = await getPolymarketDepositUsdcBalance(userId, { readOnly: true });
    if (!bal) return 0;
    try {
      await persistDepositBalanceCache(userId, {
        usdcEFormatted: bal.usdcE.formatted,
        nativeUsdcFormatted: bal.nativeUsdc?.formatted,
        pUsdFormatted: bal.pUsd.formatted,
      });
    } catch (err) {
      console.warn('[copy-ratio-sizing] persist deposit cache after chain refresh failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const usdc = Number(bal.usdcE.formatted) + Number(bal.nativeUsdc?.formatted ?? 0);
    const pusd = Number(bal.pUsd.formatted);
    const total = (Number.isFinite(usdc) ? usdc : 0) + (Number.isFinite(pusd) ? pusd : 0);
    return total > 0 ? total : 0;
  } catch (err) {
    console.warn('[copy-ratio-sizing] on-chain deposit refresh failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Prefer UserBalanceCache; only hit chain when cache is missing or ≤ 0.
 */
export async function resolveAvailableUsdcForRatioBuy(userId: number): Promise<number> {
  const cached = await getCachedDepositCollateralUsd(userId);
  if (cached != null && cached > 0) return cached;
  return refreshDepositBalanceCacheFromChain(userId);
}
