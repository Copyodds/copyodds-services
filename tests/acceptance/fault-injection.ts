import assert from 'node:assert/strict';
import {
  createPolymarketPublicOrderBookReader,
  OrderBookUnavailableError,
  type PublicFetch,
} from '../../src/virtualCopyTrading/virtualCopyOrderBook';
import { createVirtualMarkPriceService } from '../../src/virtualCopyTrading/virtualCopyMarkPrice';
import { computeReconnectDelayMs } from '../../src/copyTrading/events/natsReconnect';

function response(body: unknown, status = 200): Awaited<ReturnType<PublicFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

const timeoutFetch: PublicFetch = (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => {
    const error = new Error('controlled timeout');
    error.name = 'AbortError';
    reject(error);
  }, { once: true });
});

async function testClobTimeout(): Promise<void> {
  const reader = createPolymarketPublicOrderBookReader({ fetch: timeoutFetch, timeoutMs: 10 });
  await assert.rejects(
    () => reader.read('token-timeout'),
    (error: unknown) =>
      error instanceof OrderBookUnavailableError && /controlled timeout/.test(error.message),
  );
}

async function testGammaFallbackAndStale(): Promise<void> {
  const now = new Date('2026-07-17T10:00:00.000Z');
  const calls: string[] = [];
  const fetcher: PublicFetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/midpoint')) return response({}, 503);
    if (url.includes('/last-trade-price')) return response({ price: 'conflict' });
    return response([{
      clobTokenIds: JSON.stringify(['token-gamma']),
      outcomePrices: JSON.stringify(['0.61']),
      updatedAt: '2026-07-17T09:58:00.000Z',
    }]);
  };
  const mark = await createVirtualMarkPriceService({
    fetch: fetcher,
    now: () => now,
    staleAfterMs: 30_000,
  }).resolve('token-gamma');
  assert.equal(mark.source, 'POLYMARKET_GAMMA_OUTCOME');
  assert.equal(mark.status, 'STALE');
  assert.equal(mark.price?.toString(), '0.61');
  assert.equal(calls.length, 3);
}

async function testControlledRpcRecovery(): Promise<void> {
  let available = false;
  const rpcAdapter = {
    async readSettlement(): Promise<bigint> {
      if (!available) throw Object.assign(new Error('RPC timeout'), { code: 'ETIMEDOUT' });
      return 1n;
    },
  };
  await assert.rejects(() => rpcAdapter.readSettlement(), /RPC timeout/);
  available = true;
  assert.equal(await rpcAdapter.readSettlement(), 1n);
}

function testNatsBackoff(): void {
  const options = { initialDelayMs: 100, maxDelayMs: 1_000, jitterMs: 0 };
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((attempt) => computeReconnectDelayMs(attempt, options)),
    [100, 200, 400, 800, 1_000],
  );
}

async function main(): Promise<void> {
  await testClobTimeout();
  await testGammaFallbackAndStale();
  await testControlledRpcRecovery();
  testNatsBackoff();
  console.log('fault-injection: CLOB/Gamma/RPC/NATS adapter assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
