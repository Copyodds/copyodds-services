import { Prisma } from '../generated/prisma/client';
import {
  observeExternalRequest,
  virtualCopyMetrics,
} from '../observability/virtualCopyMetrics';
import { D, type DecimalValue, ZERO } from './virtualCopyMath';
import type { PublicFetch } from './virtualCopyOrderBook';

export type VirtualMarkPriceSource =
  | 'POLYMARKET_CLOB_MIDPOINT'
  | 'POLYMARKET_CLOB_LAST_TRADE'
  | 'POLYMARKET_GAMMA_OUTCOME'
  | 'UNAVAILABLE';

export type VirtualMarkPrice = {
  tokenId: string;
  price: Prisma.Decimal | null;
  source: VirtualMarkPriceSource;
  asOf: Date | null;
  stalenessMs: number | null;
  status: 'FRESH' | 'DEGRADED' | 'STALE' | 'UNAVAILABLE';
  error?: string;
};

export interface VirtualMarkPriceResolver {
  resolve(tokenId: string): Promise<VirtualMarkPrice>;
}

function finitePrice(value: unknown): Prisma.Decimal | null {
  try {
    const price = D(String(value));
    return price.gte(0) && price.lte(1) ? price : null;
  } catch {
    return null;
  }
}

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value === 'number' || typeof value === 'string') {
    const numeric = Number(value);
    const date = Number.isFinite(numeric)
      ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
      : new Date(String(value));
    if (Number.isFinite(date.getTime())) return date;
  }
  return fallback;
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchJson(
  fetcher: PublicFetch,
  url: string,
  timeoutMs: number,
  service: 'clob' | 'gamma',
  operation: string,
): Promise<Record<string, unknown> | unknown[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  let result: 'success' | 'empty' | 'http_error' | 'timeout' | 'error' = 'error';
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      result = 'http_error';
      return null;
    }
    const payload: unknown = await response.json();
    const parsed = payload && typeof payload === 'object'
      ? payload as Record<string, unknown> | unknown[]
      : null;
    result = parsed ? 'success' : 'empty';
    return parsed;
  } catch (error) {
    result = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'error';
    return null;
  } finally {
    clearTimeout(timeout);
    observeExternalRequest(service, operation, startedAt, result);
  }
}

