const SHARE_EPS = 1e-6;
const SHARE_DECIMALS = 4;
const COPY_LOT_DUST_SHARES = 0.01;

export function roundDownToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

/** Compare share amounts with rounding tolerance (CLOB vs lot bookkeeping drift). */
export function sharesFilledEnough(
  filled: number,
  requested: number,
  epsilon = SHARE_EPS
): boolean {
  if (!(requested > 0)) return filled > epsilon;
  if (filled + epsilon >= requested) return true;
  const scale = 10 ** SHARE_DECIMALS;
  return Math.round(filled * scale) >= Math.round(requested * scale);
}

/** SELL is complete when requested size matched, copy lot cleared, or account has no shares left. */
export function isCopySellFillComplete(params: {
  requestedSize: number;
  filledSize: number;
  copyLotBefore: number | null;
  copyLotAfter: number | null;
  accountPositionAfter: number | null;
}): boolean {
  const { requestedSize, filledSize, copyLotBefore, copyLotAfter, accountPositionAfter } = params;
  if (!(filledSize > SHARE_EPS)) return false;
  if (sharesFilledEnough(filledSize, requestedSize)) return true;
  if (copyLotBefore != null && copyLotBefore > SHARE_EPS && sharesFilledEnough(filledSize, copyLotBefore)) {
    return true;
  }
  if (copyLotAfter != null && copyLotAfter <= COPY_LOT_DUST_SHARES) return true;
  if (accountPositionAfter != null && accountPositionAfter <= COPY_LOT_DUST_SHARES) return true;
  return false;
}

/**
 * 跟卖份额：与跟单比例无关；leader 一卖，就把该 subscription 在此 token 上的 open lot 全部卖出。
 * 有 lot/持仓数据时卖 available 全量；无 lot 时回退 formulaSize（真实 RATIO 路径传入 0）。
 */
export function resolveCopySellSize(params: {
  formulaSize: number;
  availableSize: number | null;
}): number {
  const { formulaSize, availableSize } = params;
  if (availableSize != null) {
    const available = roundDownToDecimals(availableSize, 6);
    if (available > 0) return available;
    return 0;
  }
  return roundDownToDecimals(formulaSize, 6);
}
