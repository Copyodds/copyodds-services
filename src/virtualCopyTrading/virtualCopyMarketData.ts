import { CONFIG } from '../config/env';
import {
  createVirtualMarkPriceService,
  type VirtualMarkPriceResolver,
} from './virtualCopyMarkPrice';
import {
  createPolymarketPublicOrderBookReader,
  type VirtualCopyOrderBookReader,
} from './virtualCopyOrderBook';

const defaultOrderBookReader = createPolymarketPublicOrderBookReader({
  clobHost: CONFIG.clobHost,
  timeoutMs: CONFIG.virtualCopyMarketDataTimeoutMs,
});
const defaultMarkPriceResolver = createVirtualMarkPriceService({
  clobHost: CONFIG.clobHost,
  timeoutMs: CONFIG.virtualCopyMarketDataTimeoutMs,
  staleAfterMs: CONFIG.virtualCopyMarkStaleMs,
});

let orderBookReader = defaultOrderBookReader;
let markPriceResolver = defaultMarkPriceResolver;

export function getVirtualCopyOrderBookReader(): VirtualCopyOrderBookReader {
  return orderBookReader;
}

export function getVirtualMarkPriceResolver(): VirtualMarkPriceResolver {
  return markPriceResolver;
}

/** Test-only dependency seam; production callers use credential-free public adapters. */
export function setVirtualCopyMarketDataAdaptersForTests(adapters: {
  orderBookReader?: VirtualCopyOrderBookReader;
  markPriceResolver?: VirtualMarkPriceResolver;
}): void {
  if (adapters.orderBookReader) orderBookReader = adapters.orderBookReader;
  if (adapters.markPriceResolver) markPriceResolver = adapters.markPriceResolver;
}

export function resetVirtualCopyMarketDataAdaptersForTests(): void {
  orderBookReader = defaultOrderBookReader;
  markPriceResolver = defaultMarkPriceResolver;
}
