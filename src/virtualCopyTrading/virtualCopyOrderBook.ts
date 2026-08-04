import { Prisma } from '../generated/prisma/client';
import { observeExternalRequest } from '../observability/virtualCopyMetrics';
import { D, type DecimalValue, ZERO } from './virtualCopyMath';

export type PublicFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export type OrderBookLevel = {
  price: Prisma.Decimal;
  size: Prisma.Decimal;
};

export type TrustedOrderBook = {
  tokenId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  source: 'POLYMARKET_CLOB_PUBLIC_BOOK';
  observedAt: Date;
};

export type OrderBookWalkResult = {
  filledSize: Prisma.Decimal;
  unfilledSize: Prisma.Decimal;
  averagePrice: Prisma.Decimal;
  grossNotionalUsd: Prisma.Decimal;
  slippageRate: Prisma.Decimal;
  slippageBps: number;
  status: 'FILLED' | 'PARTIALLY_FILLED';
  consumedLevels: number;
  limitPrice: Prisma.Decimal;
};

export class OrderBookUnavailableError extends Error {
  readonly code = 'virtual_order_book_unavailable';
}

type RawLevel = { price?: unknown; size?: unknown } | [unknown, unknown];

function parseLevel(value: unknown): OrderBookLevel | null {
  if (!value || (!Array.isArray(value) && typeof value !== 'object')) return null;
  const raw = value as RawLevel;
  const priceRaw = Array.isArray(raw) ? raw[0] : raw.price;
  const sizeRaw = Array.isArray(raw) ? raw[1] : raw.size;
  try {
    const price = D(String(priceRaw));
    const size = D(String(sizeRaw));
    if (price.lte(0) || price.gte(1) || size.lte(0)) return null;
    return { price, size };
  } catch {
    return null;
  }
}

function parseLevels(value: unknown, side: 'bids' | 'asks'): OrderBookLevel[] {
  if (!Array.isArray(value)) return [];
  const levels = value.map(parseLevel).filter((level): level is OrderBookLevel => level != null);
  return levels.sort((a, b) =>
    side === 'asks' ? a.price.comparedTo(b.price) : b.price.comparedTo(a.price),
  );
}

export function parseTrustedOrderBook(tokenId: string, payload: unknown, observedAt: Date): TrustedOrderBook {
  if (!payload || typeof payload !== 'object') {
    throw new OrderBookUnavailableError('Polymarket CLOB returned an invalid order book payload');
  }
  const row = payload as Record<string, unknown>;
  const bids = parseLevels(row.bids, 'bids');
  const asks = parseLevels(row.asks, 'asks');
  if (bids.length === 0 && asks.length === 0) {
    throw new OrderBookUnavailableError('Polymarket CLOB returned no trusted order book levels');
  }
  return {
    tokenId,
    bids,
    asks,
    source: 'POLYMARKET_CLOB_PUBLIC_BOOK',
    observedAt,
  };
}

/**
 * Walks only executable levels inside the strict leader-relative limit.
 * Liquidity beyond the limit is never averaged into a fill.
 */
export function walkOrderBook(params: {
  book: TrustedOrderBook;
  side: 'BUY' | 'SELL';
  targetSize: DecimalValue;
  referencePrice: DecimalValue;
  maxSlippage: DecimalValue;
}): OrderBookWalkResult | null {
  const target = D(params.targetSize);
  const reference = D(params.referencePrice);
  const maxSlippage = D(params.maxSlippage);
  if (target.lte(0) || reference.lte(0) || reference.gte(1) || maxSlippage.lt(0)) return null;

  const levels = params.side === 'BUY' ? params.book.asks : params.book.bids;
  const limitPrice = params.side === 'BUY'
    ? Prisma.Decimal.min(D('0.99'), reference.mul(D(1).add(maxSlippage)))
    : Prisma.Decimal.max(D('0.01'), reference.mul(D(1).sub(maxSlippage)));
  let remaining = target;
  let notional = ZERO;
  let consumedLevels = 0;
  for (const level of levels) {
    const outsideLimit = params.side === 'BUY'
      ? level.price.gt(limitPrice)
      : level.price.lt(limitPrice);
    if (outsideLimit) break;
    const size = Prisma.Decimal.min(remaining, level.size);
    if (size.lte(0)) continue;
    remaining = remaining.sub(size);
    notional = notional.add(size.mul(level.price));
    consumedLevels += 1;
    if (remaining.lte(0)) break;
  }
  const filledSize = target.sub(remaining);
  if (filledSize.lte(0)) return null;
  const averagePrice = notional.div(filledSize);
  const adverse = params.side === 'BUY'
    ? averagePrice.sub(reference).div(reference)
    : reference.sub(averagePrice).div(reference);
  const slippageRate = Prisma.Decimal.max(ZERO, adverse);
  return {
    filledSize,
    unfilledSize: remaining,
    averagePrice,
    grossNotionalUsd: notional,
    slippageRate,
    slippageBps: Math.round(slippageRate.mul(10_000).toNumber()),
    status: remaining.gt(0) ? 'PARTIALLY_FILLED' : 'FILLED',
    consumedLevels,
    limitPrice,
  };
}

export interface VirtualCopyOrderBookReader {
  read(tokenId: string): Promise<TrustedOrderBook>;
}

export function createPolymarketPublicOrderBookReader(options: {
  fetch?: PublicFetch;
  clobHost?: string;
  timeoutMs?: number;
  now?: () => Date;
} = {}): VirtualCopyOrderBookReader {
  const fetcher = options.fetch ?? globalThis.fetch;
  const host = (options.clobHost ?? 'https://clob.polymarket.com').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 8_000;
  const now = options.now ?? (() => new Date());
  return {
    async read(tokenId: string) {
      const normalized = tokenId.trim();
      if (!normalized) throw new OrderBookUnavailableError('tokenId is required for order book lookup');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = performance.now();
      let result: 'success' | 'empty' | 'http_error' | 'timeout' | 'error' = 'error';
      try {
        const url = `${host}/book?token_id=${encodeURIComponent(normalized)}`;
        const response = await fetcher(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          result = 'http_error';
          throw new OrderBookUnavailableError(`Polymarket CLOB order book HTTP ${response.status}`);
        }
        const book = parseTrustedOrderBook(normalized, await response.json(), now());
        result = 'success';
        return book;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') result = 'timeout';
        if (error instanceof OrderBookUnavailableError) throw error;
        throw new OrderBookUnavailableError(
          `Polymarket CLOB order book request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timeout);
        observeExternalRequest('clob', 'order_book', startedAt, result);
      }
    },
  };
}
