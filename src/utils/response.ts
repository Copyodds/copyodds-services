import type { Response } from 'express';

/** Unified response code: 0 = success, non-zero = error */
export const Code = {
  /** 成功 */
  SUCCESS: 0,
  /** 参数或校验错误（如请求体/路径参数不合法） */
  BAD_REQUEST: 40001,
  /** 表单/请求字段校验失败 */
  VALIDATION_FAILED: 40011,
  /** 上游 CLOB 拒绝下单/撤单等（可直接展示 message 给用户） */
  CLOB_REJECTED: 40021,
  /** 未登录或 token/API Key 无效 */
  UNAUTHORIZED: 40101,
  /** 登录邮箱或密码错误（与 token 失效区分） */
  INVALID_CREDENTIALS: 40102,
  /** JWT/session 失效 */
  SESSION_INVALID: 40111,
  /** 无权限（如操作不属于当前用户的资源） */
  FORBIDDEN: 40301,
  /** 共享密钥无效 */
  API_KEY_INVALID: 40321,
  /** 交易/风控禁止 */
  TRADING_BLOCKED: 40331,
  /** 资源不存在 */
  NOT_FOUND: 40401,
  /** 功能未开启 */
  FEATURE_DISABLED: 40421,
  /** 资源已永久移除（HTTP 410） */
  GONE: 41001,
  GAS_PACKAGE_CUSTODY_PURCHASE_DISABLED: 41002,
  LEGACY_COMMISSION_CLAIM_DISABLED: 41003,
  /** Share to X 今日已领取 */
  SHARE_TO_X_ALREADY_CLAIMED: 40941,
  /** 冲突（如用户名已存在、钱包已绑定其他用户） */
  CONFLICT: 40901,
  /** 状态冲突或前置条件未完成 */
  STATE_CONFLICT: 40911,
  /** 开启跟单前需充值 USDC 或购买 Gas */
  COPY_FUNDING_REQUIRED: 40912,
  USER_GAS_INSUFFICIENT: 40913,
  USER_COLLATERAL_INSUFFICIENT: 40914,
  USER_ALLOWANCE_REQUIRED: 40915,
  USER_MIN_ORDER_SIZE: 40916,
  SELL_NO_LIQUIDITY: 40917,
  SELL_BALANCE_LOCKED_BY_OPEN_ORDERS: 40918,
  POLYMARKET_DEPOSIT_NOT_CONFIGURED: 40921,
  POLYMARKET_DEPOSIT_NOT_AVAILABLE: 40922,
  POLYMARKET_RELAYER_NOT_CONFIGURED: 40923,
  POLYMARKET_RELAYER_IN_FLIGHT: 40924,
  POLYMARKET_RELAYER_TIMEOUT: 40925,
  POLYMARKET_RELAYER_SUBMIT_FAILED: 40926,
  POLYMARKET_RELAYER_MISSING_TX_HASH: 40927,
  POLYMARKET_CREDENTIALS_INVALID: 40928,
  POLYMARKET_DEPOSIT_ADDRESS_MISMATCH: 40929,
  WITHDRAWAL_NOT_AVAILABLE: 40931,
  WITHDRAWAL_AMOUNT_EXCEEDS_LIMIT: 40932,
  WITHDRAWAL_ZERO_AVAILABLE: 40933,
  WITHDRAWAL_TO_DEPOSIT_FORBIDDEN: 40934,
  USER_TRADING_FROZEN: 40332,
  USER_TRADING_REVIEW: 40333,
  USER_NOT_FOUND: 40402,
  VERIFICATION_CODE_INVALID: 40103,
  CLOB_INVALID_PRICE: 40022,
  CLOB_SERVICE_UNAVAILABLE: 50022,
  /** 请求过于频繁 */
  TOO_MANY_REQUESTS: 42901,
  /** 服务器或配置错误 */
  INTERNAL_ERROR: 50001,
  /** 依赖服务不可用 */
  DEPENDENCY_UNAVAILABLE: 50021,
  /** Passkey 未配置 */
  PASSKEY_NOT_CONFIGURED: 50301,
  /** Passkey challenge 过期 */
  PASSKEY_CHALLENGE_EXPIRED: 40031,
  /** Passkey 验证失败 */
  PASSKEY_VERIFY_FAILED: 40131,
  /** 用户无 Passkey 或 credential 不存在 */
  PASSKEY_NOT_FOUND: 40403,
  /** 提现等敏感操作需二次验证 */
  STEP_UP_REQUIRED: 40341,
  /** stepUpToken 无效 */
  STEP_UP_INVALID: 40342,
  /** stepUpToken 已过期 */
  STEP_UP_EXPIRED: 40343,
  /** stepUpToken purpose 不匹配 */
  STEP_UP_PURPOSE_MISMATCH: 40344,
  /** stepUpToken jti 在内存 store 中不存在（或仅在其他实例签发） */
  STEP_UP_NOT_FOUND: 40345,
  /** stepUpToken 已消费，不可重复使用 */
  STEP_UP_ALREADY_USED: 40346,
  /** TOTP 已开启，不可重复绑定 */
  TOTP_ALREADY_ENABLED: 40351,
  /** TOTP 未开启 */
  TOTP_NOT_ENABLED: 40352,
  /** 需先完成 TOTP 绑定流程 */
  TOTP_SETUP_REQUIRED: 40353,
  /** TOTP 绑定 pending 已过期 */
  TOTP_SETUP_EXPIRED: 40354,
  /** TOTP 验证码错误 */
  TOTP_CODE_INVALID: 40355,
  /** TOTP 验证过于频繁 */
  TOTP_RATE_LIMITED: 40356,
  /** TOTP secret 加密密钥未配置 */
  TOTP_SECRET_CONFIG_MISSING: 50302,
} as const;

