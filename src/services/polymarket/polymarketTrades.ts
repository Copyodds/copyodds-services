/**
 * Polymarket Data API — trades (https://data-api.polymarket.com/trades)
 */

import { polymarketApiSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const DATA_API_FETCH_TIMEOUT_MS = 15_000;
const TRADES_PAGE_SIZE = 1_000;
/** Polymarket Data API 硬限制：offset > 3000 会 400（max historical activity offset） */
const TRADES_MAX_OFFSET = 3_000;
/** ALL 超限后按时间窗回退拉取的最大窗数（每窗最多约 4000 笔） */
const TRADES_EXHAUSTIVE_MAX_WINDOWS = 40;
const TRADES_CACHE_TTL_MS = 5 * 60_000;
const TRADES_CACHE_MAX_ENTRIES = 128;
/** 缓存按估算字节限容：高频钱包单窗可达数千笔，仅按条目数限制会失控 */
const TRADES_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** 单条目上限：超大窗口（巨鲸/高频）不缓存，用完即弃 */
const TRADES_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
/** 单笔成交对象近似字节（含 title/slug/txHash 等 passthrough 字段） */
const APPROX_TRADE_BYTES = 600;

export type DataApiTrade = {
  proxyWallet?: string;
  side?: 'BUY' | 'SELL';
  asset?: string;
  conditionId?: string;
  size?: number;
  price?: number;
  timestamp?: number;
  title?: string;
  slug?: string;
  transactionHash?: string;
  [key: string]: unknown;
};

type TradesCacheEntry = {
  expiresAt: number;
  data: DataApiTrade[];
  approxBytes: number;
};

const tradesWindowCache = new Map<string, TradesCacheEntry>();
let tradesCacheTotalBytes = 0;

function deleteTradesCacheEntry(key: string): void {
  const entry = tradesWindowCache.get(key);
  if (!entry) return;
  tradesCacheTotalBytes -= entry.approxBytes;
  tradesWindowCache.delete(key);
}

function tradesCacheKey(
  userAddress: string,
  windowStartMs: number,
  windowEndMs: number,
  takerOnly: boolean
): string {
  return [userAddress.toLowerCase(), windowStartMs, windowEndMs, takerOnly ? '1' : '0'].join('|');
}

function readTradesCache(key: string): DataApiTrade[] | null {
  const entry = tradesWindowCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    deleteTradesCacheEntry(key);
    return null;
  }
  return entry.data;
}

function writeTradesCache(key: string, data: DataApiTrade[]): void {
  const approxBytes = 200 + data.length * APPROX_TRADE_BYTES;
  // 超大条目直接不缓存：缓存的价值是省重复请求，而不是把巨鲸全量成交常驻内存
  if (approxBytes > TRADES_CACHE_MAX_ENTRY_BYTES) {
    return;
  }
  deleteTradesCacheEntry(key);
  while (
    tradesWindowCache.size >= TRADES_CACHE_MAX_ENTRIES ||
    (tradesWindowCache.size > 0 &&
      tradesCacheTotalBytes + approxBytes > TRADES_CACHE_MAX_TOTAL_BYTES)
  ) {
    const oldestKey = tradesWindowCache.keys().next().value;
    if (!oldestKey) break;
    deleteTradesCacheEntry(oldestKey);
  }
  tradesWindowCache.set(key, {
    expiresAt: Date.now() + TRADES_CACHE_TTL_MS,
    data,
    approxBytes,
  });
  tradesCacheTotalBytes += approxBytes;
}

export function normalizeTradeTimestampMs(timestamp: number | undefined | null): number | null {
  if (timestamp == null || !Number.isFinite(timestamp)) return null;
  if (timestamp > 1_000_000_000_000) return Math.trunc(timestamp);
  return Math.trunc(timestamp * 1000);
}

/** 单请求超时 + 外部取消信号合并；外部 abort 时中止 HTTP 而不是让请求继续裸跑 */
function buildTradesFetchSignal(external?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DATA_API_FETCH_TIMEOUT_MS);
  if (!external) return timeoutSignal;
  return AbortSignal.any([timeoutSignal, external]);
}

