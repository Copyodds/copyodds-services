/** 无法从异常消息分类时使用；默认可重试，受 COPY_MAX_RETRIES 约束 */
export const COPY_UNKNOWN_ERROR_CODE = 'unknown_error';

export const COPY_STALE_SUBMITTING_ERROR_CODE = 'stale_submitting';

const RETRYABLE_ERROR_CODES = new Set<string>([
  COPY_UNKNOWN_ERROR_CODE,
  COPY_STALE_SUBMITTING_ERROR_CODE,
  'clob_rate_limit',
  'clob_timeout',
  'clob_connection_reset',
  'clob_network_error',
  'clob_service_unavailable',
  'clob_partial_fill',
  'ignored_no_position_sell',
]);

/** 规范化写入 DB 的 errorCode（null/空 → unknown_error） */
export function normalizeCopyTradeErrorCode(errorCode: string | null | undefined): string {
  const trimmed = (errorCode ?? '').trim();
  return trimmed.length > 0 ? trimmed : COPY_UNKNOWN_ERROR_CODE;
}

/** 是否允许 retrySweep 重新 queued 并入队 dispatch */
export function isCopyTradeErrorRetryable(errorCode: string | null | undefined): boolean {
  return RETRYABLE_ERROR_CODES.has(normalizeCopyTradeErrorCode(errorCode));
}

export type CopyRetryDelayBounds = { base: number; max: number };

function readRetryDelayBounds(): CopyRetryDelayBounds {
  const base = Math.max(0, Number(process.env.COPY_RETRY_BASE_DELAY_MS ?? 2000));
  const max = Math.max(0, Number(process.env.COPY_RETRY_MAX_DELAY_MS ?? 120_000));
  return { base, max: Math.max(base, max) };
}

/**
 * 第 n 次失败后的 sweep 退避：min(base * 2^(retryCount-1), max)。
 * retryCount=1 → base；2 → base*2；3 → base*4。retryCount=0 时指数为 0 → base。
 */
export function copyTradeRetryDelayMs(
  retryCount: number,
  bounds?: CopyRetryDelayBounds
): number {
  const { base, max } = bounds ?? readRetryDelayBounds();
  const n = Math.max(0, Math.floor(retryCount));
  if (base <= 0) return 0;
  const exponent = Math.max(0, n - 1);
  const delay = base * 2 ** exponent;
  return Math.min(delay, max);
}
