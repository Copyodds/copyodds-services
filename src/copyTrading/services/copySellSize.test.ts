import assert from 'node:assert/strict';
import { isCopySellFillComplete, resolveCopySellSize, sharesFilledEnough } from './copySellSize';

assert.equal(
  resolveCopySellSize({
    formulaSize: 0.12,
    availableSize: 1.0753,
  }),
  1.0753
);

assert.equal(
  resolveCopySellSize({
    formulaSize: 0.12,
    availableSize: 1.063831,
  }),
  1.063831
);

assert.equal(
  resolveCopySellSize({
    formulaSize: 5,
    availableSize: 3.15625,
  }),
  3.15625
);

assert.equal(
  resolveCopySellSize({
    formulaSize: 0.129,
    availableSize: 0,
  }),
  0
);

assert.equal(
  resolveCopySellSize({
    formulaSize: 0.12,
    availableSize: null,
  }),
  0.12
);

assert.equal(
  resolveCopySellSize({
    formulaSize: 0,
    availableSize: null,
  }),
  0
);

assert.equal(sharesFilledEnough(1.0638, 1.063831), true);
assert.equal(sharesFilledEnough(1.0638, 1.13), false);

assert.equal(
  isCopySellFillComplete({
    requestedSize: 1.13,
    filledSize: 1.0638,
    copyLotBefore: 1.0638,
    copyLotAfter: 0,
    accountPositionAfter: 0,
  }),
  true
);

assert.equal(
  isCopySellFillComplete({
    requestedSize: 1.13,
    filledSize: 0.5,
    copyLotBefore: 1.0638,
    copyLotAfter: 0.5638,
    accountPositionAfter: 0.5638,
  }),
  false
);

assert.equal(
  isCopySellFillComplete({
    requestedSize: 1.13,
    filledSize: 1.12,
    copyLotBefore: 1.1277,
    copyLotAfter: 0.0077,
    accountPositionAfter: 0,
  }),
  true
);

console.log('copySellSize.test.ts: ok');
