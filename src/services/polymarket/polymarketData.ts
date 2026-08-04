/**
 * Polymarket Data API — positions (https://data-api.polymarket.com/positions)
 */

import { polymarketApiSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const DATA_API_FETCH_TIMEOUT_MS = 15_000;
/** closed-positions 单页往往更大；过短会被 Deep-Gate 误判为「无已平仓」 */
const CLOSED_POSITIONS_FETCH_TIMEOUT_MS = 45_000;
/** 官方文档：closed-positions limit 最大 50（超限 → HTTP 400） */
const CLOSED_POSITIONS_MAX_LIMIT = 50;
/** Deep 默认最多翻页（50×80≈4000 行）；产品窗仍是近一年，此为工程硬顶 */
export const CLOSED_POSITIONS_DEFAULT_MAX_PAGES = 80;
/** 函数允许的最大翻页（防止误传极大值） */
export const CLOSED_POSITIONS_HARD_MAX_PAGES = 80;
/** 单次 closed 抓取总预算，防止超活跃地址拖死 Deep */
export const CLOSED_POSITIONS_TOTAL_BUDGET_MS = 120_000;
/** 页间间隔，降低 429 */
export const CLOSED_POSITIONS_PAGE_GAP_MS = 150;
/** 与聪明钱已平仓分析窗一致 */
export const CLOSED_POSITIONS_WINDOW_DAYS = 365;
const POSITIONS_CACHE_TTL_MS = 30_000;
const POSITIONS_CACHE_MAX_ENTRIES = 256;
/** 缓存按估算字节限容，避免大持仓钱包把内存顶满 */
const POSITIONS_CACHE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const POSITIONS_CACHE_MAX_ENTRY_BYTES = 1 * 1024 * 1024;
const APPROX_POSITION_BYTES = 500;

type PositionsCacheEntry = {
  expiresAt: number;
  data: DataApiPosition[];
  approxBytes: number;
};

const positionsCache = new Map<string, PositionsCacheEntry>();
let positionsCacheTotalBytes = 0;

function deletePositionsCacheEntry(key: string): void {
  const entry = positionsCache.get(key);
  if (!entry) return;
  positionsCacheTotalBytes -= entry.approxBytes;
  positionsCache.delete(key);
}

function positionsCacheKey(
  userAddress: string,
  options?: { limit?: number; sizeThreshold?: number; redeemableOnly?: boolean }
): string {
  return [
    userAddress.toLowerCase(),
    options?.limit ?? 500,
    options?.sizeThreshold ?? 0,
    options?.redeemableOnly ? '1' : '0',
  ].join('|');
}

function readPositionsCache(key: string): DataApiPosition[] | null {
  const entry = positionsCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    deletePositionsCacheEntry(key);
    return null;
  }
  return entry.data;
}

function writePositionsCache(key: string, data: DataApiPosition[]): void {
  const approxBytes = 200 + data.length * APPROX_POSITION_BYTES;
  if (approxBytes > POSITIONS_CACHE_MAX_ENTRY_BYTES) {
    return;
  }
  deletePositionsCacheEntry(key);
  while (
    positionsCache.size >= POSITIONS_CACHE_MAX_ENTRIES ||
    (positionsCache.size > 0 &&
      positionsCacheTotalBytes + approxBytes > POSITIONS_CACHE_MAX_TOTAL_BYTES)
  ) {
    const oldestKey = positionsCache.keys().next().value;
    if (!oldestKey) break;
    deletePositionsCacheEntry(oldestKey);
  }
  positionsCache.set(key, {
    expiresAt: Date.now() + POSITIONS_CACHE_TTL_MS,
    data,
    approxBytes,
  });
  positionsCacheTotalBytes += approxBytes;
}

/** OpenAPI Position schema (subset + passthrough) */
export type DataApiPosition = {
  proxyWallet?: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice?: number;
  curPrice?: number;
  currentValue?: number;
  redeemable: boolean;
  mergeable?: boolean;
  title?: string;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
  negativeRisk?: boolean;
  [key: string]: unknown;
};

