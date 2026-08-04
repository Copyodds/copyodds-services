import assert from 'node:assert/strict';
import {
  allocateFollowerMarketSellProceedsUsd,
  allocateFollowerRedeemProceedsUsd,
  allocateFollowerSellProceedsUsd,
  capCloseSizeToBuyBudget,
  capRedeemGroupProceedsToTxBudget,
  inferWalletSharesForRedeem,
  planFollowerRedeemProceedsUsd,
  resolveFollowerExpiredCloseSize,
  scaleFillNotionalToFollowerClose,
} from './copySettlementProceeds';

// Redeem tx credited $12.36 for 12.36 wallet shares; follower lot only 4.12.
assert.equal(
  allocateFollowerRedeemProceedsUsd({
    chainProceedsUsd: 12.362447,
    walletPositionShares: 12.362447,
    followerCloseSizeShares: 4.12,
  }),
  4.12
);

// ETH-style bug: $8.375 tx on 2.08 follower shares (wallet also 2.08) → cap at $1/share.
assert.equal(
  allocateFollowerRedeemProceedsUsd({
    chainProceedsUsd: 8.375,
    walletPositionShares: 2.07843,
    followerCloseSizeShares: 2.07843,
  }),
  2.07843
);

// BNB sell: CLOB reported $8.375 for 5 shares → cap at $5.
const bnb = allocateFollowerSellProceedsUsd({ fillNotionalUsd: 8.375, closedSizeShares: 5 });
assert.equal(bnb.proceedsUsd, 5);
assert.equal(bnb.exitPrice, 1);

// Expired: never close more than open lots (ignore inflated Data API size).
assert.equal(
  resolveFollowerExpiredCloseSize({ openCopyLotSizeShares: 52.5, walletPositionShares: 105 }),
  52.5
);

// BNB repair: dust entry $0.01/share must not become a fake $1 exit.
const bnbRepair = allocateFollowerMarketSellProceedsUsd({
  fillNotionalUsd: 8.375,
  closedSizeShares: 5,
  costBasisUsd: 0.05,
  entryAvgPrice: 0.01,
});
assert.equal(bnbRepair.proceedsUsd, 0.05);
assert.equal(bnbRepair.exitPrice, 0.01);

// Leader sold 100 shares / $50; follower closed 5.
assert.equal(
  scaleFillNotionalToFollowerClose({
    fillNotionalUsd: 50,
    fillSizeShares: 100,
    followerClosedSizeShares: 5,
  }),
  2.5
);

// Buy budget: 6.12 shares; already closed 0; request 12.36 → cap 6.12.
const capped = capCloseSizeToBuyBudget({
  requestedCloseSize: 12.36,
  entryPrice: 0.5,
  entrySizeBudget: 6.12,
  alreadyClosedFromBuy: 0,
});
assert.equal(capped.closeSize, 6.12);
assert.ok(Math.abs(capped.costBasisUsd - 3.06) < 1e-6);

// Redeem chain $12.36 on 6.12 follower close → wallet ≈ 12.36 shares.
assert.equal(
  inferWalletSharesForRedeem({
    executionSizeShares: 6.12,
    followerCloseSizeShares: 6.12,
    chainProceedsUsd: 12.362447,
  }),
  12.362447
);

// Paris-style bug: Data API wallet size inflated, but chain already paid ≈ $1 × close.
assert.equal(
  inferWalletSharesForRedeem({
    executionSizeShares: 2.47,
    followerCloseSizeShares: 1.1053,
    chainProceedsUsd: 1.10526,
  }),
  1.1053
);
assert.equal(
  planFollowerRedeemProceedsUsd({
    chainProceedsUsd: 1.10526,
    executionSizeShares: 2.47,
    followerCloseSizeShares: 1.1053,
  }),
  1.10526
);

assert.equal(
  capRedeemGroupProceedsToTxBudget([8.375, 8.375], 8.375).map((v) => Number(v.toFixed(4))).join(','),
  '4.1875,4.1875'
);

console.log('copySettlementProceeds.test.ts: ok');