export function createVirtualMarkPriceService(options: {
  fetch?: PublicFetch;
  clobHost?: string;
  gammaHost?: string;
  timeoutMs?: number;
  staleAfterMs?: number;
  now?: () => Date;
} = {}): VirtualMarkPriceResolver {
  const fetcher = options.fetch ?? globalThis.fetch;
  const clobHost = (options.clobHost ?? 'https://clob.polymarket.com').replace(/\/+$/, '');
  const gammaHost = (options.gammaHost ?? 'https://gamma-api.polymarket.com').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 8_000;
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const now = options.now ?? (() => new Date());

  function result(
    tokenId: string,
    price: Prisma.Decimal,
    source: Exclude<VirtualMarkPriceSource, 'UNAVAILABLE'>,
    asOf: Date,
    degraded: boolean,
  ): VirtualMarkPrice {
    const stalenessMs = Math.max(0, now().getTime() - asOf.getTime());
    const mark: VirtualMarkPrice = {
      tokenId,
      price,
      source,
      asOf,
      stalenessMs,
      status: stalenessMs > staleAfterMs ? 'STALE' : degraded ? 'DEGRADED' : 'FRESH',
    };
    virtualCopyMetrics.markResults.labels(mark.source.toLowerCase(), mark.status.toLowerCase()).inc();
    if (degraded) {
      virtualCopyMetrics.degradation.labels('mark_price', 'gamma_fallback').inc();
    }
    return mark;
  }

  return {
    async resolve(tokenId: string): Promise<VirtualMarkPrice> {
      const normalized = tokenId.trim();
      if (!normalized) {
        return {
          tokenId,
          price: null,
          source: 'UNAVAILABLE',
          asOf: null,
          stalenessMs: null,
          status: 'UNAVAILABLE',
          error: 'tokenId is required',
        };
      }
      const encoded = encodeURIComponent(normalized);
      const midpointPayload = await fetchJson(
        fetcher,
        `${clobHost}/midpoint?token_id=${encoded}`,
        timeoutMs,
        'clob',
        'midpoint',
      );
      if (midpointPayload && !Array.isArray(midpointPayload)) {
        const price = finitePrice(midpointPayload.mid ?? midpointPayload.midpoint);
        if (price) {
          return result(
            normalized,
            price,
            'POLYMARKET_CLOB_MIDPOINT',
            parseDate(midpointPayload.timestamp, now()),
            false,
          );
        }
      }

      const lastPayload = await fetchJson(
        fetcher,
        `${clobHost}/last-trade-price?token_id=${encoded}`,
        timeoutMs,
        'clob',
        'last_trade',
      );
      if (lastPayload && !Array.isArray(lastPayload)) {
        const price = finitePrice(lastPayload.price);
        if (price) {
          return result(
            normalized,
            price,
            'POLYMARKET_CLOB_LAST_TRADE',
            parseDate(lastPayload.timestamp, now()),
            false,
          );
        }
      }

      const gammaPayload = await fetchJson(
        fetcher,
        `${gammaHost}/markets?clob_token_ids=${encoded}&limit=10`,
        timeoutMs,
        'gamma',
        'market',
      );
      const markets = Array.isArray(gammaPayload) ? gammaPayload : [];
      for (const marketValue of markets) {
        if (!marketValue || typeof marketValue !== 'object') continue;
        const market = marketValue as Record<string, unknown>;
        const tokenIds = arrayValue(market.clobTokenIds);
        const index = tokenIds.findIndex((value) => String(value) === normalized);
        if (index < 0) continue;
        const prices = arrayValue(market.outcomePrices);
        const price = finitePrice(prices[index]);
        if (!price) continue;
        return result(
          normalized,
          price,
          'POLYMARKET_GAMMA_OUTCOME',
          parseDate(market.updatedAt ?? market.endDate, now()),
          true,
        );
      }

      virtualCopyMetrics.markResults.labels('unavailable', 'unavailable').inc();
      virtualCopyMetrics.degradation.labels('mark_price', 'unavailable').inc();
      return {
        tokenId: normalized,
        price: null,
        source: 'UNAVAILABLE',
        asOf: null,
        stalenessMs: null,
        status: 'UNAVAILABLE',
        error: 'No CLOB midpoint/last price or Gamma outcome price is available',
      };
    },
  };
}

export type VirtualLotForValuation = {
  tokenId: string;
  remainingSize: DecimalValue;
  entryPrice: DecimalValue;
  entryFeeUsd?: DecimalValue;
};

export function valueVirtualLots(
  lots: VirtualLotForValuation[],
  marks: ReadonlyMap<string, VirtualMarkPrice>,
) {
  let positionValueUsd = ZERO;
  let costBasisUsd = ZERO;
  let unavailableCount = 0;
  const sources = new Set<VirtualMarkPriceSource>();
  let oldestAsOf: Date | null = null;
  for (const lot of lots) {
    const size = D(lot.remainingSize);
    const entryPrice = D(lot.entryPrice);
    costBasisUsd = costBasisUsd.add(size.mul(entryPrice)).add(D(lot.entryFeeUsd ?? 0));
    const mark = marks.get(lot.tokenId);
    if (mark?.price != null) {
      positionValueUsd = positionValueUsd.add(size.mul(mark.price));
      sources.add(mark.source);
      if (mark.asOf && (!oldestAsOf || mark.asOf < oldestAsOf)) oldestAsOf = mark.asOf;
    } else {
      // Keep account equity usable while explicitly reporting incomplete market data.
      positionValueUsd = positionValueUsd.add(size.mul(entryPrice));
      unavailableCount += 1;
      sources.add('UNAVAILABLE');
    }
  }
  return {
    positionValueUsd,
    costBasisUsd,
    unrealizedPnlUsd: positionValueUsd.sub(costBasisUsd),
    priceAsOf: oldestAsOf,
    priceStatus:
      lots.length === 0
        ? 'NO_OPEN_POSITIONS'
        : unavailableCount === 0
          ? 'MARKED'
          : unavailableCount === lots.length
            ? 'UNAVAILABLE_COST_BASIS'
            : 'PARTIAL_COST_BASIS',
    priceSource: sources.size === 1 ? [...sources][0] : 'MIXED',
    unavailableMarkCount: unavailableCount,
  };
}