/** 单请求超时 + 外部取消信号合并 */
function buildPositionsFetchSignal(
  external?: AbortSignal,
  timeoutMs = DATA_API_FETCH_TIMEOUT_MS
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!external) return timeoutSignal;
  return AbortSignal.any([timeoutSignal, external]);
}

export async function fetchDataApiPositions(
  userAddress: string,
  options?: {
    limit?: number;
    sizeThreshold?: number;
    redeemableOnly?: boolean;
    skipCache?: boolean;
    signal?: AbortSignal;
  }
): Promise<DataApiPosition[]> {
  const cacheKey = positionsCacheKey(userAddress, options);
  if (!options?.skipCache) {
    const cached = readPositionsCache(cacheKey);
    if (cached) return cached;
  }

  const params = new URLSearchParams();
  params.set('user', userAddress.toLowerCase());
  params.set('limit', String(options?.limit ?? 500));
  params.set('sizeThreshold', String(options?.sizeThreshold ?? 0));
  if (options?.redeemableOnly) params.set('redeemable', 'true');

  let res: Response;
  try {
    res = await safeFetch(
      `${DATA_API_BASE}/positions?${params}`,
      {
        headers: { Accept: 'application/json' },
        signal: buildPositionsFetchSignal(options?.signal),
      },
      polymarketApiSafeFetchOptions()
    );
  } catch (err) {
    if (options?.signal?.aborted) {
      throw new Error(`Data API positions aborted (caller cancelled): ${userAddress.toLowerCase()}`);
    }
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new Error(
        `Data API positions timeout after ${DATA_API_FETCH_TIMEOUT_MS}ms (upstream data-api.polymarket.com)`
      );
    }
    throw err;
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Data API positions ${res.status}: ${t}`);
  }
  const data = (await res.json()) as unknown;
  const positions = Array.isArray(data) ? (data as DataApiPosition[]) : [];
  if (!options?.skipCache) {
    writePositionsCache(cacheKey, positions);
  }
  return positions;
}

function positionDedupeKey(p: DataApiPosition): string {
  return `${p.conditionId}:${p.outcomeIndex ?? ''}:${p.asset}`;
}

/** closed / open 持仓去重键（增量 merge 复用） */
export function closedPositionDedupeKey(p: DataApiPosition): string {
  return positionDedupeKey(p);
}

/**
 * Polymarket 交易持仓通常在 deposit/funder 地址；custodial 仅为签名 owner。
 * 合并两地址持仓，避免 UI 只查 custodial 时显示「无持仓」而提现侧仍被 POSITIONS_DEPOSIT 拦截。
 */
export async function fetchDataApiPositionsForWalletPair(
  params: {
    custodial: string;
    deposit?: string | null;
  },
  options?: { limit?: number; sizeThreshold?: number; redeemableOnly?: boolean; skipCache?: boolean },
): Promise<DataApiPosition[]> {
  const custodial = params.custodial.trim();
  const deposit = (params.deposit ?? '').trim();
  const custLower = custodial.toLowerCase();
  const addresses =
    deposit && deposit.toLowerCase() !== custLower ? [deposit, custodial] : [custodial];

  const seen = new Set<string>();
  const merged: DataApiPosition[] = [];
  const lists = await Promise.all(
    addresses.map((addr) => fetchDataApiPositions(addr, options).catch(() => [] as DataApiPosition[]))
  );
  for (const list of lists) {
    for (const p of list) {
      const key = positionDedupeKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(p);
    }
  }
  return merged;
}

type DataApiTradedResponse = {
  user?: string;
  traded?: number;
};

export type ClosedPositionsFetchMeta = {
  /** 返回行数（已按近窗过滤；无时间戳的行保留） */
  rowCount: number;
  /** 实际请求的页数（本调用内；含 startPage 起算的页） */
  pageCount: number;
  /** 触顶或总超时导致可能未覆盖完整近一年 */
  capped: boolean;
  /** 是否因总预算/单页超时而提前结束 */
  timedOut: boolean;
  /** 时间窗已扫尽（不满页或整页早于 cutoff） */
  windowComplete: boolean;
  /** 下一页页码（断点续拉）；扫尽时等于已拉页终点 */
  nextPage: number;
  /** 本调用起始页 */
  startPage: number;
  /** 时间窗天数 */
  windowDays: number;
  fetchOk: boolean;
};

export type ClosedPositionsFetchResult = {
  rows: DataApiPosition[];
  meta: ClosedPositionsFetchMeta;
};

export type FetchDataApiClosedPositionsOptions = {
  limit?: number;
  maxPages?: number;
  /** 从该页码开始拉（0-based）；用于 Closed Prefetch 断点续拉 */
  startPage?: number;
  /** 近窗天数；默认 365。设为 0/null 关闭时间早停与窗过滤（仅翻页） */
  windowDays?: number | null;
  totalBudgetMs?: number;
  pageGapMs?: number;
  skipCache?: boolean;
  signal?: AbortSignal;
  /** now 可注入便于测试 */
  nowMs?: number;
};

/** 解析 closed-positions 行的关闭时间（ms）；无法解析则 null */
export function extractClosedPositionAtMs(row: DataApiPosition): number | null {
  const record = row as Record<string, unknown>;
  const candidates = [
    record.closedAt,
    record.closeTime,
    record.endDate,
    record.settlementTime,
    record.updatedAt,
    record.timestamp,
    record.createdAt,
  ];
  for (const value of candidates) {
    if (value instanceof Date) {
      const ms = value.getTime();
      if (Number.isFinite(ms)) return ms;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value < 1e12 ? value * 1000 : value;
      if (Number.isFinite(ms) && ms > 0) return ms;
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      const asNum = Number(value);
      if (Number.isFinite(asNum) && asNum > 0) {
        const ms = asNum < 1e12 ? asNum * 1000 : asNum;
        if (Number.isFinite(ms)) return ms;
      }
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

/** 整页可解析时间均早于 cutoff → 可停止翻页（假定大致按新→旧） */
export function isClosedPositionsPageBeforeWindow(
  pageRows: DataApiPosition[],
  cutoffMs: number
): boolean {
  if (pageRows.length === 0) return false;
  let timed = 0;
  for (const row of pageRows) {
    const ms = extractClosedPositionAtMs(row);
    if (ms == null) continue;
    timed += 1;
    if (ms >= cutoffMs) return false;
  }
  return timed > 0;
}

function filterClosedRowsToWindow(
  pageRows: DataApiPosition[],
  cutoffMs: number | null
): DataApiPosition[] {
  if (cutoffMs == null) return pageRows;
  return pageRows.filter((row) => {
    const ms = extractClosedPositionAtMs(row);
    if (ms == null) return true;
    return ms >= cutoffMs;
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Data API closed-positions — 已平仓持仓，用于市场胜率与 PnL 集中度。
 * 产品窗：近 windowDays（默认 365）；工程顶：maxPages（默认 80）。
 * 时间早停 + 总预算，避免超活跃地址拖死 Deep。
 */
export async function fetchDataApiClosedPositions(
  userAddress: string,
  options?: FetchDataApiClosedPositionsOptions
): Promise<ClosedPositionsFetchResult> {
  // 官方 closed-positions limit 上限为 50；传 500 会直接 HTTP 400
  const limit = Math.max(1, Math.min(CLOSED_POSITIONS_MAX_LIMIT, options?.limit ?? CLOSED_POSITIONS_MAX_LIMIT));
  const startPage = Math.max(0, Math.floor(options?.startPage ?? 0));
  const maxPages = Math.max(
    1,
    Math.min(CLOSED_POSITIONS_HARD_MAX_PAGES, options?.maxPages ?? CLOSED_POSITIONS_DEFAULT_MAX_PAGES)
  );
  const endPageExclusive = Math.min(CLOSED_POSITIONS_HARD_MAX_PAGES, startPage + maxPages);
  const windowDaysRaw = options?.windowDays;
  const windowDays =
    windowDaysRaw === null || windowDaysRaw === 0
      ? null
      : Math.max(1, windowDaysRaw ?? CLOSED_POSITIONS_WINDOW_DAYS);
  const totalBudgetMs = Math.max(
    5_000,
    options?.totalBudgetMs ?? CLOSED_POSITIONS_TOTAL_BUDGET_MS
  );
  const pageGapMs = Math.max(0, options?.pageGapMs ?? CLOSED_POSITIONS_PAGE_GAP_MS);
  const nowMs = options?.nowMs ?? Date.now();
  const cutoffMs = windowDays != null ? nowMs - windowDays * 24 * 60 * 60 * 1000 : null;
  const wallet = userAddress.toLowerCase();
  const rows: DataApiPosition[] = [];
  let fetchedAnyPage = false;
  let fatalError: Error | null = null;
  let pageCount = 0;
  let timedOut = false;
  let hitPageCap = false;
  let windowComplete = false;
  let nextPage = startPage;
  const startedAt = Date.now();

  for (let page = startPage; page < endPageExclusive; page += 1) {
    if (options?.signal?.aborted) {
      fatalError = new Error('closed-positions aborted');
      break;
    }
    if (Date.now() - startedAt > totalBudgetMs) {
      timedOut = true;
      hitPageCap = true;
      break;
    }
    if (page > startPage && pageGapMs > 0) {
      await sleepMs(pageGapMs);
    }

    const params = new URLSearchParams({
      user: wallet,
      limit: String(limit),
      offset: String(page * limit),
    });
    let res: Response;
    try {
      res = await safeFetch(
        `${DATA_API_BASE}/closed-positions?${params}`,
        {
          headers: { Accept: 'application/json' },
          signal: buildPositionsFetchSignal(options?.signal, CLOSED_POSITIONS_FETCH_TIMEOUT_MS),
        },
        polymarketApiSafeFetchOptions()
      );
    } catch (error) {
      if (options?.signal?.aborted) {
        fatalError = new Error(
          `closed-positions aborted (caller cancelled): ${wallet}`
        );
      } else {
        const name = error instanceof Error ? error.name : '';
        if (name === 'AbortError' || name === 'TimeoutError') {
          timedOut = true;
          fatalError = new Error(
            `closed-positions timeout after ${CLOSED_POSITIONS_FETCH_TIMEOUT_MS}ms`
          );
        } else {
          fatalError = error instanceof Error ? error : new Error(String(error));
        }
      }
      break;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      fatalError = new Error(
        `closed-positions HTTP ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`
      );
      break;
    }
    fetchedAnyPage = true;
    pageCount += 1;
    nextPage = page + 1;
    const data = (await res.json()) as unknown;
    const pageRows = Array.isArray(data) ? (data as DataApiPosition[]) : [];
    rows.push(...filterClosedRowsToWindow(pageRows, cutoffMs));

    if (pageRows.length < limit) {
      windowComplete = true;
      break;
    }
    if (cutoffMs != null && isClosedPositionsPageBeforeWindow(pageRows, cutoffMs)) {
      windowComplete = true;
      break;
    }
    if (page === endPageExclusive - 1 || nextPage >= CLOSED_POSITIONS_HARD_MAX_PAGES) {
      hitPageCap = true;
    }
  }

  // 禁止把「请求失败/中断」伪装成「真的没有已平仓」（否则胜率被写成 null）
  if (!fetchedAnyPage) {
    throw fatalError ?? new Error('closed-positions fetch failed with no pages');
  }

  const capped = Boolean(hitPageCap || (timedOut && !windowComplete));
  return {
    rows,
    meta: {
      rowCount: rows.length,
      pageCount,
      capped,
      timedOut,
      windowComplete,
      nextPage,
      startPage,
      windowDays: windowDays ?? 0,
      fetchOk: true,
    },
  };
}

/** 官网 profile「预测」次数，对应 HTML user-stats.trades */
export async function fetchDataApiTradedCount(userAddress: string): Promise<number | null> {
  const params = new URLSearchParams({ user: userAddress.toLowerCase() });
  let res: Response;
  try {
    res = await safeFetch(
      `${DATA_API_BASE}/traded?${params}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(DATA_API_FETCH_TIMEOUT_MS),
      },
      polymarketApiSafeFetchOptions()
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as DataApiTradedResponse | null;
  const traded = data?.traded;
  return typeof traded === 'number' && Number.isFinite(traded) && traded >= 0
    ? Math.trunc(traded)
    : null;
}