export type ResponseCode = (typeof Code)[keyof typeof Code];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeReasonCode(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

const REASON_CODE_TO_RESPONSE_CODE: Record<string, ResponseCode> = {
  validation_failed: Code.VALIDATION_FAILED,
  unauthorized: Code.UNAUTHORIZED,
  forbidden: Code.FORBIDDEN,
  too_many_requests: Code.TOO_MANY_REQUESTS,
  not_found: Code.NOT_FOUND,
  feature_disabled: Code.FEATURE_DISABLED,
  user_trading_frozen: Code.USER_TRADING_FROZEN,
  user_trading_review: Code.USER_TRADING_REVIEW,
  user_not_found: Code.USER_NOT_FOUND,
  verification_code_invalid: Code.VERIFICATION_CODE_INVALID,
  user_gas_insufficient: Code.USER_GAS_INSUFFICIENT,
  copy_gas_insufficient: Code.USER_GAS_INSUFFICIENT,
  user_collateral_insufficient: Code.USER_COLLATERAL_INSUFFICIENT,
  user_funds_empty: Code.USER_COLLATERAL_INSUFFICIENT,
  user_allowance_required: Code.USER_ALLOWANCE_REQUIRED,
  user_token_approval_required: Code.USER_ALLOWANCE_REQUIRED,
  user_min_order_size: Code.USER_MIN_ORDER_SIZE,
  clob_invalid_price: Code.CLOB_INVALID_PRICE,
  clob_service_unavailable: Code.CLOB_SERVICE_UNAVAILABLE,
  sell_no_liquidity: Code.SELL_NO_LIQUIDITY,
  sell_balance_locked_by_open_orders: Code.SELL_BALANCE_LOCKED_BY_OPEN_ORDERS,
  polymarket_deposit_not_configured: Code.POLYMARKET_DEPOSIT_NOT_CONFIGURED,
  polymarket_deposit_not_available: Code.POLYMARKET_DEPOSIT_NOT_AVAILABLE,
  polymarket_relayer_not_configured: Code.POLYMARKET_RELAYER_NOT_CONFIGURED,
  polymarket_relayer_in_flight: Code.POLYMARKET_RELAYER_IN_FLIGHT,
  polymarket_relayer_timeout: Code.POLYMARKET_RELAYER_TIMEOUT,
  polymarket_relayer_submit_failed: Code.POLYMARKET_RELAYER_SUBMIT_FAILED,
  polymarket_relayer_missing_tx_hash: Code.POLYMARKET_RELAYER_MISSING_TX_HASH,
  polymarket_relayer_quota_exceeded: Code.TOO_MANY_REQUESTS,
  polymarket_deposit_registry_stuck: Code.POLYMARKET_DEPOSIT_NOT_AVAILABLE,
  polymarket_credentials_invalid: Code.POLYMARKET_CREDENTIALS_INVALID,
  polymarket_deposit_address_mismatch: Code.POLYMARKET_DEPOSIT_ADDRESS_MISMATCH,
  withdrawal_not_available: Code.WITHDRAWAL_NOT_AVAILABLE,
  withdrawal_amount_exceeds_limit: Code.WITHDRAWAL_AMOUNT_EXCEEDS_LIMIT,
  withdrawal_zero_available: Code.WITHDRAWAL_ZERO_AVAILABLE,
  zero_max_withdrawable: Code.WITHDRAWAL_ZERO_AVAILABLE,
  withdrawal_to_deposit_forbidden: Code.WITHDRAWAL_TO_DEPOSIT_FORBIDDEN,
  gas_package_custody_purchase_disabled: Code.GAS_PACKAGE_CUSTODY_PURCHASE_DISABLED,
  legacy_commission_claim_disabled: Code.LEGACY_COMMISSION_CLAIM_DISABLED,
  share_to_x_already_claimed: Code.SHARE_TO_X_ALREADY_CLAIMED,
};

function codeFromReason(value: unknown): ResponseCode | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return REASON_CODE_TO_RESPONSE_CODE[normalizeReasonCode(value)] ?? null;
}

