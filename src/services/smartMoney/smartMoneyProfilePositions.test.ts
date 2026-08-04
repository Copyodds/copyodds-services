import assert from 'node:assert/strict';
import {
  buildSmartMoneyProfilePositionsResponse,
  classifyDataApiPositionsError,
  formatSmartMoneyProfilePosition,
  isDisplayableOpenPosition,
} from './smartMoneyProfilePositions';
import type { DataApiPosition } from '../polymarket/polymarketData';

function row(partial: Partial<DataApiPosition> & Pick<DataApiPosition, 'asset' | 'conditionId'>): DataApiPosition {
  return {
    size: 0,
    redeemable: false,
    ...partial,
  };
}

assert.equal(isDisplayableOpenPosition(row({ asset: 'a', conditionId: 'c', size: 0 })), false);
assert.equal(
  isDisplayableOpenPosition(row({ asset: 'a', conditionId: 'c', size: 0, currentValue: 0.02 })),
  false
);
assert.equal(
  isDisplayableOpenPosition(row({ asset: 'a', conditionId: 'c', size: 1, currentValue: 0 })),
  false,
  'zeroed-out positions should be hidden'
);
assert.equal(
  isDisplayableOpenPosition(
    row({ asset: 'a', conditionId: 'c', size: 0.941, curPrice: 0, currentValue: 0, redeemable: true })
  ),
  false
);
assert.equal(
  isDisplayableOpenPosition(row({ asset: 'a', conditionId: 'c', size: 1, currentValue: 0.005 })),
  false,
  'dust value below $0.01 should be hidden'
);
assert.equal(
  isDisplayableOpenPosition(row({ asset: 'a', conditionId: 'c', size: 1, currentValue: 0.02 })),
  true
);
assert.equal(
  isDisplayableOpenPosition(row({ asset: 'a', conditionId: 'c', size: 10, curPrice: 0.5 })),
  true
);
assert.equal(
  isDisplayableOpenPosition(row({ asset: 'a', conditionId: 'c', size: 1 })),
  false,
  'size alone without value/price should not display'
);

const formatted = formatSmartMoneyProfilePosition(
  row({
    asset: 'token-a',
    conditionId: 'cond-a',
    title: 'Will X happen?',
    outcome: 'Yes',
    size: 100,
    avgPrice: 0.4,
    curPrice: 0.55,
    redeemable: false,
    endDate: '2026-12-31',
  })
);
assert.equal(formatted.currentValue, 55);
assert.equal(formatted.costBasis, 40);
assert.equal(formatted.unrealizedPnl, 15);
assert.equal(formatted.unrealizedPnlRatio, 0.375);

const response = buildSmartMoneyProfilePositionsResponse({
  wallet: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
  rows: [
    row({
      asset: 'low',
      conditionId: 'c1',
      size: 10,
      curPrice: 0.2,
      currentValue: 2,
      redeemable: false,
    }),
    row({
      asset: 'high',
      conditionId: 'c2',
      size: 50,
      curPrice: 0.8,
      currentValue: 40,
      redeemable: true,
    }),
    row({
      asset: 'dust',
      conditionId: 'c3',
      size: 0,
      currentValue: 0,
    }),
    row({
      asset: 'zeroed',
      conditionId: 'c4',
      size: 0.941,
      curPrice: 0,
      currentValue: 0,
      redeemable: true,
    }),
  ],
  fetchedAt: '2026-07-10T00:00:00.000Z',
  cacheHit: false,
  limit: 10,
  offset: 0,
});

assert.equal(response.summary.positionCount, 2);
assert.equal(response.summary.activeCount, 1);
assert.equal(response.summary.redeemableCount, 1);
assert.equal(response.summary.totalCurrentValue, 42);
assert.equal(response.positions[0].asset, 'high');
assert.equal(response.positions[1].asset, 'low');
assert.ok(!response.positions.some((p) => p.asset === 'zeroed'));
assert.equal(response.wallet, '0xabcdef1234567890abcdef1234567890abcdef12');

const paged = buildSmartMoneyProfilePositionsResponse({
  wallet: '0xabcdef1234567890abcdef1234567890abcdef12',
  rows: response.positions.map((position, index) =>
    row({
      asset: position.asset,
      conditionId: `c${index}`,
      size: position.size,
      currentValue: position.currentValue ?? undefined,
      redeemable: position.redeemable,
    })
  ),
  fetchedAt: '2026-07-10T00:00:00.000Z',
  cacheHit: true,
  limit: 1,
  offset: 1,
});
assert.equal(paged.positions.length, 1);
assert.equal(paged.meta.total, 2);
assert.equal(paged.meta.cacheHit, true);

const rateLimitError = classifyDataApiPositionsError(
  new Error('Data API positions 429: too many requests')
);
assert.equal(rateLimitError.kind, 'rate_limit');
assert.equal(rateLimitError.retryable, true);

const timeoutError = classifyDataApiPositionsError(
  new Error('Data API positions timeout after 15000ms (upstream data-api.polymarket.com)')
);
assert.equal(timeoutError.kind, 'timeout');
assert.equal(timeoutError.retryable, true);

console.log('smartMoneyProfilePositions.test.ts: ok');
