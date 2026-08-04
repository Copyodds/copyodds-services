import { resolveFollowerExpiredCloseSize } from './copySettlementProceeds';

import { COPY_LOT_DUST_SHARES } from './copyPositionLots';

const EPS = 1e-9;
const TX_HASH_RE = /^0x[a-f0-9]{64}$/i;

export const MANUAL_CLOSE_LEADER_ADDRESSES = ['manual_close', 'virtual_manual_close'] as const;

export function normalizeRedeemTxHash(txHash: string | null | undefined): string | null {
  const tx = txHash?.trim().toLowerCase() ?? '';
  return TX_HASH_RE.test(tx) ? tx : null;
}

export function isRedeemTxHashInUseSet(txHash: string, used: ReadonlySet<string>): boolean {
  const normalized = normalizeRedeemTxHash(txHash);
  return normalized != null && used.has(normalized);
}

const SHARED_TX_EPS = 1e-9;

/**
 * When several redeem executions share one tx hash, keep only rows that match the
 * RedeemLog condition (or a single full-win size match). Everything else is
 * mis-attribution and must not receive diluted mid-price proceeds.
 */
export function partitionSharedRedeemTxRows<T extends { id: string; size: number }>(params: {
  rows: T[];
  /** Execution ids whose token belongs to the RedeemLog condition for this tx. */
  matchingIds: ReadonlySet<string>;
  chainProceedsUsd: number;
}): { keep: T[]; drop: T[] } {
  const { rows, matchingIds, chainProceedsUsd } = params;
  if (rows.length <= 1) return { keep: [...rows], drop: [] };

  if (matchingIds.size > 0) {
    const keep = rows.filter((row) => matchingIds.has(row.id));
    if (keep.length > 0) {
      return { keep, drop: rows.filter((row) => !matchingIds.has(row.id)) };
    }
    return { keep: [], drop: [...rows] };
  }

  const fullWin = rows.filter((row) => {
    const size = row.size;
    return (
      size > SHARED_TX_EPS &&
      chainProceedsUsd + SHARED_TX_EPS >= size * 0.9 &&
      chainProceedsUsd <= size * 1.05 + SHARED_TX_EPS
    );
  });
  // Only trust a unique full-win size match; ambiguous or mid-price dilution → drop all.
  if (fullWin.length === 1) {
    const keepId = fullWin[0].id;
    return { keep: [fullWin[0]], drop: rows.filter((row) => row.id !== keepId) };
  }

  // Mid-price dilution (e.g. $1.75 across ~20 shares): trust none.
  return { keep: [], drop: [...rows] };
}

/**
 * Profit redeem / lot close size: requires open copy lots, or upgrading an expired row.
 * Never infer size from Data API wallet position alone (avoids phantom settlements).
 */
export function resolveProfitRedeemCloseSize(params: {
  openCopyLotSizeShares: number;
  walletPositionShares: number;
  expiredSizeShares: number | null;
}): number {
  const walletPositionShares = Math.max(0, params.walletPositionShares);
  if (params.openCopyLotSizeShares > EPS) {
    return resolveFollowerExpiredCloseSize({
      openCopyLotSizeShares: params.openCopyLotSizeShares,
      walletPositionShares,
    });
  }
  if (params.expiredSizeShares != null && params.expiredSizeShares > EPS) {
    return resolveFollowerExpiredCloseSize({
      openCopyLotSizeShares: params.expiredSizeShares,
      walletPositionShares,
    });
  }
  return 0;
}

/** auto_redeem after manual_close on same token with no open lots left */
export function shouldSkipAutoRedeemAfterManualClose(params: {
  redeemSource: 'manual' | 'auto';
  hasManualCloseForToken: boolean;
  openCopyLotSizeShares: number;
  upgradingExpired: boolean;
}): boolean {
  if (params.upgradingExpired) return false;
  if (params.redeemSource === 'manual') return false;
  if (!params.hasManualCloseForToken) return false;
  return !(params.openCopyLotSizeShares > EPS);
}

/** 链上已手动平仓 flat 后，禁止再自动 manual_expired（残余 dust 并入 manual_close）。 */
export function shouldSkipManualExpiredAfterManualClose(params: {
  hasManualCloseForToken: boolean;
  walletPositionShares: number;
}): boolean {
  if (!params.hasManualCloseForToken) return false;
  return !(params.walletPositionShares > COPY_LOT_DUST_SHARES);
}
