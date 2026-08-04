import { CONFIG } from '../../config/env';
import { getUsdcBalance, USDC_E_ADDRESS } from '../polymarket/web3';
import { getCustodialWalletAddressForUser } from './custody';
import { upsertUserCustodyUsdcBalanceCache } from './userBalanceCache';

type OnChainUsdcBalanceResult = {
  address: string;
  chainId: number;
  tokenAddress: string;
  usdc: { raw: string; decimals: number; formatted: string };
  cachedAt: string;
  cacheExpiresAt: string | null;
};

type CachedOnChainBalanceEntry = {
  expiresAt: number;
  value: OnChainUsdcBalanceResult;
};

const onChainBalanceCache = new Map<number, CachedOnChainBalanceEntry>();
const onChainBalanceInflight = new Map<number, Promise<OnChainUsdcBalanceResult | null>>();

export async function getOnChainUsdcBalanceForCustodialUser(userId: number): Promise<{
  address: string;
  chainId: number;
  tokenAddress: string;
  usdc: { raw: string; decimals: number; formatted: string };
  cachedAt: string;
  cacheExpiresAt: string | null;
} | null> {
  const cacheTtlMs = Math.max(0, CONFIG.custodyOnChainBalanceCacheTtlMs);
    if (cacheTtlMs > 0) {
      const cached = onChainBalanceCache.get(userId);
      if (cached && cached.expiresAt > Date.now()) {
        try {
          await upsertUserCustodyUsdcBalanceCache(userId, cached.value.usdc.formatted);
        } catch (err) {
          console.error('[user-balance-cache] failed to persist cached custody usdc balance', {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return cached.value;
      }

    const inflight = onChainBalanceInflight.get(userId);
    if (inflight) {
      return inflight;
    }
  }

  const task = (async (): Promise<OnChainUsdcBalanceResult | null> => {
    const address = await getCustodialWalletAddressForUser(userId);
    if (!address) return null;
    const checksummed = address as `0x${string}`;
    const { raw, formatted } = await getUsdcBalance(checksummed);
    const now = Date.now();
    const cacheExpiresAt = cacheTtlMs > 0 ? now + cacheTtlMs : null;
    const result: OnChainUsdcBalanceResult = {
      address,
      chainId: CONFIG.chainId || 137,
      tokenAddress: USDC_E_ADDRESS,
      usdc: {
        raw: raw.toString(),
        decimals: 6,
        formatted,
      },
      cachedAt: new Date(now).toISOString(),
      cacheExpiresAt: cacheExpiresAt ? new Date(cacheExpiresAt).toISOString() : null,
    };

    if (cacheTtlMs > 0) {
      onChainBalanceCache.set(userId, {
        expiresAt: cacheExpiresAt!,
        value: result,
      });
    }

    try {
      await upsertUserCustodyUsdcBalanceCache(userId, formatted);
    } catch (err) {
      console.error('[user-balance-cache] failed to persist custody usdc balance', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  })();

  if (cacheTtlMs > 0) {
    onChainBalanceInflight.set(userId, task);
  }

  try {
    return await task;
  } finally {
    if (cacheTtlMs > 0) {
      onChainBalanceInflight.delete(userId);
    }
  }
}

export function invalidateOnChainUsdcBalanceCacheForCustodialUser(userId: number) {
  onChainBalanceCache.delete(userId);
  onChainBalanceInflight.delete(userId);
}
