/** Follower settlement proceeds: proportional redeem attribution + $1/share cap for binary markets. */

const EPS = 1e-9;

/** Polymarket binary outcome shares settle at most $1 USDC each. */
export const MAX_BINARY_SHARE_PAYOUT_USD = 1;

/**
 * Attribute chain redeem proceeds to follower lots when the redeem tx may cover
 * the full wallet position (Data API `size`) while lots track a smaller amount.
 */
export function allocateFollowerRedeemProceedsUsd(params: {
  chainProceedsUsd: number;
  walletPositionShares: number;
  followerCloseSizeShares: number;
}): number {
  const { chainProceedsUsd, walletPositionShares, followerCloseSizeShares } = params;
  if (!(followerCloseSizeShares > EPS) || !(chainProceedsUsd > EPS)) return 0;

  let allocated = chainProceedsUsd;
  if (walletPositionShares > followerCloseSizeShares + EPS) {
    allocated = chainProceedsUsd * (followerCloseSizeShares / walletPositionShares);
  }

  const cap = followerCloseSizeShares * MAX_BINARY_SHARE_PAYOUT_USD;
  return Math.min(allocated, cap);
}

/** Cap CLOB sell proceeds when fill notional implies an impossible per-share price (> $1). */
export function allocateFollowerSellProceedsUsd(params: {
  fillNotionalUsd: number;
  closedSizeShares: number;
}): { proceedsUsd: number; exitPrice: number } {
  const { fillNotionalUsd, closedSizeShares } = params;
  if (!(closedSizeShares > EPS)) {
    return { proceedsUsd: 0, exitPrice: 0 };
  }
  const cap = closedSizeShares * MAX_BINARY_SHARE_PAYOUT_USD;
  const proceedsUsd = Math.min(Math.max(0, fillNotionalUsd), cap);
  return { proceedsUsd, exitPrice: proceedsUsd / closedSizeShares };
}

/**
 * Market-sell proceeds for repair: avoid treating dust lots (entry < $0.10/share) as $1 exits.
 * Live dispatch still uses allocateFollowerSellProceedsUsd; repair uses this stricter path.
 */
export function allocateFollowerMarketSellProceedsUsd(params: {
  fillNotionalUsd: number;
  closedSizeShares: number;
  costBasisUsd: number;
  entryAvgPrice: number;
}): { proceedsUsd: number; exitPrice: number } {
  const { fillNotionalUsd, closedSizeShares, costBasisUsd, entryAvgPrice } = params;
  if (!(closedSizeShares > EPS)) {
    return { proceedsUsd: 0, exitPrice: 0 };
  }

  let proceedsUsd = Math.max(0, fillNotionalUsd);
  const impliedExit = proceedsUsd / closedSizeShares;
  const binaryCap = closedSizeShares * MAX_BINARY_SHARE_PAYOUT_USD;

  if (entryAvgPrice > EPS && entryAvgPrice < 0.1 && impliedExit > 0.9) {
    proceedsUsd = Math.min(proceedsUsd, Math.max(0, costBasisUsd));
  } else {
    proceedsUsd = Math.min(proceedsUsd, binaryCap);
  }

  return { proceedsUsd, exitPrice: proceedsUsd / closedSizeShares };
}

/** Map CLOB fill + open lots to follower lot-close size and sanitized exit price. */
export function resolveSellLotCloseFromFill(params: {
  lotRemainingShares: number;
  filledSizeShares: number;
  executionPrice: number;
  fillNotionalUsd?: number | null;
}): { closeSize: number; exitPrice: number } {
  const { lotRemainingShares, filledSizeShares, executionPrice, fillNotionalUsd } = params;
  const filled = filledSizeShares > EPS ? filledSizeShares : 0;
  const closeSize =
    lotRemainingShares > EPS
      ? Math.min(lotRemainingShares, filled > EPS ? filled : lotRemainingShares)
      : 0;
  if (!(closeSize > EPS)) {
    return { closeSize: 0, exitPrice: Math.max(0, executionPrice) };
  }
  const notionalUsd =
    fillNotionalUsd != null && fillNotionalUsd > 0
      ? fillNotionalUsd
      : closeSize * Math.max(0, executionPrice);
  const { exitPrice } = allocateFollowerSellProceedsUsd({
    fillNotionalUsd: notionalUsd,
    closedSizeShares: closeSize,
  });
  return { closeSize, exitPrice };
}

