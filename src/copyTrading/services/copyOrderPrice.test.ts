import assert from 'node:assert/strict';
import {
  applyCopySlippageToPrice,
  computeCopyRiskNotionalUsd,
  isCopyOrderPriceWithinSlippage,
  resolveCopyOrderPrice,
} from './copyOrderPrice';

assert.ok(Math.abs(resolveCopyOrderPrice(0.962, 'SELL', 0.05) - 0.9139) < 1e-9);
assert.equal(resolveCopyOrderPrice(0.966, 'BUY', 0.05), 0.99);

assert.equal(applyCopySlippageToPrice(0.5, 'BUY', 0.1), 0.55);
assert.equal(applyCopySlippageToPrice(0.5, 'SELL', 0.1), 0.45);
assert.equal(applyCopySlippageToPrice(0.5, 'SELL', null), 0.5);
assert.equal(applyCopySlippageToPrice(2.350266, 'BUY', null), 0.99);
assert.equal(applyCopySlippageToPrice(0.002, 'SELL', null), 0.01);
assert.equal(computeCopyRiskNotionalUsd({ size: 3.15625, orderPrice: 0.55 }), 3.15625 * 0.55);

assert.equal(
  isCopyOrderPriceWithinSlippage({
    side: 'BUY',
    leaderPrice: 0.5,
    orderPrice: 0.55,
    slippage: 0.1,
  }),
  true
);
assert.equal(
  isCopyOrderPriceWithinSlippage({
    side: 'BUY',
    leaderPrice: 0.5,
    orderPrice: 0.56,
    slippage: 0.1,
  }),
  false
);
assert.equal(
  isCopyOrderPriceWithinSlippage({
    side: 'SELL',
    leaderPrice: 0.5,
    orderPrice: 0.45,
    slippage: 0.1,
  }),
  true
);
assert.equal(
  isCopyOrderPriceWithinSlippage({
    side: 'SELL',
    leaderPrice: 0.5,
    orderPrice: 0.55,
    slippage: 0.1,
  }),
  false
);

console.log('copyOrderPrice.test.ts: ok');
