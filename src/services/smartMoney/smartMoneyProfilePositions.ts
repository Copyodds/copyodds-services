import {
  fetchDataApiPositions,
  type DataApiPosition,
} from '../polymarket/polymarketData';

/** 地址详情页持仓：略长于通用 Data API 缓存，减少热门地址重复打上游 */
const PROFILE_POSITIONS_CACHE_TTL_MS = 90_000;
const PROFILE_POSITIONS_CACHE_MAX_ENTRIES = 256;
const DEFAULT_POSITION_LIMIT = 200;
const MAX_POSITION_LIMIT = 500;

type ProfilePositionsCacheEntry = {
  expiresAt: number;
  positions: DataApiPosition[];
  fetchedAt: string;
};

const profilePositionsCache = new Map<string, ProfilePositionsCacheEntry>();

export type SmartMoneyProfilePositionsFetchErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown';

export class SmartMoneyProfilePositionsFetchError extends Error {
  readonly kind: SmartMoneyProfilePositionsFetchErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterSec: number | null;

  constructor(
    kind: SmartMoneyProfilePositionsFetchErrorKind,
    message: string,
    options?: { retryable?: boolean; status?: number | null; retryAfterSec?: number | null }
  ) {
    super(message);
    this.name = 'SmartMoneyProfilePositionsFetchError';
    this.kind = kind;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status ?? null;
    this.retryAfterSec = options?.retryAfterSec ?? null;
  }
}

export type SmartMoneyProfilePositionItem = {
  asset: string;
  conditionId: string;
  title: string | null;
  slug: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  oppositeOutcome: string | null;
  size: number;
  avgPrice: number | null;
  curPrice: number | null;
  currentValue: number | null;
  costBasis: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlRatio: number | null;
  redeemable: boolean;
  endDate: string | null;
};

export type SmartMoneyProfilePositionsSummary = {
  positionCount: number;
  activeCount: number;
  redeemableCount: number;
  totalCurrentValue: number | null;
  totalCostBasis: number | null;
  totalUnrealizedPnl: number | null;
};

export type SmartMoneyProfilePositionsResult = {
  wallet: string;
  summary: SmartMoneyProfilePositionsSummary;
  positions: SmartMoneyProfilePositionItem[];
  meta: {
    fetchedAt: string;
    cacheHit: boolean;
    limit: number;
    offset: number;
    total: number;
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

function roundMetric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function profilePositionsCacheKey(wallet: string): string {
  return normalizeWallet(wallet);
}

function readProfilePositionsCache(wallet: string): ProfilePositionsCacheEntry | null {
  const key = profilePositionsCacheKey(wallet);
  const entry = profilePositionsCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    profilePositionsCache.delete(key);
    return null;
  }
  return entry;
}

function writeProfilePositionsCache(wallet: string, positions: DataApiPosition[], fetchedAt: string): void {
  const key = profilePositionsCacheKey(wallet);
  if (profilePositionsCache.size >= PROFILE_POSITIONS_CACHE_MAX_ENTRIES) {
    const oldestKey = profilePositionsCache.keys().next().value;
    if (oldestKey) profilePositionsCache.delete(oldestKey);
  }
  profilePositionsCache.set(key, {
    expiresAt: Date.now() + PROFILE_POSITIONS_CACHE_TTL_MS,
    positions,
    fetchedAt,
  });
}

export function classifyDataApiPositionsError(error: unknown): SmartMoneyProfilePositionsFetchError {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/Data API positions (\d{3})/i);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : null;

  if (status === 429 || /too many requests|rate limit/i.test(message)) {
    return new SmartMoneyProfilePositionsFetchError('rate_limit', message, {
      retryable: true,
      status: status ?? 429,
    });
  }
  if (/timeout|AbortError|TimeoutError/i.test(message)) {
    return new SmartMoneyProfilePositionsFetchError('timeout', message, {
      retryable: true,
      status,
    });
  }
  if (status != null && status >= 500) {
    return new SmartMoneyProfilePositionsFetchError('server', message, {
      retryable: true,
      status,
    });
  }
  if (/network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return new SmartMoneyProfilePositionsFetchError('network', message, {
      retryable: true,
      status,
    });
  }
  return new SmartMoneyProfilePositionsFetchError('unknown', message, {
    retryable: false,
    status,
  });
}

/** 市值低于该阈值视为已归零（含结算失败仓、dust），不在详情持仓中展示 */
const MIN_DISPLAY_POSITION_VALUE_USD = 0.01;

export function isDisplayableOpenPosition(row: DataApiPosition): boolean {
  const size = numberFromUnknown(row.size) ?? 0;
  if (!(size > 0)) return false;

  const currentValue = numberFromUnknown(row.currentValue);
  if (currentValue != null) {
    return currentValue >= MIN_DISPLAY_POSITION_VALUE_USD;
  }

  const curPrice = numberFromUnknown(row.curPrice);
  if (curPrice != null) {
    return size * curPrice >= MIN_DISPLAY_POSITION_VALUE_USD;
  }

  // 无市值/现价时不展示，避免把已归零仓当成有效持仓
  return false;
}

