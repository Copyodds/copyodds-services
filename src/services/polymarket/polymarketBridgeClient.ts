/**
 * Polymarket Bridge API — https://docs.polymarket.com/trading/bridge/deposit
 */
import { getAddress } from 'viem';
import { CONFIG } from '../../config/env';
import { createAppError, createConflictError } from '../../utils/appError';
import { Code } from '../../utils/response';
import { polymarketApiSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';
import { USDC_E_ADDRESS, USDT_POLYGON_ADDRESS, USDT0_POLYGON_ADDRESS } from './web3';

const BRIDGE_FETCH_TIMEOUT_MS = 20_000;
const BRIDGE_API_HOSTS = ['bridge.polymarket.com'] as const;

export type PolymarketBridgeDepositAddresses = {
  evm?: string;
  svm?: string;
  btc?: string;
  tvm?: string;
};

export type PolymarketBridgeCreateDepositResult = {
  addresses: PolymarketBridgeDepositAddresses;
  note?: string;
};

export type PolymarketBridgeTransactionStatus =
  | 'DEPOSIT_DETECTED'
  | 'PROCESSING'
  | 'ORIGIN_TX_CONFIRMED'
  | 'SUBMITTED'
  | 'COMPLETED'
  | 'FAILED';

export type PolymarketBridgeTransaction = {
  fromChainId?: string;
  fromTokenAddress?: string;
  fromAmountBaseUnit?: string;
  toChainId?: string;
  toTokenAddress?: string;
  status?: PolymarketBridgeTransactionStatus;
  txHash?: string;
  createdTimeMs?: number;
};

export type PolymarketBridgeSupportedAsset = {
  chainId?: string;
  chainName?: string;
  token?: { symbol?: string; address?: string; decimals?: number };
  minCheckoutUsd?: number;
  [key: string]: unknown;
};

function bridgeBaseUrl(): string {
  return (CONFIG.polymarketBridgeUrl ?? 'https://bridge.polymarket.com').replace(/\/+$/, '');
}

async function bridgeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${bridgeBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_FETCH_TIMEOUT_MS);
  try {
    const res = await safeFetch(
      url,
      {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init?.headers ?? {}),
        },
      },
      polymarketApiSafeFetchOptions(BRIDGE_API_HOSTS),
    );
    const text = await res.text();
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const errMsg =
        body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `Polymarket Bridge API ${res.status}`;
      throw createAppError({
        code: res.status >= 500 ? Code.DEPENDENCY_UNAVAILABLE : Code.VALIDATION_FAILED,
        httpStatus: res.status >= 500 ? 503 : 400,
        message: errMsg,
        details: { path, status: res.status, body },
      });
    }
    return body as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw createConflictError('Polymarket Bridge API 请求超时', {
        reasonCode: 'POLYMARKET_BRIDGE_TIMEOUT',
        path,
      });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEvmAddress(raw: string): `0x${string}` {
  return getAddress(raw.trim()) as `0x${string}`;
}

function parseDepositAddresses(raw: unknown): PolymarketBridgeDepositAddresses {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const o = raw as Record<string, unknown>;
  const inner = o.address && typeof o.address === 'object' ? (o.address as Record<string, unknown>) : o;
  const out: PolymarketBridgeDepositAddresses = {};
  for (const key of ['evm', 'svm', 'btc', 'tvm'] as const) {
    const v = inner[key];
    if (typeof v === 'string' && v.trim()) {
      out[key] = v.trim();
    }
  }
  return out;
}

/** POST /deposit — 为 Polymarket 钱包（deposit wallet）创建桥接充值地址 */
export async function createPolymarketBridgeDepositAddresses(
  polymarketWalletAddress: string,
): Promise<PolymarketBridgeCreateDepositResult> {
  const address = normalizeEvmAddress(polymarketWalletAddress);
  const body = await bridgeFetch<{ address?: unknown; note?: string }>('/deposit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const addresses = parseDepositAddresses(body);
  if (!addresses.evm && !addresses.svm && !addresses.btc && !addresses.tvm) {
    throw createConflictError('Polymarket Bridge 未返回有效桥接地址', {
      reasonCode: 'POLYMARKET_BRIDGE_EMPTY_ADDRESSES',
      polymarketWalletAddress: address,
    });
  }
  return {
    addresses,
    note: typeof body.note === 'string' ? body.note : undefined,
  };
}

/** GET /status/{address} — 查询桥接地址上的充值进度（address 为 Bridge 返回的 evm/svm/btc 地址） */
export async function getPolymarketBridgeDepositStatus(
  bridgeAddress: string,
): Promise<{ transactions: PolymarketBridgeTransaction[] }> {
  const trimmed = bridgeAddress.trim();
  if (!trimmed) {
    throw createAppError({
      code: Code.VALIDATION_FAILED,
      httpStatus: 400,
      message: 'bridgeAddress is required',
    });
  }
  const encoded = encodeURIComponent(trimmed);
  const body = await bridgeFetch<{ transactions?: PolymarketBridgeTransaction[] }>(`/status/${encoded}`);
  return {
    transactions: Array.isArray(body.transactions) ? body.transactions : [],
  };
}

/** GET /supported-assets — 支持的链与代币（含最低充值额） */
export async function getPolymarketBridgeSupportedAssets(): Promise<{
  assets: PolymarketBridgeSupportedAsset[];
  raw: unknown;
}> {
  const body = await bridgeFetch<unknown>('/supported-assets', { method: 'GET' });
  if (Array.isArray(body)) {
    return { assets: body as PolymarketBridgeSupportedAsset[], raw: body };
  }
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.assets)) {
      return { assets: o.assets as PolymarketBridgeSupportedAsset[], raw: body };
    }
    if (Array.isArray(o.supportedAssets)) {
      return { assets: o.supportedAssets as PolymarketBridgeSupportedAsset[], raw: body };
    }
  }
  return { assets: [], raw: body };
}

export const POLYMARKET_BRIDGE_DEPOSIT_GUIDANCE = {
  docsUrl: 'https://docs.polymarket.com/cn/trading/bridge/deposit',
  pusdDocsUrl: 'https://docs.polymarket.com/cn/concepts/pusd',
  /** 用户统一充值到 custodial EOA；原生 USDC / USDT / USDT0 由平台自动转至 Bridge evm */
  unifiedEoaDeposit: true,
  eoaNativeUsdcRoute: 'eoa_to_bridge_evm' as const,
  eoaUsdtRoute: 'eoa_to_bridge_evm' as const,
  eoaUsdt0Route: 'eoa_to_bridge_evm' as const,
  eoaUsdceRoute: 'eoa_to_deposit_wrap' as const,
  recommendedForNativeUsdc: 'custodial_eoa' as const,
  recommendedForUsdtOnPolygon: 'custodial_eoa' as const,
  recommendedForUsdt0OnPolygon: 'custodial_eoa' as const,
  recommendedForUsdceOnPolygon: 'custodial_eoa' as const,
  directDepositAcceptedToken: 'USDC.e' as const,
  directDepositTokenAddress: USDC_E_ADDRESS,
  usdtTokenAddress: USDT_POLYGON_ADDRESS,
  usdt0TokenAddress: USDT0_POLYGON_ADDRESS,
  warningNativeUsdcDirectDeposit:
    '请勿向 Deposit Wallet 直接充值 Polygon 原生 USDC、USDT 或 USDT0。请充值到平台托管 EOA，系统会自动经 Polymarket Bridge 处理为 pUSD；或改充 USDC.e。',
};
