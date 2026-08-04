import assert from 'node:assert/strict';
import {
  isRedeemTxHashInUseSet,
  normalizeRedeemTxHash,
  partitionSharedRedeemTxRows,
  resolveProfitRedeemCloseSize,
  shouldSkipAutoRedeemAfterManualClose,
  shouldSkipManualExpiredAfterManualClose,
} from './copyRedeemSettlementGuards';

assert.equal(
  normalizeRedeemTxHash('0xAEFE453795F31E42CE061AEF24616AAB179AEBC21A77D023EFD0118ACEC304F8'),
  '0xaefe453795f31e42ce061aef24616aab179aebc21a77d023efd0118acec304f8'
);

assert.equal(
  isRedeemTxHashInUseSet(
    '0xaefe453795f31e42ce061aef24616aab179aebc21a77d023efd0118acec304f8',
    new Set(['0xaefe453795f31e42ce061aef24616aab179aebc21a77d023efd0118acec304f8'])
  ),
  true
);

assert.equal(
  resolveProfitRedeemCloseSize({
    openCopyLotSizeShares: 0,
    walletPositionShares: 2.85,
    expiredSizeShares: null,
  }),
  0,
  'wallet-only position must not drive close size'
);

assert.equal(
  resolveProfitRedeemCloseSize({
    openCopyLotSizeShares: 2.5,
    walletPositionShares: 2.85,
    expiredSizeShares: null,
  }),
  2.5
);

assert.equal(
  shouldSkipAutoRedeemAfterManualClose({
    redeemSource: 'auto',
    hasManualCloseForToken: true,
    openCopyLotSizeShares: 0,
    upgradingExpired: false,
  }),
  true
);

assert.equal(
  shouldSkipAutoRedeemAfterManualClose({
    redeemSource: 'auto',
    hasManualCloseForToken: true,
    openCopyLotSizeShares: 0.5,
    upgradingExpired: false,
  }),
  false,
  'partial manual close leaves open lots for redeem'
);

assert.equal(
  shouldSkipAutoRedeemAfterManualClose({
    redeemSource: 'manual',
    hasManualCloseForToken: true,
    openCopyLotSizeShares: 0,
    upgradingExpired: false,
  }),
  false,
  'explicit user redeem is not blocked'
);

assert.equal(
  shouldSkipManualExpiredAfterManualClose({
    hasManualCloseForToken: true,
    walletPositionShares: 0,
  }),
  true
);

assert.equal(
  shouldSkipManualExpiredAfterManualClose({
    hasManualCloseForToken: true,
    walletPositionShares: 0.5,
  }),
  false
);

{
  const diluted = partitionSharedRedeemTxRows({
    rows: [
      { id: 'a', size: 1.3 },
      { id: 'b', size: 1.9 },
      { id: 'c', size: 2.7 },
    ],
    matchingIds: new Set<string>(),
    chainProceedsUsd: 0.8,
  });
  assert.equal(diluted.keep.length, 0, 'diluted mid-price shared tx must keep none');
  assert.equal(diluted.drop.length, 3);
}

{
  const matched = partitionSharedRedeemTxRows({
    rows: [
      { id: 'a', size: 1.3 },
      { id: 'b', size: 1.75 },
      { id: 'c', size: 2.7 },
    ],
    matchingIds: new Set(['b']),
    chainProceedsUsd: 1.75,
  });
  assert.deepEqual(
    matched.keep.map((row) => row.id),
    ['b']
  );
  assert.deepEqual(
    matched.drop.map((row) => row.id).sort(),
    ['a', 'c']
  );
}

{
  const fullWin = partitionSharedRedeemTxRows({
    rows: [
      { id: 'a', size: 1.3 },
      { id: 'b', size: 1.75 },
    ],
    matchingIds: new Set<string>(),
    chainProceedsUsd: 1.75,
  });
  assert.deepEqual(
    fullWin.keep.map((row) => row.id),
    ['b']
  );
  assert.deepEqual(
    fullWin.drop.map((row) => row.id),
    ['a']
  );
}

console.log('copyRedeemSettlementGuards.test.ts ok');
