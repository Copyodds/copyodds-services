import assert from 'node:assert/strict';
import { createPolymarketPublicOrderBookReader, walkOrderBook } from './virtualCopyOrderBook';

const observedAt = new Date('2026-07-17T08:00:00.000Z');
const reader = createPolymarketPublicOrderBookReader({
  now: () => observedAt,
  fetch: async (input, init) => {
    assert.match(String(input), /\/book\?token_id=token-yes$/);
    assert.equal(new Headers(init?.headers).has('authorization'), false, 'public reader must not use credentials');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          bids: [{ price: '0.49', size: '3' }, { price: '0.48', size: '20' }],
          asks: [{ price: '0.51', size: '2' }, { price: '0.52', size: '3' }, { price: '0.54', size: '20' }],
        };
      },
    };
  },
});

async function main() {
  const book = await reader.read('token-yes');
  assert.equal(book.observedAt, observedAt);
  const buy = walkOrderBook({
    book,
    side: 'BUY',
    targetSize: '10',
    referencePrice: '0.5',
    maxSlippage: '0.05',
  });
  assert.ok(buy);
  assert.equal(buy.status, 'PARTIALLY_FILLED');
  assert.equal(buy.filledSize.toString(), '5');
  assert.equal(buy.averagePrice.toString(), '0.516');
  assert.equal(buy.unfilledSize.toString(), '5');
  assert.equal(buy.consumedLevels, 2);

  const sell = walkOrderBook({
    book,
    side: 'SELL',
    targetSize: '10',
    referencePrice: '0.5',
    maxSlippage: '0.03',
  });
  assert.ok(sell);
  assert.equal(sell.filledSize.toString(), '3', 'bid below the strict 0.485 limit must not fill');
  assert.equal(sell.averagePrice.toString(), '0.49');

  assert.equal(
    walkOrderBook({
      book,
      side: 'BUY',
      targetSize: '1',
      referencePrice: '0.5',
      maxSlippage: '0.01',
    }),
    null,
    'no formula or leader-price fallback is allowed when the book is outside the limit',
  );

  console.log('virtual copy order book tests passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
