/** Polymarket OrderFilled 份额为 6 位小数的整数 micro-shares（与链上 uint256 一致）。 */
export const OUTCOME_SIZE_RAW_SCALE = 1_000_000;

const LEADER_FILL_MAX_SANE_NOTIONAL_USD = 500_000;

/**
 * 将 LeaderTrade.amount 转为 CLOB 人类可读份额。
 * 链上整数（如 "1035176"）一律除以 1e6；已为小数的字符串保持原样。
 */
export function parseLeaderAmountAsClobSize(amountStr: string, price: number): number {
  const trimmed = amountStr.trim();
  let n = parseFloat(trimmed) || 0;
  if (!Number.isFinite(n) || n <= 0) return 0;

  if (/^\d+$/.test(trimmed)) {
    return n / OUTCOME_SIZE_RAW_SCALE;
  }

  if (!(price > 0 && Number.isFinite(price))) return n;
  for (let i = 0; i < 3; i++) {
    const notional = n * price;
    if (!(notional > LEADER_FILL_MAX_SANE_NOTIONAL_USD)) break;
    if (n < 1_000) break;
    n /= OUTCOME_SIZE_RAW_SCALE;
  }
  return n;
}
