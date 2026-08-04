import { copyTradeRetryDelayMs, isCopyTradeErrorRetryable } from './copyRetryPolicy';

export type CopyRetrySweepConfig = {
  copyMaxRetries: number;
  copyRetryBaseDelayMs: number;
  copyRetryMaxDelayMs: number;
};

export type RetrySweepRow = {
  errorCode: string | null;
  retryCount: number;
  updatedAt: Date;
};

/** 是否可由 sweep 置回 queued（不含 DB/入队副作用） */
export function isEligibleForRetrySweep(
  row: RetrySweepRow,
  nowMs: number,
  config: CopyRetrySweepConfig
): boolean {
  if (!isCopyTradeErrorRetryable(row.errorCode)) {
    return false;
  }
  if (row.retryCount >= config.copyMaxRetries) {
    return false;
  }
  const delayMs = copyTradeRetryDelayMs(row.retryCount, {
    base: config.copyRetryBaseDelayMs,
    max: config.copyRetryMaxDelayMs,
  });
  if (delayMs > 0 && nowMs - row.updatedAt.getTime() < delayMs) {
    return false;
  }
  return true;
}