export function formatSmartMoneyProfilePosition(row: DataApiPosition): SmartMoneyProfilePositionItem {
  const size = numberFromUnknown(row.size) ?? 0;
  const avgPrice = numberFromUnknown(row.avgPrice);
  const curPrice = numberFromUnknown(row.curPrice);
  const currentValue =
    numberFromUnknown(row.currentValue) ??
    (curPrice != null && size > 0 ? roundMetric(size * curPrice) : null);
  const costBasis =
    avgPrice != null && size > 0 ? roundMetric(size * avgPrice) : null;
  const unrealizedPnl =
    currentValue != null && costBasis != null ? roundMetric(currentValue - costBasis) : null;
  const unrealizedPnlRatio =
    unrealizedPnl != null && costBasis != null && costBasis > 0
      ? roundMetric(unrealizedPnl / costBasis)
      : null;

  return {
    asset: row.asset,
    conditionId: row.conditionId,
    title: typeof row.title === 'string' ? row.title : null,
    slug: typeof row.slug === 'string' ? row.slug : null,
    outcome: typeof row.outcome === 'string' ? row.outcome : null,
    outcomeIndex: numberFromUnknown(row.outcomeIndex),
    oppositeOutcome: typeof row.oppositeOutcome === 'string' ? row.oppositeOutcome : null,
    size: roundMetric(size) ?? 0,
    avgPrice: roundMetric(avgPrice),
    curPrice: roundMetric(curPrice),
    currentValue: roundMetric(currentValue),
    costBasis,
    unrealizedPnl,
    unrealizedPnlRatio,
    redeemable: row.redeemable === true,
    endDate: typeof row.endDate === 'string' ? row.endDate : null,
  };
}

function comparePositionsByValue(
  left: SmartMoneyProfilePositionItem,
  right: SmartMoneyProfilePositionItem
): number {
  const leftValue = left.currentValue ?? 0;
  const rightValue = right.currentValue ?? 0;
  if (rightValue !== leftValue) return rightValue - leftValue;
  return right.size - left.size;
}

export function buildSmartMoneyProfilePositionsResponse(params: {
  wallet: string;
  rows: DataApiPosition[];
  fetchedAt: string;
  cacheHit: boolean;
  limit: number;
  offset: number;
}): SmartMoneyProfilePositionsResult {
  const formatted = params.rows
    .filter(isDisplayableOpenPosition)
    .map(formatSmartMoneyProfilePosition)
    .sort(comparePositionsByValue);

  let totalCurrentValue = 0;
  let totalCostBasis = 0;
  let hasCurrentValue = false;
  let hasCostBasis = false;
  let activeCount = 0;
  let redeemableCount = 0;

  for (const position of formatted) {
    if (!position.redeemable) activeCount += 1;
    if (position.redeemable) redeemableCount += 1;
    if (position.currentValue != null) {
      totalCurrentValue += position.currentValue;
      hasCurrentValue = true;
    }
    if (position.costBasis != null) {
      totalCostBasis += position.costBasis;
      hasCostBasis = true;
    }
  }

  const total = formatted.length;
  const page = formatted.slice(params.offset, params.offset + params.limit);

  return {
    wallet: normalizeWallet(params.wallet),
    summary: {
      positionCount: total,
      activeCount,
      redeemableCount,
      totalCurrentValue: hasCurrentValue ? roundMetric(totalCurrentValue) : null,
      totalCostBasis: hasCostBasis ? roundMetric(totalCostBasis) : null,
      totalUnrealizedPnl:
        hasCurrentValue && hasCostBasis
          ? roundMetric(totalCurrentValue - totalCostBasis)
          : null,
    },
    positions: page,
    meta: {
      fetchedAt: params.fetchedAt,
      cacheHit: params.cacheHit,
      limit: params.limit,
      offset: params.offset,
      total,
    },
  };
}

async function loadWalletPositions(wallet: string): Promise<{
  rows: DataApiPosition[];
  fetchedAt: string;
  cacheHit: boolean;
}> {
  const cached = readProfilePositionsCache(wallet);
  if (cached) {
    return {
      rows: cached.positions,
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
    };
  }

  const fetchedAt = new Date().toISOString();
  let rows: DataApiPosition[];
  try {
    rows = await fetchDataApiPositions(wallet, {
      limit: MAX_POSITION_LIMIT,
      sizeThreshold: 0,
    });
  } catch (error) {
    throw classifyDataApiPositionsError(error);
  }

  writeProfilePositionsCache(wallet, rows, fetchedAt);
  return { rows, fetchedAt, cacheHit: false };
}

export async function getSmartMoneyProfilePositions(
  wallet: string,
  options?: { limit?: number; offset?: number }
): Promise<SmartMoneyProfilePositionsResult> {
  const limit = Math.max(1, Math.min(MAX_POSITION_LIMIT, options?.limit ?? DEFAULT_POSITION_LIMIT));
  const offset = Math.max(0, options?.offset ?? 0);
  const normalizedWallet = normalizeWallet(wallet);
  const loaded = await loadWalletPositions(normalizedWallet);

  return buildSmartMoneyProfilePositionsResponse({
    wallet: normalizedWallet,
    rows: loaded.rows,
    fetchedAt: loaded.fetchedAt,
    cacheHit: loaded.cacheHit,
    limit,
    offset,
  });
}

/** 测试用：清空进程内缓存 */
export function clearSmartMoneyProfilePositionsCacheForTests(): void {
  profilePositionsCache.clear();
}
