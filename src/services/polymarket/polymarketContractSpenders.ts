import { CONFIG } from '../../config/env';

/**
 * Polygon 主网 Polymarket CLOB 实际会检查的抵押支出方（与 CLOB getBalanceAllowance 对齐）。
 * 与 https://docs.polymarket.com/resources/contract-addresses 一致。
 * 即使 .env 里仍配置旧版 CLOB_SPENDER，relayer 预授权也必须覆盖这些地址，否则会出现链上对旧合约无限授权、CLOB 仍报 allowance 全 0。
 */
const POLYGON_MAINNET_POLYMARKET_TRADING_CORE: readonly string[] = [
  '0xE111180000d2663C0091e4f400237545B87B996B', // CTF Exchange
  '0xe2222d279d744050d28e00520010520000310F59', // Neg Risk CTF Exchange
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296', // Neg Risk Adapter
];

function canonicalPolygonTradingAddresses(): string[] {
  if ((CONFIG.chainId || 137) !== 137) {
    return [];
  }
  return [...POLYGON_MAINNET_POLYMARKET_TRADING_CORE];
}

/** CLOB V2 BUY：pUSD 对 Exchange / NegRisk / adapter 等支出方授权 */
export function getPolymarketCollateralSpenders(negRisk: boolean): string[] {
  const spenders = negRisk
    ? [CONFIG.clobSpenderNegRisk, CONFIG.negRiskAdapterAddress]
    : [CONFIG.clobSpender];
  return Array.from(new Set(spenders.map((spender) => spender.toLowerCase())));
}

/** CTF operators for SELL — standard vs neg-risk. */
export function getPolymarketConditionalOperators(negRisk: boolean): string[] {
  const operators = negRisk
    ? [CONFIG.clobSpender, CONFIG.clobSpenderNegRisk, CONFIG.negRiskAdapterAddress]
    : [CONFIG.clobSpender];
  return Array.from(new Set(operators.map((operator) => operator.toLowerCase())));
}

function uniqueAddresses(addresses: string[]): string[] {
  return Array.from(new Set(addresses.map((a) => a.toLowerCase())));
}

/** V2 pUSD collateral adapters — redeem/split/merge 需 CTF setApprovalForAll + pUSD approve */
function polygonCollateralAdapterAddresses(): string[] {
  if ((CONFIG.chainId || 137) !== 137) {
    return [];
  }
  return uniqueAddresses([
    CONFIG.ctfCollateralAdapterAddress,
    CONFIG.negRiskCtfCollateralAdapterAddress,
  ]);
}

/** Union of all configured spenders so one relayer batch covers any market type. */
export function getAllPolymarketCollateralSpenders(): string[] {
  return uniqueAddresses([
    ...canonicalPolygonTradingAddresses(),
    ...getPolymarketCollateralSpenders(false),
    ...getPolymarketCollateralSpenders(true),
    ...polygonCollateralAdapterAddresses(),
  ]);
}

export function getAllPolymarketConditionalOperators(): string[] {
  return uniqueAddresses([
    ...canonicalPolygonTradingAddresses(),
    ...getPolymarketConditionalOperators(false),
    ...getPolymarketConditionalOperators(true),
    ...polygonCollateralAdapterAddresses(),
  ]);
}
