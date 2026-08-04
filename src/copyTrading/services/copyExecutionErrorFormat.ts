import { describeCopyOrderErrorCode } from './riskService';

/** 与 copyTrade executions API 一致的用户可见错误文案 */
export function formatExecutionError(
  errorCode?: string | null,
  errorMsg?: string | null
): string | null {
  const code = errorCode?.trim();
  const msg = errorMsg?.trim();
  const description = describeCopyOrderErrorCode(code ?? undefined)?.trim();

  if (code && description && msg) {
    if (msg === description) {
      return `${code}: ${description}`;
    }
    return `${code}: ${description} | ${msg}`;
  }

  if (code && description) {
    return `${code}: ${description}`;
  }

  if (code && msg) {
    return code === msg ? code : `${code}: ${msg}`;
  }
  return code ?? msg ?? null;
}

/** CLOB 类错误优先展示原始消息（与 copyTrade route 一致） */
export function formatUnderlyingFailureReason(errorCode?: string | null, errorMsg?: string | null): string | null {
  if (errorCode?.startsWith('clob_') && errorMsg?.trim()) {
    return errorMsg.trim();
  }
  return formatExecutionError(errorCode, errorMsg);
}