export function resolveFollowerExpiredCloseSize(params: {
  openCopyLotSizeShares: number;
  walletPositionShares: number;
}): number {
  const { openCopyLotSizeShares, walletPositionShares } = params;
  if (!(openCopyLotSizeShares > EPS)) return 0;
  if (walletPositionShares > EPS) {
    return Math.min(openCopyLotSizeShares, walletPositionShares);
  }
  return openCopyLotSizeShares;
}

/** Scale leader/CLOB fill notional to follower closed shares. */
export function scaleFillNotionalToFollowerClose(params: {
  fillNotionalUsd: number;
  fillSizeShares: number;
  followerClosedSizeShares: number;
}): number {
  const { fillNotionalUsd, fillSizeShares, followerClosedSizeShares } = params;
  if (!(fillNotionalUsd > EPS) || !(followerClosedSizeShares > EPS)) return 0;
  if (!(fillSizeShares > EPS)) return Math.min(fillNotionalUsd, followerClosedSizeShares);
  const ratio = Math.min(1, followerClosedSizeShares / fillSizeShares);
  return fillNotionalUsd * ratio;
}

/** Cap a single close to remaining buy-lot budget; cost basis follows entry price. */
export function capCloseSizeToBuyBudget(params: {
  requestedCloseSize: number;
  entryPrice: number;
  entrySizeBudget: number;
  alreadyClosedFromBuy: number;
}): { closeSize: number; costBasisUsd: number } {
  const remaining = Math.max(0, params.entrySizeBudget - params.alreadyClosedFromBuy);
  const closeSize = Math.min(Math.max(0, params.requestedCloseSize), remaining);
  return {
    closeSize,
    costBasisUsd: closeSize * Math.max(0, params.entryPrice),
  };
}

/**
 * Infer wallet share count at redeem: chain USDC ≈ $1/share on wins;
 * never treat arbitrary dollars as shares when redeem lost.
 *
 * When chain proceeds already ≈ $1 × follower close size, treat the redeem tx as
 * covering only the follower lot. Data API `size` can be stale/inflated and must
 * not scale a full-win payout down to a mid-price recovery.
 */
export function inferWalletSharesForRedeem(params: {
  executionSizeShares: number;
  followerCloseSizeShares: number;
  chainProceedsUsd: number;
}): number {
  const exec = Math.max(0, params.executionSizeShares);
  const close = Math.max(0, params.followerCloseSizeShares);
  const chain = Math.max(0, params.chainProceedsUsd);
  // Full-win for this close size: ignore inflated wallet size from Data API.
  if (close > EPS && chain + EPS >= close * 0.9 && chain <= close * 1.05 + EPS) {
    return close;
  }
  if (chain > close + EPS) {
    return Math.max(exec, close, chain);
  }
  return Math.max(exec, close);
}

/** Scale planned redeem proceeds so a tx hash budget is not exceeded across groups. */
export function capRedeemGroupProceedsToTxBudget(
  plannedProceedsUsd: number[],
  chainProceedsUsd: number
): number[] {
  const sum = plannedProceedsUsd.reduce((acc, value) => acc + value, 0);
  if (!(sum > chainProceedsUsd + 1e-6) || !(sum > EPS)) return plannedProceedsUsd;
  const scale = chainProceedsUsd / sum;
  return plannedProceedsUsd.map((value) => value * scale);
}

export function planFollowerRedeemProceedsUsd(params: {
  chainProceedsUsd: number;
  executionSizeShares: number;
  followerCloseSizeShares: number;
}): number {
  const walletSize = inferWalletSharesForRedeem({
    executionSizeShares: params.executionSizeShares,
    followerCloseSizeShares: params.followerCloseSizeShares,
    chainProceedsUsd: params.chainProceedsUsd,
  });
  return allocateFollowerRedeemProceedsUsd({
    chainProceedsUsd: params.chainProceedsUsd,
    walletPositionShares: walletSize,
    followerCloseSizeShares: params.followerCloseSizeShares,
  });
}