export async function fetchDataApiTradesPage(
  userAddress: string,
  options?: {
    limit?: number;
    offset?: number;
    takerOnly?: boolean;
    side?: 'BUY' | 'SELL';
    skipCache?: boolean;
    signal?: AbortSignal;
  }
): Promise<DataApiTrade[]> {
  const params = new URLSearchParams();
  params.set('user', userAddress.toLowerCase());
  params.set('limit', String(options?.limit ?? TRADES_PAGE_SIZE));
  params.set('offset', String(options?.offset ?? 0));
  params.set('takerOnly', String(options?.takerOnly ?? false));

  if (options?.side) params.set('side', options.side);

  let res: Response;
  try {
    res = await safeFetch(
      `${DATA_API_BASE}/trades?${params}`,
      {
        headers: { Accept: 'application/json' },
        signal: buildTradesFetchSignal(options?.signal),
      },
      polymarketApiSafeFetchOptions()
    );
  } catch (err) {
    if (options?.signal?.aborted) {
      throw new Error(`Data API trades aborted (caller cancelled): ${userAddress.toLowerCase()}`);
    }
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new Error(
        `Data API trades timeout after ${DATA_API_FETCH_TIMEOUT_MS}ms (upstream data-api.polymarket.com)`
      );
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Data API trades ${res.status}: ${text}`);
  }

  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as DataApiTrade[]) : [];
}

function isTradesOffsetExceededError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /max historical activity offset/i.test(message) || /offset of 3000 exceeded/i.test(message);
}

/**
 * 拉取落在 [windowStartMs, windowEndMs] 内的成交。
 * 上游默认按时间倒序分页；遇到早于窗口起点的成交即停止翻页。
 * 受 Data API offset≤3000 限制，超限时返回已拉取部分并标记 truncated，不再抛错。
 */
export async function fetchDataApiTradesInWindow(
  userAddress: string,
  windowStartMs: number,
  windowEndMs: number,
  options?: {
    takerOnly?: boolean;
    skipCache?: boolean;
    signal?: AbortSignal;
    /** 仅统计 countSinceMs 起的笔数达到 stopWhenCountGte 即停（Deep-Gate L1 早停） */
    stopWhenCountGte?: number;
    countSinceMs?: number;
  }
): Promise<{ trades: DataApiTrade[]; truncated: boolean; earlyStopped?: boolean }> {
  const takerOnly = options?.takerOnly ?? false;
  const stopWhenCountGte = options?.stopWhenCountGte;
  const countSinceMs = options?.countSinceMs ?? windowStartMs;
  const earlyStopEnabled =
    stopWhenCountGte != null && Number.isFinite(stopWhenCountGte) && stopWhenCountGte > 0;

  // 早停路径不走全窗缓存，避免把半窗结果污染全窗 cache
  const cacheKey = tradesCacheKey(userAddress, windowStartMs, windowEndMs, takerOnly);
  if (!options?.skipCache && !earlyStopEnabled) {
    const cached = readTradesCache(cacheKey);
    if (cached) {
      return { trades: cached, truncated: false };
    }
  }

  const trades: DataApiTrade[] = [];
  let truncated = false;
  let earlyStopped = false;
  let countedSince = 0;

  for (let offset = 0; offset <= TRADES_MAX_OFFSET; offset += TRADES_PAGE_SIZE) {
    options?.signal?.throwIfAborted();
    let page: DataApiTrade[];
    try {
      page = await fetchDataApiTradesPage(userAddress, {
        limit: TRADES_PAGE_SIZE,
        offset,
        takerOnly,
        skipCache: true,
        signal: options?.signal,
      });
    } catch (err) {
      if (isTradesOffsetExceededError(err)) {
        truncated = true;
        break;
      }
      throw err;
    }
    if (page.length === 0) break;

    let reachedBeforeWindow = false;
    for (const trade of page) {
      const tsMs = normalizeTradeTimestampMs(trade.timestamp);
      if (tsMs == null) continue;
      if (tsMs > windowEndMs) continue;
      if (tsMs < windowStartMs) {
        reachedBeforeWindow = true;
        break;
      }
      trades.push(trade);
      if (tsMs >= countSinceMs) countedSince += 1;
    }

    if (
      earlyStopEnabled &&
      countedSince >= (stopWhenCountGte as number)
    ) {
      earlyStopped = true;
      break;
    }

    if (reachedBeforeWindow) break;
    if (page.length < TRADES_PAGE_SIZE) break;
    if (offset + TRADES_PAGE_SIZE > TRADES_MAX_OFFSET) {
      truncated = true;
      break;
    }
  }

  if (!options?.skipCache && !earlyStopEnabled) {
    writeTradesCache(cacheKey, trades);
  }

  return { trades, truncated, earlyStopped };
}

function oldestTradeTimestampMs(trades: DataApiTrade[]): number | null {
  let oldest: number | null = null;
  for (const trade of trades) {
    const tsMs = normalizeTradeTimestampMs(trade.timestamp);
    if (tsMs == null) continue;
    if (oldest == null || tsMs < oldest) oldest = tsMs;
  }
  return oldest;
}

function tradeDedupeKey(trade: DataApiTrade): string {
  return [
    trade.transactionHash ?? '',
    String(trade.timestamp ?? ''),
    trade.asset ?? '',
    trade.side ?? '',
    String(trade.size ?? ''),
    String(trade.price ?? ''),
  ].join('|');
}

/**
 * 突破 Data API offset≤3000 限制：按时间窗向更早继续拉，直到窗口内不再截断。
 * 用于 ALL 成交笔数（高活跃钱包 30D 就可能 >1000，lifetime/predictionCount 口径更小且不可比）。
 */
export async function fetchDataApiTradesInWindowExhaustive(
  userAddress: string,
  windowStartMs: number,
  windowEndMs: number,
  options?: { takerOnly?: boolean; skipCache?: boolean; signal?: AbortSignal }
): Promise<{ trades: DataApiTrade[]; truncated: boolean }> {
  const takerOnly = options?.takerOnly ?? false;
  const cacheKey = `exhaustive|${tradesCacheKey(userAddress, windowStartMs, windowEndMs, takerOnly)}`;
  if (!options?.skipCache) {
    const cached = readTradesCache(cacheKey);
    if (cached) {
      return { trades: cached, truncated: false };
    }
  }

  const merged: DataApiTrade[] = [];
  const seen = new Set<string>();
  let cursorEndMs = windowEndMs;
  let truncated = false;

  for (let windowIndex = 0; windowIndex < TRADES_EXHAUSTIVE_MAX_WINDOWS; windowIndex += 1) {
    options?.signal?.throwIfAborted();
    const batch = await fetchDataApiTradesInWindow(userAddress, windowStartMs, cursorEndMs, {
      takerOnly,
      skipCache: true,
      signal: options?.signal,
    });

    let added = 0;
    for (const trade of batch.trades) {
      const key = tradeDedupeKey(trade);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trade);
      added += 1;
    }

    if (!batch.truncated) {
      truncated = false;
      break;
    }

    if (batch.trades.length === 0 || added === 0) {
      truncated = true;
      break;
    }

    const oldestTs = oldestTradeTimestampMs(batch.trades);
    if (oldestTs == null || oldestTs <= windowStartMs) {
      truncated = true;
      break;
    }

    // 下窗仍包含 oldestTs，靠 dedupe 吃掉重叠，避免同一秒多笔在切窗时丢失
    if (oldestTs >= cursorEndMs) {
      truncated = true;
      break;
    }
    cursorEndMs = oldestTs;
    truncated = true;
  }

  if (!options?.skipCache && !truncated) {
    writeTradesCache(cacheKey, merged);
  }

  return { trades: merged, truncated };
}