function explicitResponseCode(extra?: Record<string, unknown>): ResponseCode | null {
  const direct = codeFromReason(extra?.errorCode);
  if (direct) return direct;

  const details = asRecord(extra?.details);
  return codeFromReason(details?.errorCode) ?? codeFromReason(details?.reasonCode);
}

function classifyErrorMessage(message: string, code: number): ResponseCode | null {
  const text = message.trim();
  const lower = text.toLowerCase();

  if (!text) return null;
  if (/validation failed|invalid request body|invalid .*address|invalid amount/i.test(text)) {
    return Code.VALIDATION_FAILED;
  }
  if (
    code === Code.UNAUTHORIZED ||
    code === Code.SESSION_INVALID ||
    code === Code.API_KEY_INVALID ||
    /unauthorized|jwt|session invalid|token expired|invalid token/i.test(text)
  ) {
    return Code.UNAUTHORIZED;
  }
  if (/forbidden|无权限/i.test(text)) return Code.FORBIDDEN;
  if (/too many requests|rate limit|触发限流|请求过于频繁/i.test(text)) return Code.TOO_MANY_REQUESTS;
  if (/builder relayer.*日配额|relayer.*日配额|quota exceeded/i.test(text)) return Code.TOO_MANY_REQUESTS;
  if (/feature disabled|not found/i.test(text) && code === Code.FEATURE_DISABLED) {
    return Code.FEATURE_DISABLED;
  }
  if (/passkey not found|no passkeys found/i.test(text)) return Code.PASSKEY_NOT_FOUND;
  if (/not found|不存在|未找到/i.test(text)) return Code.NOT_FOUND;

  if (/用户交易权限已被冻结|frozen/i.test(text)) return Code.USER_TRADING_FROZEN;
  if (/风控复核|review/i.test(text)) return Code.USER_TRADING_REVIEW;
  if (/用户不存在/i.test(text)) return Code.USER_NOT_FOUND;
  if (/验证码.*错误|邮箱或验证码错误|verification code/i.test(text)) {
    return Code.VERIFICATION_CODE_INVALID;
  }

  if (/gas/i.test(lower) && /不足|insufficient|used up|用尽/i.test(text)) {
    return Code.USER_GAS_INSUFFICIENT;
  }
  if (/platform gas|平台 gas/i.test(text)) return Code.USER_GAS_INSUFFICIENT;
  if (/抵押不足|保证金|usdc.*不足|collateral.*insufficient|not enough balance|insufficient.*usdc/i.test(text)) {
    return Code.USER_COLLATERAL_INSUFFICIENT;
  }
  if (/allowance|授权/i.test(text)) return Code.USER_ALLOWANCE_REQUIRED;
  if (/minimum|min order|lower than the minimum|低于.*最低|最小下单/i.test(text)) {
    return Code.USER_MIN_ORDER_SIZE;
  }
  if (/invalid price|价格.*无效/i.test(text)) return Code.CLOB_INVALID_PRICE;
  if (/clob.*不可用|clob.*5xx|service unavailable|dependency/i.test(text)) {
    return Code.CLOB_SERVICE_UNAVAILABLE;
  }
  if (/盘口没有可立即成交|no match|no.*bid|卖出未成交|fak/i.test(text)) {
    return Code.SELL_NO_LIQUIDITY;
  }
  if (/active orders|未成交卖单占用/i.test(text)) return Code.SELL_BALANCE_LOCKED_BY_OPEN_ORDERS;

  if (/未配置 polymarket deposit 地址/i.test(text)) return Code.POLYMARKET_DEPOSIT_NOT_CONFIGURED;
  if (/未使用独立 polymarket deposit|无法通过 relayer 赎回|无需划回/i.test(text)) {
    return Code.POLYMARKET_DEPOSIT_NOT_AVAILABLE;
  }
  if (/polymarket relayer 未配置|deposit 赎回需配置/i.test(text)) {
    return Code.POLYMARKET_RELAYER_NOT_CONFIGURED;
  }
  if (/relayer 正在处理|上一笔 polymarket 提现/i.test(text)) {
    return Code.POLYMARKET_RELAYER_IN_FLIGHT;
  }
  if (/relayer .*确认超时|confirmation.*timeout|确认超时/i.test(text)) {
    return Code.POLYMARKET_RELAYER_TIMEOUT;
  }
  if (/relayer .*提交失败|relayer .*执行失败|提交被拒/i.test(text)) {
    return Code.POLYMARKET_RELAYER_SUBMIT_FAILED;
  }
  if (/relayer .*transactionhash|未返回有效 transactionhash/i.test(lower)) {
    return Code.POLYMARKET_RELAYER_MISSING_TX_HASH;
  }
  if (/builder 凭证无效|credentials rejected|api key/i.test(text)) {
    return Code.POLYMARKET_CREDENTIALS_INVALID;
  }
  if (/deposit 地址与 relayer 推导不一致/i.test(text)) {
    return Code.POLYMARKET_DEPOSIT_ADDRESS_MISMATCH;
  }

  if (/当前不满足提现条件/i.test(text)) return Code.WITHDRAWAL_NOT_AVAILABLE;
  if (/提现金额超过可提上限|exceeds.*withdraw/i.test(text)) {
    return Code.WITHDRAWAL_AMOUNT_EXCEEDS_LIMIT;
  }
  if (/可提余额为 0|zero.*withdraw/i.test(text)) return Code.WITHDRAWAL_ZERO_AVAILABLE;
  if (/withdrawal address cannot be the deposit/i.test(text)) return Code.WITHDRAWAL_TO_DEPOSIT_FORBIDDEN;

  return null;
}

