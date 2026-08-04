export type LeaderTradeReenqueueCounts = {
  /**
   * 无任何 CopyTradeRow，且 leader 仍有可用订阅。
   * 仅用于「尚未 processed」的漏派发恢复；已 processed 的 BUY 空跑不得再置 true，
   * 否则 duplicate signal 会在分钟～几十分钟后突然建行下单。
   */
  noRowsWithEnabledSubs: boolean;
  queuedCount: number;
  /** updatedAt 早于 stale 阈值的 submitting 行数 */
  submittingStaleCount: number;
  /** failed + retryable + retryCount < max */
  hasRetryableFailedUnderMax: boolean;
};

/** processed BUY 空跑禁止再因 no-rows 补派发；SELL 无行仍允许（资金暂停后补卖）。 */
export function allowNoRowsRedispatch(params: {
  processed: boolean;
  side: string | null | undefined;
}): boolean {
  if (!params.processed) return true;
  return params.side === 'SELL';
}

export type LeaderTradeReenqueueConfig = {
  copyMaxRetries: number;
};

/**
 * duplicate leader-signal 是否应补 enqueue（幂等 jobId）。
 * 正常 submitting、仅 dead/skipped/filled 等不补。
 */
export function shouldReenqueueFromCounts(counts: LeaderTradeReenqueueCounts): boolean {
  if (counts.noRowsWithEnabledSubs) {
    return true;
  }
  if (counts.queuedCount > 0) {
    return true;
  }
  if (counts.submittingStaleCount > 0) {
    return true;
  }
  if (counts.hasRetryableFailedUnderMax) {
    return true;
  }
  return false;
}
