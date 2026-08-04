import {
  fetchDataApiTradesPage,
  normalizeTradeTimestampMs,
  type DataApiTrade,
} from '../polymarket/polymarketTrades';

/** 地址详情页成交：短缓存，减少热门地址重复打上游 */
const PROFILE_TRADES_CACHE_TTL_MS = 60_000;
const PROFILE_TRADES_CACHE_MAX_ENTRIES = 256;
const DEFAULT_TRADE_LIMIT = 50;
const MAX_TRADE_LIMIT = 200;

type ProfileTradesCacheEntry = {
  expiresAt: number;
  trades: SmartMoneyProfileTradeItem[];
  fetchedAt: string;
};

const profileTradesCache = new Map<string, ProfileTradesCacheEntry>();

export type SmartMoneyProfileTradesFetchErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown';

export class SmartMoneyProfileTradesFetchError extends Error {
  readonly kind: SmartMoneyProfileTradesFetchErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterSec: number | null;

  constructor(
    kind: SmartMoneyProfileTradesFetchErrorKind,
    message: string,
    options?: { retryable?: boolean; status?: number | null; retryAfterSec?: number | null }
  ) {
    super(message);
    this.name = 'SmartMoneyProfileTradesFetchError';
    this.kind = kind;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status ?? null;
    this.retryAfterSec = options?.retryAfterSec ?? null;
  }
}

export type SmartMoneyProfileTradeItem = {
  id: string;
  side: 'BUY' | 'SELL' | null;
  title: string | null;
  slug: string | null;
  outcome: string | null;
  conditionId: string | null;
  asset: string | null;
  size: number | null;
  price: number | null;
  notionalUsd: number | null;
  timestamp: string | null;
  timestampMs: number | null;
  transactionHash: string | null;
};

export type SmartMoneyProfileTradesResult = {
  wallet: string;
  trades: SmartMoneyProfileTradeItem[];
  meta: {
    fetchedAt: string;
    cacheHit: boolean;
    limit: number;
    offset: number;
    count: number;
    source: 'polymarket_data_api';
  };
};

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringFromUnknown(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function cacheKey(wallet: string, limit: number, offset: number): string {
  return `${normalizeWallet(wallet)}|${limit}|${offset}`;
}

function readCache(wallet: string, limit: number, offset: number): ProfileTradesCacheEntry | null {
  const key = cacheKey(wallet, limit, offset);
  const entry = profileTradesCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    profileTradesCache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(
  wallet: string,
  limit: number,
  offset: number,
  trades: SmartMoneyProfileTradeItem[],
  fetchedAt: string
): void {
  const key = cacheKey(wallet, limit, offset);
  if (profileTradesCache.size >= PROFILE_TRADES_CACHE_MAX_ENTRIES) {
    const oldestKey = profileTradesCache.keys().next().value;
    if (oldestKey) profileTradesCache.delete(oldestKey);
  }
  profileTradesCache.set(key, {
    expiresAt: Date.now() + PROFILE_TRADES_CACHE_TTL_MS,
    trades,
    fetchedAt,
  });
}

export function classifyDataApiTradesError(error: unknown): SmartMoneyProfileTradesFetchError {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/Data API trades (\d{3})/i);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : null;

  if (status === 429 || /too many requests|rate limit/i.test(message)) {
    return new SmartMoneyProfileTradesFetchError('rate_limit', message, {
      retryable: true,
      status: status ?? 429,
    });
  }
  if (/timeout|AbortError|TimeoutError/i.test(message)) {
    return new SmartMoneyProfileTradesFetchError('timeout', message, {
      retryable: true,
      status,
    });
  }
  if (status != null && status >= 500) {
    return new SmartMoneyProfileTradesFetchError('server', message, {
      retryable: true,
      status,
    });
  }
  if (/network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return new SmartMoneyProfileTradesFetchError('network', message, {
      retryable: true,
      status,
    });
  }
  return new SmartMoneyProfileTradesFetchError('unknown', message, {
    retryable: false,
    status,
  });
}

export function formatSmartMoneyProfileTrade(trade: DataApiTrade, index: number): SmartMoneyProfileTradeItem {
  const size = numberFromUnknown(trade.size);
  const price = numberFromUnknown(trade.price);
  const timestampMs = normalizeTradeTimestampMs(trade.timestamp);
  const side =
    trade.side === 'BUY' || trade.side === 'SELL'
      ? trade.side
      : null;
  const title = stringFromUnknown(trade.title);
  const slug = stringFromUnknown(trade.slug);
  const conditionId = stringFromUnknown(trade.conditionId);
  const asset = stringFromUnknown(trade.asset);
  const tx = stringFromUnknown(trade.transactionHash);
  const outcome = stringFromUnknown((trade as { outcome?: unknown }).outcome);

  return {
    id: tx ?? `${conditionId ?? 't'}-${timestampMs ?? index}-${side ?? 'x'}-${index}`,
    side,
    title,
    slug,
    outcome,
    conditionId,
    asset,
    size,
    price,
    notionalUsd:
      size != null && price != null ? Math.round(size * price * 10000) / 10000 : null,
    timestamp: timestampMs != null ? new Date(timestampMs).toISOString() : null,
    timestampMs,
    transactionHash: tx,
  };
}

/**
 * 地址详情页交易记录：直连 Polymarket Data API `/trades`（按时间倒序）。
 */
export async function getSmartMoneyProfileTrades(
  wallet: string,
  options?: { limit?: number; offset?: number }
): Promise<SmartMoneyProfileTradesResult> {
  const normalized = normalizeWallet(wallet);
  const limit = Math.min(
    MAX_TRADE_LIMIT,
    Math.max(1, Math.floor(options?.limit ?? DEFAULT_TRADE_LIMIT))
  );
  const offset = Math.max(0, Math.floor(options?.offset ?? 0));

  const cached = readCache(normalized, limit, offset);
  if (cached) {
    return {
      wallet: normalized,
      trades: cached.trades,
      meta: {
        fetchedAt: cached.fetchedAt,
        cacheHit: true,
        limit,
        offset,
        count: cached.trades.length,
        source: 'polymarket_data_api',
      },
    };
  }

  let raw: DataApiTrade[];
  try {
    raw = await fetchDataApiTradesPage(normalized, {
      limit,
      offset,
      takerOnly: false,
      skipCache: true,
    });
  } catch (error) {
    throw classifyDataApiTradesError(error);
  }

  const trades = raw.map((trade, index) => formatSmartMoneyProfileTrade(trade, index));
  const fetchedAt = new Date().toISOString();
  writeCache(normalized, limit, offset, trades, fetchedAt);

  return {
    wallet: normalized,
    trades,
    meta: {
      fetchedAt,
      cacheHit: false,
      limit,
      offset,
      count: trades.length,
      source: 'polymarket_data_api',
    },
  };
}
