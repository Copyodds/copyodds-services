/** Polygon token addresses for EOA/funder deposit detection (keep in sync with web3.ts). */
export const USDC_E_TOKEN_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;
export const USDC_NATIVE_TOKEN_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const;
export const USDT_POLYGON_TOKEN_ADDRESS = '0x9417669fBF23357D2774e9D421307bd5eA1006d2' as const;
export const USDT0_POLYGON_TOKEN_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' as const;

export type ResolvedUsdcVariant = 'native' | 'usdce' | 'usdt' | 'usdt0';

/** Map Polygon token contract → EOA/funder deposit variant. */
export function resolveUsdcVariant(tokenAddress: string): ResolvedUsdcVariant | null {
  const lower = tokenAddress.trim().toLowerCase();
  if (lower === USDC_NATIVE_TOKEN_ADDRESS.toLowerCase()) return 'native';
  if (lower === USDC_E_TOKEN_ADDRESS.toLowerCase()) return 'usdce';
  if (lower === USDT_POLYGON_TOKEN_ADDRESS.toLowerCase()) return 'usdt';
  if (lower === USDT0_POLYGON_TOKEN_ADDRESS.toLowerCase()) return 'usdt0';
  return null;
}
