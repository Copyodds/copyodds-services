import assert from 'node:assert/strict';
import { computeRatioBuySize } from './copyRatioSizing.js';

assert.equal(computeRatioBuySize({ availableUsd: 1000, copyRatio: 0.1, price: 0.5 }), 200);
assert.equal(computeRatioBuySize({ availableUsd: 100, copyRatio: 1, price: 0.25 }), 400);
assert.equal(computeRatioBuySize({ availableUsd: 0, copyRatio: 0.1, price: 0.5 }), 0);
assert.equal(computeRatioBuySize({ availableUsd: 1000, copyRatio: 0, price: 0.5 }), 0);
assert.equal(computeRatioBuySize({ availableUsd: 1000, copyRatio: 0.1, price: 0 }), 0);
assert.equal(computeRatioBuySize({ availableUsd: -1, copyRatio: 0.1, price: 0.5 }), 0);

console.log('copyRatioSizing.test.ts: ok');