const KNOWN_RESPONSE_CODES = new Set<number>(Object.values(Code));

export function resolveResponseCode(
  code: number,
  message: string,
  extra?: Record<string, unknown>
): number {
  const explicit = explicitResponseCode(extra);
  if (explicit !== null) return explicit;

  // Preserve explicit AppError business codes (e.g. PASSKEY_NOT_FOUND); only infer from message for generic errors.
  if (KNOWN_RESPONSE_CODES.has(code) && code !== Code.INTERNAL_ERROR) {
    return code;
  }

  return classifyErrorMessage(message, code) ?? code;
}

function shouldHideServerErrorDetails(httpStatus: number): boolean {
  return httpStatus >= 500 && (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

function getResponseRequestId(res: Response): string | undefined {
  const requestId = res.locals?.requestId;
  return typeof requestId === 'string' && requestId.trim() ? requestId.trim() : undefined;
}

/**
 * Send success response: { code: 0, data }
 */
export function success(res: Response, data: unknown, httpStatus = 200): void {
  const requestId = getResponseRequestId(res);
  res.status(httpStatus).json({
    code: Code.SUCCESS,
    data,
    ...(requestId ? { requestId } : {}),
  });
}

/**
 * Send error response: { code, data: { message, ...extra } }
 */
export function fail(
  res: Response,
  code: number,
  message: string,
  httpStatus = 500,
  extra?: Record<string, unknown>
): void {
  const publicMessage = shouldHideServerErrorDetails(httpStatus) ? 'Internal server error' : message;
  if (publicMessage !== message) {
    console.error('[response.fail] hiding internal error details', { code, httpStatus, message });
  }
  const requestId = getResponseRequestId(res);
  const responseCode = resolveResponseCode(code, message, extra);
  res.status(httpStatus).json({
    code: responseCode,
    data: { message: publicMessage, ...extra },
    ...(requestId ? { requestId } : {}),
  });
}
