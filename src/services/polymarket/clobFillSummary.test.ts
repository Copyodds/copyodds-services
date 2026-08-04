import assert from 'node:assert/strict';
import {
  getClobOrderFillSummary,
  isMarketSellFloorPrice,
  mergeClobFillFromOpenOrder,
  mergeClobFillFromTrades,
  sanitizeCopyBuyFillAgainstIntent,
} from './clobFillSummary';

assert.equal(getClobOrderFillSummary(null, 'BUY').filled, false);
assert.equal(isMarketSellFloorPrice(0.01), true);
assert.equal(isMarketSellFloorPrice(0.49), false);

assert.deepEqual(
  getClobOrderFillSummary(
    {
      orderID: '0xabc',
      takingAmount: '1.3291',
      makingAmount: '1.05',
      status: 'matched',
    },
    'BUY'
  ),
  {
    filled: true,
    size: 1.3291,
    notional: 1.05,
    avgPrice: 1.05 / 1.3291,
  }
);

// 市价卖：getOrder 只有 size_matched + 地板价 0.01 → 有成交量但无虚假 notional
const sellFloorMerged = mergeClobFillFromOpenOrder(
  { orderID: '0xsell', success: true },
  { size_matched: '2.23', price: '0.01', status: 'MATCHED' },
  'SELL'
);
const sellFloorFill = getClobOrderFillSummary(sellFloorMerged, 'SELL');
assert.equal(sellFloorFill.filled, true);
assert.ok(sellFloorFill.size != null && Math.abs(sellFloorFill.size - 2.23) < 1e-9);
assert.equal(sellFloorFill.notional, undefined);
assert.equal(sellFloorFill.avgPrice, undefined);

// trades 补真实成交价
const sellWithTrades = mergeClobFillFromTrades(
  sellFloorMerged,
  [{ taker_order_id: '0xsell', size: '2.23', price: '0.48' }],
  'SELL',
  '0xsell'
);
const sellReal = getClobOrderFillSummary(sellWithTrades, 'SELL');
assert.equal(sellReal.filled, true);
assert.ok(sellReal.avgPrice != null && Math.abs(sellReal.avgPrice - 0.48) < 1e-9);
assert.ok(sellReal.notional != null && Math.abs(sellReal.notional - 2.23 * 0.48) < 1e-6);

const buyMerged = mergeClobFillFromOpenOrder(
  { orderID: '0xe39f', takingAmount: '', makingAmount: '', success: true },
  { size_matched: '1.3291', price: '0.7899', status: 'MATCHED', associate_trades: ['t1'] },
  'BUY'
);
const recovered = getClobOrderFillSummary(buyMerged, 'BUY');
assert.equal(recovered.filled, true);
assert.ok(recovered.size != null && Math.abs(recovered.size - 1.3291) < 1e-9);

// Inflated BUY fill: intended ~$1.05 / ~9.09 shares, CLOB parsed as 1050 shares.
const sanitized = sanitizeCopyBuyFillAgainstIntent({
  fillSize: 1050,
  fillNotional: 120.75,
  intendedSize: 9.090992,
  intendedNotionalUsd: 1.05,
  executionPrice: 0.115,
});
assert.equal(sanitized.corrected, true);
assert.ok(Math.abs(sanitized.size - 1.05 / 0.115) < 1e-6);
assert.equal(sanitized.notional, 1.05);

const sane = sanitizeCopyBuyFillAgainstIntent({
  fillSize: 9.09,
  fillNotional: 1.05,
  intendedSize: 9.090992,
  intendedNotionalUsd: 1.05,
  executionPrice: 0.115,
});
assert.equal(sane.corrected, false);
assert.ok(Math.abs(sane.size - 9.09) < 1e-9);

console.log('clobFillSummary.test.ts: ok');
