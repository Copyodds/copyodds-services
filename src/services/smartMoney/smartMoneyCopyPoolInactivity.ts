const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 空仓 + 停摆出榜判定（纯函数，便于单测）。
 * lastTradeAt 超阈值，或无 lastTrade 时用 trades7d=0 且 exitDays≤7 近似。
 */
export function shouldExitCopyPoolForInactivity(input: {
  holdingsValueUsd: number | null;
  trades7d: number | null;
  lastTradeAt: Date | null;
  now?: Date;
  exitDays: number;
  maxHoldingsUsd: number;
}): boolean {
  const exitDays = input.exitDays;
  if (exitDays <= 0) return false;

  const holdings = input.holdingsValueUsd ?? 0;
  if (holdings > input.maxHoldingsUsd) return false;

  const now = input.now ?? new Date();
  if (input.lastTradeAt != null && Number.isFinite(input.lastTradeAt.getTime())) {
    return now.getTime() - input.lastTradeAt.getTime() >= exitDays * DAY_MS;
  }

  if (input.trades7d === 0 && exitDays <= 7) return true;
  return false;
}
