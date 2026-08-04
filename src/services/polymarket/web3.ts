import {
  createPublicClient,
  fallback,
  http,
  formatEther,
  formatUnits,
  type Transport,
} from 'viem';
import { polygon } from 'viem/chains';
import { CONFIG } from '../../config/env';

/** Polygon Bridged USDC (USDC.e), 6 decimals — CLOB V2 wrap 入金来源；BUY 抵押在 CLOB 侧为 pUSD */
export const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;
/** 与 USDC_E_ADDRESS 相同，便于语义区分（wrap / 链上入金扫描仍用 USDC.e） */
export const USDC_E_TOKEN = USDC_E_ADDRESS;

/** Circle 原生 USDC（Polygon PoS）；onramp 直接 wrap 为 paused，需先 swap 为 USDC.e */
export const USDC_NATIVE_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const;

/** Polygon Wormhole Bridged USDT（与 Polymarket Bridge /supported-assets 一致）；EOA→Bridge→pUSD */
export const USDT_POLYGON_ADDRESS = '0x9417669fBF23357D2774e9D421307bd5eA1006d2' as const;

/** Polygon USDT0 / PoS USDT（交易所提 Polygon 常见）；EOA→Bridge→pUSD */
export const USDT0_POLYGON_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' as const;

/** Polymarket CLOB V2 BUY 抵押（pUSD / CollateralToken proxy），6 decimals */
export const PUSD_TOKEN = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' as const;

/**
 * NegRisk Wrapped Collateral（WCOL）。
 * 多数 neg-risk 结果代币的 CTF collateral 是 WCOL（underlying=USDC.e），不是 pUSD。
 */
export const WCOL_TOKEN = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2' as const;

/** Polymarket Conditional Tokens Framework (CTF); redeemPositions pays winning shares from this contract. */
export const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as const;

/** Collateral Onramp：将 USDC.e wrap 为 pUSD（`wrap(asset, to, amount)`） */
export const COLLATERAL_ONRAMP_ADDRESS = '0x93070a847efEf7F70739046A929D47a521F5B8ee' as const;

/** Collateral Offramp：将 pUSD unwrap 回 USDC.e（提现 / Gas 付款链上转 USDC.e 前使用） */
export const COLLATERAL_OFFRAMP_ADDRESS = '0x2957922Eb93258b93368531d39fAcCA3B4dC5854' as const;

const INTERNAL_COLLATERAL_USDC_SENDERS = new Set(
  [COLLATERAL_ONRAMP_ADDRESS, COLLATERAL_OFFRAMP_ADDRESS].map((a) => a.toLowerCase()),
);

/** unwrap / wrap 产生的 USDC.e 划转，不应记为用户外部充值 */
export function isInternalPolymarketCollateralUsdcSender(from: string | null | undefined): boolean {
  if (!from?.trim()) return false;
  return INTERNAL_COLLATERAL_USDC_SENDERS.has(from.trim().toLowerCase());
}

export function isPolymarketCtfRedeemSender(from: string | null | undefined): boolean {
  return from?.trim().toLowerCase() === CTF_CONTRACT_ADDRESS.toLowerCase();
}

const erc20Abi = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
] as const;

/** 公共只读节点（fallback 链尾）。不含 Ankr：eth_sendRawTransaction 需 API Key，读链 fallback 误用会报 Unauthorized。 */
const DEFAULT_POLYGON_PUBLIC_HTTP: readonly string[] = [
  'https://polygon-bor.publicnode.com',
  'https://polygon.drpc.org',
  'https://1rpc.io/matic',
];

const isPlaceholderRpc =
  !CONFIG.rpcUrl || /polygon-rpc-url-here|your-rpc-url|example\.com/i.test(CONFIG.rpcUrl);

if (isPlaceholderRpc) {
  console.warn('[web3] RPC_URL is missing or still a placeholder; using public Polygon RPC');
}

const chain = { ...polygon, id: CONFIG.chainId || polygon.id };
const effectiveRpcUrl = isPlaceholderRpc ? polygon.rpcUrls.default.http[0] : CONFIG.rpcUrl;

function uniqueRpcUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const t = u.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function buildPolygonHttpTransport(): Transport {
  const primary = effectiveRpcUrl;
  const builtins = CONFIG.rpcBuiltinPublicFallbacks ? [...DEFAULT_POLYGON_PUBLIC_HTTP] : [];
  const urls = uniqueRpcUrls([primary, ...CONFIG.rpcFallbackUrls, ...builtins]);
  const httpOpts = {
    timeout: CONFIG.rpcHttpTimeoutMs,
    /** 单节点模式（无 fallback）时，对偶发 5xx 重试；viem 的 fallback 子 transport 会自行覆盖 retryCount */
    retryCount: 2,
    retryDelay: 400,
  };
  if (urls.length === 1) {
    return http(urls[0], httpOpts);
  }
  return fallback(urls.map((u) => http(u, httpOpts)));
}

const transport = buildPolygonHttpTransport();

const httpOpts = {
  timeout: CONFIG.rpcHttpTimeoutMs,
  retryCount: 2,
  retryDelay: 400,
};

/** 写链（broadcast）只用 RPC_URL，避免 fallback 到无 Key 的公共节点导致 eth_sendRawTransaction 失败。 */
const writePublicClient = createPublicClient({
  chain,
  transport: http(effectiveRpcUrl, httpOpts),
});

export const publicClient = createPublicClient({
  chain,
  transport,
});

/** 广播已签名 raw tx；仅走主 RPC_URL（Alchemy 等付费节点）。 */
export async function broadcastRawTransaction(
  serializedTransaction: `0x${string}`,
): Promise<`0x${string}`> {
  return writePublicClient.sendRawTransaction({ serializedTransaction });
}

export async function getNativeBalance(address: `0x${string}`) {
  const balanceWei = await publicClient.getBalance({ address });
  return {
    wei: balanceWei,
    ether: formatEther(balanceWei),
  };
}

export async function getErc20Balance(
  address: `0x${string}`,
  tokenAddress: `0x${string}`,
  decimals: number = 18,
) {
  const raw = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
  return {
    raw,
    formatted: formatUnits(raw, decimals),
  };
}

export async function getUsdcBalance(address: `0x${string}`) {
  return getErc20Balance(address, USDC_E_ADDRESS, 6);
}

export async function getNativeUsdcBalance(address: `0x${string}`) {
  return getErc20Balance(address, USDC_NATIVE_ADDRESS, 6);
}

export async function getPusdBalance(address: `0x${string}`) {
  return getErc20Balance(address, PUSD_TOKEN, 6);
}
