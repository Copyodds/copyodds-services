import {
  extractClosedPositionAtMs,
  fetchDataApiClosedPositions,
  type ClosedPositionsFetchMeta,
  type DataApiPosition,
} from '../polymarket/polymarketData';
import { loadReadyClosedFetchResult } from './smartMoneyClosedSnapshot';
import {
  formatSmartMoneyProfileClosedPosition,
  summarizeSmartMoneyProfileClosedPositions,
} from './smartMoneyProfileClosedPositionFormat';

export {
  formatSmartMoneyProfileClosedPosition,
  type SmartMoneyProfileClosedPositionItem,
} from './smartMoneyProfileClosedPositionFormat';

const CACHE_TTL_MS = 90_000;
const CACHE_MAX_ENTRIES = 256;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const LIVE_MAX_PAGES = 10;

type ClosedPositionSource = 'FULL_SNAPSHOT' | 'LIVE_API' | 'GATE_SNAPSHOT';

type LoadedClosedRows = {
  rows: DataApiPosition[];
  source: ClosedPositionSource;
  partial: boolean;
  windowDays: number | null;
  loadedAt: string;
};

type CacheEntry = LoadedClosedRows & { expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inFlightLoads = new Map<string, Promise<LoadedClosedRows>>();

export class SmartMoneyProfileClosedPositionsFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmartMoneyProfileClosedPositionsFetchError';
  }
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

function closedRowKey(row: DataApiPosition): string {
  const record = row as Record<string, unknown>;
  return [
    row.asset,
    row.conditionId,
    String(record.timestamp ?? ''),
    String(record.realizedPnl ?? record.pnl ?? ''),
  ].join(':');
}

function normalizeClosedRows(rows: DataApiPosition[]): DataApiPosition[] {
  const unique = new Map<string, DataApiPosition>();
  for (const row of rows) unique.set(closedRowKey(row), row);
  return [...unique.values()].sort(
    (left, right) =>
      (extractClosedPositionAtMs(right) ?? 0) - (extractClosedPositionAtMs(left) ?? 0)
  );
}

function isPartial(meta: ClosedPositionsFetchMeta): boolean {
  return Boolean(meta.capped || meta.timedOut || !meta.windowComplete);
}

function readCache(wallet: string, desiredRows: number): LoadedClosedRows | null {
  const entry = cache.get(wallet);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(wallet);
    return null;
  }
  if (
    entry.source === 'LIVE_API' &&
    entry.partial &&
    entry.rows.length < desiredRows &&
    entry.rows.length < LIVE_MAX_PAGES * 50
  ) {
    return null;
  }
  return entry;
}

function writeCache(wallet: string, loaded: LoadedClosedRows): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(wallet, { ...loaded, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function loadClosedRowsUncached(
  wallet: string,
  desiredRows: number
): Promise<LoadedClosedRows> {
  const full = await loadReadyClosedFetchResult(wallet, 'FULL').catch(() => null);
  if (full) {
    const loaded: LoadedClosedRows = {
      rows: normalizeClosedRows(full.rows),
      source: 'FULL_SNAPSHOT',
      partial: isPartial(full.meta),
      windowDays: full.meta.windowDays,
      loadedAt: new Date().toISOString(),
    };
    writeCache(wallet, loaded);
    return loaded;
  }

  try {
    const maxPages = Math.max(
      1,
      Math.min(LIVE_MAX_PAGES, Math.ceil(Math.max(1, desiredRows) / 50))
    );
    const live = await fetchDataApiClosedPositions(wallet, {
      limit: 50,
      maxPages,
    });
    const loaded: LoadedClosedRows = {
      rows: normalizeClosedRows(live.rows),
      source: 'LIVE_API',
      partial: isPartial(live.meta),
      windowDays: live.meta.windowDays,
      loadedAt: new Date().toISOString(),
    };
    writeCache(wallet, loaded);
    return loaded;
  } catch (error) {
    const gate = await loadReadyClosedFetchResult(wallet, 'GATE').catch(() => null);
    if (gate) {
      const loaded: LoadedClosedRows = {
        rows: normalizeClosedRows(gate.rows),
        source: 'GATE_SNAPSHOT',
        partial: true,
        windowDays: gate.meta.windowDays,
        loadedAt: new Date().toISOString(),
      };
      writeCache(wallet, loaded);
      return loaded;
    }
    throw new SmartMoneyProfileClosedPositionsFetchError(
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function loadClosedRows(wallet: string, desiredRows: number): Promise<LoadedClosedRows> {
  const cached = readCache(wallet, desiredRows);
  if (cached) return cached;

  const existing = inFlightLoads.get(wallet);
  if (existing) {
    await existing;
    const loadedAfterWait = readCache(wallet, desiredRows);
    if (loadedAfterWait) return loadedAfterWait;
    return loadClosedRows(wallet, desiredRows);
  }

  const request = loadClosedRowsUncached(wallet, desiredRows).finally(() => {
    if (inFlightLoads.get(wallet) === request) {
      inFlightLoads.delete(wallet);
    }
  });
  inFlightLoads.set(wallet, request);
  return request;
}

export async function getSmartMoneyProfileClosedPositions(
  wallet: string,
  options?: { limit?: number; offset?: number }
) {
  const normalized = normalizeWallet(wallet);
  const limit = Math.max(1, Math.min(MAX_LIMIT, options?.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, options?.offset ?? 0);
  const loaded = await loadClosedRows(normalized, offset + limit);
  const formatted = loaded.rows.map(formatSmartMoneyProfileClosedPosition);
  const items = formatted.slice(offset, offset + limit);

  return {
    wallet: normalized,
    summary: summarizeSmartMoneyProfileClosedPositions(formatted, loaded.partial),
    positions: items,
    meta: {
      source: loaded.source,
      partial: loaded.partial,
      windowDays: loaded.windowDays,
      loadedAt: loaded.loadedAt,
      limit,
      offset,
      total: formatted.length,
    },
  };
}

export function clearSmartMoneyProfileClosedPositionsCacheForTests(): void {
  cache.clear();
  inFlightLoads.clear();
}
