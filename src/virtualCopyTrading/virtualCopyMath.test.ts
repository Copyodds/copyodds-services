import assert from 'node:assert/strict';
import { quoteVirtualCopyFee, VIRTUAL_COPY_FEE_MODEL_VERSION } from './virtualCopyFeeModel';
import { D, hasSufficientVirtualCash, planFifoCloses } from './virtualCopyMath';

assert.equal(hasSufficientVirtualCash('100', '100'), true);
assert.equal(hasSufficientVirtualCash('99.999999999999999999', '100'), false);
const fee = quoteVirtualCopyFee('100', {
  version: VIRTUAL_COPY_FEE_MODEL_VERSION,
  rate: '0.002',
});
assert.equal(fee.feeUsd.toString(), '0.2');
assert.equal(fee.requiredCashUsd.toString(), '100.2');
assert.equal(fee.netProceedsUsd.toString(), '99.8');

const fifo = planFifoCloses([
  { id: 'account-a-lot-1', remainingSize: '2', entryPrice: '0.2' },
  { id: 'account-a-lot-2', remainingSize: '3', entryPrice: '0.4' },
], '4', '0.6');
assert.equal(fifo.closes.length, 2);
assert.equal(fifo.closes[0]?.lotId, 'account-a-lot-1');
assert.equal(fifo.closes[0]?.closedSize.toString(), '2');
assert.equal(fifo.closes[1]?.closedSize.toString(), '2');
assert.equal(fifo.filledSize.toString(), '4');
assert.equal(
  fifo.closes.reduce((sum, row) => sum.add(row.realizedPnlUsd), D(0)).toString(),
  '1.2',
);

const accountALots = [{ id: 'a', remainingSize: '1', entryPrice: '0.2' }];
const accountBLots = [{ id: 'b', remainingSize: '5', entryPrice: '0.1' }];
const isolated = planFifoCloses(accountALots, '3', '0.5');
assert.equal(isolated.filledSize.toString(), '1', 'SELL is clipped to selected account lots');
assert.equal(isolated.closes.some((row) => row.lotId === accountBLots[0]?.id), false);

const firstFeeClose = planFifoCloses(
  [{ id: 'fee-lot', remainingSize: '10', entryPrice: '0.5', entryFeeUsd: '1' }],
  '4',
  '0.6',
  '0.01',
);
const secondFeeClose = planFifoCloses(
  [{ id: 'fee-lot', remainingSize: '6', entryPrice: '0.5', entryFeeUsd: '0.6' }],
  '6',
  '0.6',
  '0.01',
);
assert.equal(
  firstFeeClose.closes[0]!.allocatedEntryFeeUsd
    .add(secondFeeClose.closes[0]!.allocatedEntryFeeUsd)
    .toString(),
  '1',
  'partial closes must not allocate an entry fee more than once',
);
assert.equal(firstFeeClose.closes[0]!.exitFeeUsd.toString(), '0.024');
assert.equal(
  firstFeeClose.closes[0]!.realizedPnlUsd.toString(),
  '-0.024',
  'realized PnL deducts allocated BUY fee and SELL fee',
);

const accountOneExecutionKey = ['leader-trade-1', 'subscription-account-1'].join(':');
const accountTwoExecutionKey = ['leader-trade-1', 'subscription-account-2'].join(':');
assert.notEqual(accountOneExecutionKey, accountTwoExecutionKey, 'same leader may fan out to multiple accounts');

console.log('virtual copy math tests passed');
