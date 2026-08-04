import { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import {
  isCopyOrderPriceWithinSlippage,
  parseSubscriptionSlippage,
} from './copyOrderPrice';
import {
  startOfUtcDay,
  sumMarketDailyNotionalUsd,
  sumSubscriptionDailyNotionalUsd,
  sumUserDailyNotionalUsd,
} from './copyRiskDailyNotional';
import {
  COPY_LOT_DUST_SHARES,
  getOpenCopyLotSizeForSubscription,
} from './copyPositionLots';

const COPY_MIN_AMOUNT_GUARD_ENABLED = true;

export type RiskContext = {
  userId: number;
  subscription: {
    id: string;
    onlyBuy: boolean;
    onlySell: boolean;
    minAmountUsd: Prisma.Decimal | null;
    maxAmount: Prisma.Decimal | null;
    maxAmountPerMarketUsd: Prisma.Decimal | null;
    dailyTotalCapUsd: Prisma.Decimal | null;
    slippage: Prisma.Decimal | null;
    marketCooldownMinutes: number | null;
    pauseAfterConsecutiveFails: number | null;
    /** 已有同 token 未平仓跟单仓位时跳过 BUY */
    skipBuyIfOpenPosition?: boolean;
  };
  leaderPrice: number;
  notionalUsd: number;
  originalNotionalUsd: number;
  marketId: string | null;
  /** CLOB token；信号常缺 marketId，冷却键回退用它（与虚拟跟单一致） */
  tokenId?: string | null;
  side: 'BUY' | 'SELL';
  minNotionalAdjusted: boolean;
};

/**
 * 市场冷却存储键：优先 marketId；链路未填 marketId 时回退 tokenId。
 * 生产 leader-signal / nats-ingestor 当前常传 marketId=null，若无回退则冷却永不生效。
 */
export function resolveCopyMarketCooldownKey(input: {
  marketId?: string | null;
  tokenId?: string | null;
}): string | null {
  const marketId = input.marketId?.trim() || null;
  if (marketId) return marketId;
  const tokenId = input.tokenId?.trim() || null;
  return tokenId || null;
}

type RiskEvaluationResult =
  | { ok: true }
  | { ok: false; reason: string; message?: string };

type FailStreakState =
  | { allowed: true; count: number }
  | { allowed: false; count: number; pausedUntil: string | null; remainingMs: number };

type MarketCooldownState =
  | { allowed: true }
  | { allowed: false; remainingMs: number; resumeAt: string | null };

export type CopyOrderFailureClassification = {
  errorCode:
    | 'ignored_no_position_sell'
    | 'clob_rate_limit'
    | 'clob_timeout'
    | 'clob_connection_reset'
    | 'clob_network_error'
    | 'clob_service_unavailable'
    | 'clob_no_liquidity'
    | 'clob_orderbook_missing'
    | 'user_gas_insufficient'
    | 'user_insufficient_balance'
    | 'user_allowance_required'
    | 'user_token_approval_required'
    | 'user_min_order_size'
    | 'below_min_notional'
    | 'user_insufficient_shares'
    | 'user_collateral_insufficient'
    | 'clob_rejected'
    | 'clob_error'
    | 'unknown_error';
  countTowardFailStreak: boolean;
  retryable: boolean;
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }

  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} 分钟`;
  }

  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours} 小时`;
  }

  const totalDays = Math.ceil(totalHours / 24);
  return `${totalDays} 天`;
}

function formatResumeAt(iso: string | null): string {
  if (!iso) {
    return `约 ${formatDuration(CONFIG.copyFailStreakCooldownMs)} 后自动恢复。`;
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return `约 ${formatDuration(CONFIG.copyFailStreakCooldownMs)} 后自动恢复。`;
  }

  return `将于 ${date.toLocaleString('zh-CN', { hour12: false })} 自动恢复。`;
}

function lowerMessage(input: string): string {
  return input.toLowerCase();
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

/**
 * CLOB 拒单文案 `not enough balance / allowance: balance X allowance Y`。
 * balance=0 时多为抵押不足；仅当 balance>0 且 allowance=0 时才视为授权问题。
 */
function classifyClobBalanceAllowanceMessage(text: string): CopyOrderFailureClassification | null {
  if (!text.includes('not enough balance / allowance')) {
    return null;
  }

  const balanceMatch = text.match(/balance[:\s]+(\d+)/i);
  const allowanceMatch = text.match(/allowance[:\s]+(\d+)/i);

  if (balanceMatch && allowanceMatch) {
    try {
      const balance = BigInt(balanceMatch[1]);
      const allowance = BigInt(allowanceMatch[1]);

      if (balance === 0n) {
        return {
          errorCode: 'user_collateral_insufficient',
          countTowardFailStreak: false,
          retryable: false,
        };
      }

      if (allowance === 0n) {
        return {
          errorCode: 'user_allowance_required',
          countTowardFailStreak: false,
          retryable: false,
        };
      }
    } catch {
      // fall through
    }
  }

  return {
    errorCode: 'user_collateral_insufficient',
    countTowardFailStreak: false,
    retryable: false,
  };
}

export function classifyCopyOrderFailure(message: string): CopyOrderFailureClassification {
  const text = lowerMessage((message ?? '').trim());
  if (!text) {
    return { errorCode: 'unknown_error', countTowardFailStreak: true, retryable: true };
  }

  if (
    includesAny(text, [
      'minimum order size',
      'min order size',
      'size too small',
      'lower than the minimum',
    ])
  ) {
    return { errorCode: 'user_min_order_size', countTowardFailStreak: false, retryable: false };
  }

  if (includesAny(text, ['invalid price'])) {
    return { errorCode: 'clob_rejected', countTowardFailStreak: false, retryable: false };
  }

  if (/orderbook\s+\d+\s+does not exist/i.test(text) || text.includes('orderbook does not exist')) {
    return { errorCode: 'clob_orderbook_missing', countTowardFailStreak: false, retryable: false };
  }

  if (
    includesAny(text, [
      'clob_market_sell_not_filled',
      'clob_no_liquidity',
      'no match',
      '没有可立即成交的买单',
      '没有可立即成交的卖单',
      '没有可立即成交的对手盘',
      '无可立即成交',
      'buy not filled',
      'sell not filled',
      'matchable sell liquidity',
      'matchable buy liquidity',
      'fak canceled',
      'fok canceled',
      'unfilled amount canceled',
      'canceled the unfilled',
      'could not be fully filled',
      "couldn't be fully filled",
      'cannot be fully filled',
    ])
  ) {
    return { errorCode: 'clob_no_liquidity', countTowardFailStreak: false, retryable: false };
  }

  if (includesAny(text, ['429', 'too many requests', 'rate limit'])) {
    return { errorCode: 'clob_rate_limit', countTowardFailStreak: true, retryable: true };
  }

  if (includesAny(text, ['etimedout', 'timeout', 'timed out', 'gateway timeout'])) {
    return { errorCode: 'clob_timeout', countTowardFailStreak: true, retryable: true };
  }

  if (includesAny(text, ['econnreset', 'socket hang up', 'connection reset'])) {
    return { errorCode: 'clob_connection_reset', countTowardFailStreak: true, retryable: true };
  }

  if (includesAny(text, ['fetch failed', 'network error', 'eai_again', 'enotfound', 'socket closed'])) {
    return { errorCode: 'clob_network_error', countTowardFailStreak: true, retryable: true };
  }

  if (
    includesAny(text, [
      'service unavailable',
      'bad gateway',
      'internal server error',
      'temporarily unavailable',
      '503',
      '502',
      '504',
    ])
  ) {
    return { errorCode: 'clob_service_unavailable', countTowardFailStreak: true, retryable: true };
  }

  if (
    includesAny(text, [
      'insufficient gas balance',
      'gas balance',
      'gas for this order',
      'gas 不足',
      'gas不足',
    ])
  ) {
    return { errorCode: 'user_gas_insufficient', countTowardFailStreak: false, retryable: false };
  }

  const clobBalanceAllowance = classifyClobBalanceAllowanceMessage(text);
  if (clobBalanceAllowance) {
    return clobBalanceAllowance;
  }

  if (
    includesAny(text, [
      'collateral',
      'buying power',
      'insufficient_collateral',
      'polymarket_clob_collateral',
      'polymarket_deposit_pusd',
      'insufficient_pusd_after_wrap',
      'wrap usdce',
      'wrap usdc.e',
      'pusd',
      '保证金不足',
    ])
  ) {
    return {
      errorCode: 'user_collateral_insufficient',
      countTowardFailStreak: false,
      retryable: false,
    };
  }

  if (includesAny(text, ['allowance'])) {
    return { errorCode: 'user_allowance_required', countTowardFailStreak: false, retryable: false };
  }

  if (includesAny(text, ['approval', 'approvedforall', 'approve'])) {
    return {
      errorCode: 'user_token_approval_required',
      countTowardFailStreak: false,
      retryable: false,
    };
  }

  if (includesAny(text, ['no shares', 'holdings', 'position', 'insufficient shares'])) {
    return { errorCode: 'user_insufficient_shares', countTowardFailStreak: false, retryable: false };
  }

  if (includesAny(text, ['insufficient', 'balance', 'asset balance', 'not enough balance'])) {
    return { errorCode: 'user_insufficient_balance', countTowardFailStreak: false, retryable: false };
  }

  if (includesAny(text, ['nonce too low', 'nonce too high', 'replacement transaction underpriced'])) {
    return { errorCode: 'unknown_error', countTowardFailStreak: true, retryable: true };
  }

  if (isClobRejectedTerminal(text)) {
    return { errorCode: 'clob_rejected', countTowardFailStreak: false, retryable: false };
  }

  return { errorCode: 'unknown_error', countTowardFailStreak: true, retryable: true };
}

/** Error codes that must never trip consecutive-failure pause (market/liquidity skips, funding, etc.). */
const FAIL_STREAK_EXCLUDED_ERROR_CODES = new Set<string>([
  'clob_no_liquidity',
  'clob_orderbook_missing',
  'clob_rejected',
  'ignored_no_position_sell',
  'user_min_order_size',
  'below_min_notional',
  'user_insufficient_balance',
  'user_insufficient_shares',
  'user_collateral_insufficient',
  'user_allowance_required',
  'user_token_approval_required',
  'user_gas_insufficient',
  'fail_streak',
  'CONSECUTIVE_FAILURE_LIMIT_EXCEEDED',
]);

/** Whether a classified / stored copy error should increment subscription fail streak. */
export function shouldCountCopyFailureTowardStreak(
  failure: Pick<CopyOrderFailureClassification, 'errorCode' | 'countTowardFailStreak'>
): boolean {
  if (!failure.countTowardFailStreak) return false;
  if (FAIL_STREAK_EXCLUDED_ERROR_CODES.has(failure.errorCode)) return false;
  return true;
}

/** 明确不可恢复的 CLOB 终态拒单；泛化 400/bad request/rejected 不在此列 */
function isClobRejectedTerminal(text: string): boolean {
  if (
    includesAny(text, [
      'market closed',
      'market not active',
      'not tradeable',
      'trading disabled',
      'invalid signature',
      'size exceeds',
      'price out of range',
      'order rejected',
    ])
  ) {
    return true;
  }

  if (!text.includes('invalid order')) {
    return false;
  }

  return includesAny(text, [
    'price',
    'size',
    'market',
    'signature',
    'tick',
    'lot',
    'decimal',
    'range',
    'exceed',
    'closed',
    'inactive',
  ]);
}

export function describeRiskReason(reason: string | undefined): string | null {
  switch (reason) {
    case 'fail_streak':
      return `当前订阅连续失败次数达到 ${CONFIG.copyFailStreakMax} 次，已暂停自动跟单；约 ${formatDuration(CONFIG.copyFailStreakCooldownMs)} 后自动恢复。`;
    case 'market_blocked':
      return '当前市场不在允许的跟单白名单中。';
    case 'side_filter':
      return '该订阅仅允许指定方向，当前 leader 方向不满足条件。';
    case 'min_amount':
      return '本次下单金额低于订阅设置的最小金额限制。';
    case 'max_amount':
      return '本次下单金额超过订阅设置的最大金额限制。';
    case 'market_amount':
      return '当前市场已触达订阅设置的单市场金额上限。';
    case 'daily_cap':
      return '已触达当日跟单名义金额上限。';
    case 'market_cooldown':
      return '当前市场仍在冷却时间内，暂不重复跟单。';
    case 'already_open_position':
      return '当前订阅在该 outcome 上仍有未平仓跟单仓位，已跳过加仓买单（可在高级设置关闭「有仓不加仓」）。';
    case 'slippage':
      return '预估价格偏离 leader 成交价过大，超出滑点限制。';
    case 'risk':
      return '风险控制已阻止本次跟单。';
    default:
      return reason ?? null;
  }
}

export function describeCopyOrderErrorCode(errorCode: string | undefined): string | null {
  switch (errorCode) {
    case 'ignored_no_position_sell':
      return '当前账户没有可卖出的对应持仓，系统已自动忽略该 SELL 跟单。';
    case 'already_open_position':
      return '当前订阅在该 outcome 上仍有未平仓跟单仓位，已跳过加仓买单。';
    case 'clob_rate_limit':
      return 'CLOB 触发限流，建议降低并发或等待自动重试。';
    case 'clob_timeout':
      return '请求 CLOB 超时，通常属于临时网络或上游抖动。';
    case 'clob_connection_reset':
      return '与 CLOB 的连接被重置，通常属于临时网络异常。';
    case 'clob_network_error':
      return '访问 CLOB 时发生网络错误。';
    case 'clob_service_unavailable':
      return 'CLOB 服务当前不可用或上游返回 5xx。';
    case 'clob_no_liquidity':
      return '当前盘口没有可立即成交的对手盘流动性，FAK 已取消未成交部分。';
    case 'clob_orderbook_missing':
      return 'Polymarket CLOB 当前没有这个 token 的 orderbook，市场可能未开放、已关闭或暂不可交易，本次跟单已跳过。';
    case 'user_gas_insufficient':
      return '平台 Gas 不足，已自动暂停跟单；请充值 Gas 后重新开启。';
    case 'user_insufficient_balance':
      return '账户余额不足，无法完成下单。';
    case 'user_allowance_required':
      return 'USDC allowance 不足，需要先授权。';
    case 'user_token_approval_required':
      return '条件代币未授权给交易所，需要先完成 approveForAll。';
    case 'user_min_order_size':
      return '下单数量低于市场最小下单限制。';
    case 'below_min_notional':
      return '按可用余额比例计算后的买入金额低于最小下单额，已跳过本次跟单。';
    case 'user_insufficient_shares':
      return '卖出所需的 outcome 份额不足。';
    case 'copy_funding_paused':
      return '跟单已因保证金或授权不足自动暂停，请处理资金后重新开启。';
    case 'user_collateral_insufficient':
      return '可用抵押资产不足，无法完成买单。';
    case 'clob_rejected':
      return 'CLOB 拒绝了订单，请检查参数或市场状态。';
    case 'clob_error':
      return '下单失败，但未命中已知错误分类。';
    case 'unknown_error':
      return '下单失败，原因未分类；系统将按可重试错误处理直至达到重试上限。';
    case 'stale_submitting':
      return '订单长时间停留在提交中，已标记失败并等待自动重试。';
    default:
      return null;
  }
}

export class RiskService {
  private getFailStreakThreshold(subscriptionMax?: number | null): number {
    if (subscriptionMax == null || !Number.isFinite(subscriptionMax)) {
      return CONFIG.copyFailStreakMax;
    }
    return Math.max(1, Math.floor(subscriptionMax));
  }

  private async loadSubscriptionRiskRow(subscriptionId: string) {
    return prisma.copySubscription.findUnique({
      where: { id: subscriptionId },
      select: {
        failStreakCount: true,
        failStreakUpdatedAt: true,
        pausedUntil: true,
        pauseReason: true,
      },
    });
  }

  private async clearExpiredPause(subscriptionId: string, pausedUntil: Date | null): Promise<void> {
    if (!pausedUntil || pausedUntil.getTime() > Date.now()) {
      return;
    }
    await prisma.copySubscription.update({
      where: { id: subscriptionId },
      data: {
        pausedUntil: null,
        pauseReason: null,
        failStreakCount: 0,
      },
    });
  }

  private async getFailStreakState(
    userId: number,
    subscriptionId: string,
    subscriptionMax?: number | null
  ): Promise<FailStreakState> {
    if (CONFIG.copyFailStreakMode === 'off') {
      return { allowed: true, count: 0 };
    }

    const row = await this.loadSubscriptionRiskRow(subscriptionId);
    if (!row) {
      return { allowed: true, count: 0 };
    }

    await this.clearExpiredPause(subscriptionId, row.pausedUntil);

    const fresh = (await this.loadSubscriptionRiskRow(subscriptionId)) ?? row;
    const count = fresh.failStreakCount ?? 0;
    const threshold = this.getFailStreakThreshold(subscriptionMax);

    if (fresh.pausedUntil && fresh.pausedUntil.getTime() > Date.now()) {
      const remainingMs = fresh.pausedUntil.getTime() - Date.now();
      return {
        allowed: false,
        count,
        pausedUntil: fresh.pausedUntil.toISOString(),
        remainingMs,
      };
    }

    if (count < threshold) {
      return { allowed: true, count };
    }

    return { allowed: true, count };
  }

  /** 连续失败暂停：按 user + subscription 维度软熔断 */
  async checkFailStreak(
    userId: number,
    subscriptionId: string,
    subscriptionMax?: number | null
  ): Promise<FailStreakState> {
    return this.getFailStreakState(userId, subscriptionId, subscriptionMax);
  }

  async recordFailure(userId: number, subscriptionId: string) {
    const row = await this.loadSubscriptionRiskRow(subscriptionId);
    if (!row) return;

    const nextCount = (row.failStreakCount ?? 0) + 1;
    const sub = await prisma.copySubscription.findUnique({
      where: { id: subscriptionId },
      select: { pauseAfterConsecutiveFails: true },
    });
    const threshold = this.getFailStreakThreshold(sub?.pauseAfterConsecutiveFails ?? null);
    const now = new Date();

    const data: Prisma.CopySubscriptionUpdateInput = {
      failStreakCount: nextCount,
      failStreakUpdatedAt: now,
    };

    if (nextCount >= threshold) {
      data.pausedUntil = new Date(now.getTime() + CONFIG.copyFailStreakCooldownMs);
      data.pauseReason = 'fail_streak';
    }

    await prisma.copySubscription.update({
      where: { id: subscriptionId },
      data,
    });
  }

  async clearFailureStreak(userId: number, subscriptionId: string) {
    await prisma.copySubscription.updateMany({
      where: { id: subscriptionId, userId },
      data: {
        failStreakCount: 0,
        failStreakUpdatedAt: null,
        pausedUntil: null,
        pauseReason: null,
      },
    });
  }

  private wouldExceedCap(current: number, cap: number | undefined, addUsd: number): boolean {
    if (cap === undefined || !Number.isFinite(cap) || !(addUsd > 0)) {
      return false;
    }
    return current + addUsd > cap;
  }

  /** 成交成功后无需再写计数器；日额度由 copy_trades 聚合 */
  async recordFilledNotional(_ctx: RiskContext): Promise<void> {
    return;
  }

  async checkDailyNotional(userId: number, addUsd: number): Promise<boolean> {
    const dayStart = startOfUtcDay();
    const current = await sumUserDailyNotionalUsd(userId, dayStart);
    return !this.wouldExceedCap(current, CONFIG.copyDailyNotionalCapUsd, addUsd);
  }

  async checkSubscriptionDailyNotional(ctx: RiskContext): Promise<boolean> {
    const cap = ctx.subscription.dailyTotalCapUsd?.toNumber();
    const dayStart = startOfUtcDay();
    const current = await sumSubscriptionDailyNotionalUsd(
      ctx.userId,
      ctx.subscription.id,
      dayStart
    );
    return !this.wouldExceedCap(current, cap, ctx.notionalUsd);
  }

  async checkMarketAmountLimit(ctx: RiskContext): Promise<boolean> {
    if (!ctx.marketId) return true;
    const cap = ctx.subscription.maxAmountPerMarketUsd?.toNumber();
    const dayStart = startOfUtcDay();
    const current = await sumMarketDailyNotionalUsd(
      ctx.userId,
      ctx.subscription.id,
      ctx.marketId,
      dayStart
    );
    return !this.wouldExceedCap(current, cap, ctx.notionalUsd);
  }

  private async getMarketCooldownState(ctx: RiskContext): Promise<MarketCooldownState> {
    const cooldownKey = resolveCopyMarketCooldownKey(ctx);
    if (
      !cooldownKey ||
      ctx.subscription.marketCooldownMinutes == null ||
      ctx.subscription.marketCooldownMinutes <= 0
    ) {
      return { allowed: true };
    }

    const row = await prisma.copyMarketCooldown.findUnique({
      where: {
        userId_subscriptionId_marketId: {
          userId: ctx.userId,
          subscriptionId: ctx.subscription.id,
          marketId: cooldownKey,
        },
      },
      select: { cooldownUntil: true },
    });

    if (!row || row.cooldownUntil.getTime() <= Date.now()) {
      if (row) {
        await prisma.copyMarketCooldown.deleteMany({
          where: {
            userId: ctx.userId,
            subscriptionId: ctx.subscription.id,
            marketId: cooldownKey,
          },
        });
      }
      return { allowed: true };
    }

    const remainingMs = row.cooldownUntil.getTime() - Date.now();
    return {
      allowed: false,
      remainingMs,
      resumeAt: row.cooldownUntil.toISOString(),
    };
  }

  async armMarketCooldown(ctx: RiskContext) {
    const cooldownKey = resolveCopyMarketCooldownKey(ctx);
    if (
      !cooldownKey ||
      ctx.subscription.marketCooldownMinutes == null ||
      ctx.subscription.marketCooldownMinutes <= 0
    ) {
      return;
    }

    const cooldownUntil = new Date(
      Date.now() + Math.ceil(ctx.subscription.marketCooldownMinutes * 60_000)
    );

    await prisma.copyMarketCooldown.upsert({
      where: {
        userId_subscriptionId_marketId: {
          userId: ctx.userId,
          subscriptionId: ctx.subscription.id,
          marketId: cooldownKey,
        },
      },
      create: {
        userId: ctx.userId,
        subscriptionId: ctx.subscription.id,
        marketId: cooldownKey,
        cooldownUntil,
        reason: 'post_fill',
      },
      update: {
        cooldownUntil,
        reason: 'post_fill',
      },
    });
  }

  checkMarketWhitelist(marketId: string | null): boolean {
    const w = CONFIG.copyMarketWhitelist;
    if (!w.length) return true;
    if (!marketId) return false;
    return w.includes(marketId);
  }

  checkSideFilters(sub: RiskContext['subscription'], side: 'BUY' | 'SELL'): boolean {
    if (sub.onlyBuy && side !== 'BUY') return false;
    if (sub.onlySell && side !== 'SELL') return false;
    return true;
  }

  checkMinAmount(sub: RiskContext['subscription'], notionalUsd: number): boolean {
    if (!COPY_MIN_AMOUNT_GUARD_ENABLED) return true;
    if (!sub.minAmountUsd) return true;
    const min = new Prisma.Decimal(sub.minAmountUsd.toString());
    return new Prisma.Decimal(notionalUsd).gte(min);
  }

  checkMaxAmount(sub: RiskContext['subscription'], notionalUsd: number): boolean {
    if (!sub.maxAmount) return true;
    const max = new Prisma.Decimal(sub.maxAmount.toString());
    return new Prisma.Decimal(notionalUsd).lte(max);
  }

  canTolerateBuyMaxAmountOverflow(ctx: RiskContext): boolean {
    if (ctx.side !== 'BUY' || !ctx.minNotionalAdjusted || !ctx.subscription.maxAmount) {
      return false;
    }

    const max = new Prisma.Decimal(ctx.subscription.maxAmount.toString()).toNumber();
    if (!Number.isFinite(max) || max <= 0) {
      return false;
    }

    if (ctx.originalNotionalUsd > max + 1e-9) {
      return false;
    }

    const toleratedMax = max * (1 + CONFIG.copyBuyMaxAmountToleranceRatio);
    return ctx.notionalUsd <= toleratedMax + 1e-9;
  }

  /** 滑点：买单允许 leader*(1+slippage) 以内加价；卖单允许 leader*(1-slippage) 以内降价 */
  checkSlippage(
    sub: RiskContext['subscription'],
    side: RiskContext['side'],
    leaderPrice: number,
    orderPrice: number
  ): boolean {
    return isCopyOrderPriceWithinSlippage({
      side,
      leaderPrice,
      orderPrice,
      slippage: parseSubscriptionSlippage(sub.slippage),
    });
  }

  async evaluate(ctx: RiskContext, orderPrice: number): Promise<RiskEvaluationResult> {
    if (!this.checkSideFilters(ctx.subscription, ctx.side)) {
      return { ok: false, reason: 'side_filter' };
    }
    if (ctx.side === 'SELL') {
      if (!this.checkSlippage(ctx.subscription, ctx.side, ctx.leaderPrice, orderPrice)) {
        return { ok: false, reason: 'slippage' };
      }
      return { ok: true };
    }

    if (ctx.subscription.skipBuyIfOpenPosition !== false) {
      const tokenId = ctx.tokenId?.trim();
      if (tokenId) {
        const openLotSize = await getOpenCopyLotSizeForSubscription({
          prismaClient: prisma,
          userId: ctx.userId,
          subscriptionId: ctx.subscription.id,
          tokenID: tokenId,
        });
        if (openLotSize > COPY_LOT_DUST_SHARES) {
          return {
            ok: false,
            reason: 'already_open_position',
            message:
              '当前订阅在该 outcome 上仍有未平仓跟单仓位，已跳过加仓买单，避免同一仓位多次投入；平仓或赎回后再跟买，也可在高级设置关闭「有仓不加仓」。',
          };
        }
      }
    }

    const failStreakThreshold = this.getFailStreakThreshold(
      ctx.subscription.pauseAfterConsecutiveFails
    );
    const failStreak = await this.checkFailStreak(
      ctx.userId,
      ctx.subscription.id,
      ctx.subscription.pauseAfterConsecutiveFails
    );
    if (!failStreak.allowed) {
      return {
        ok: false,
        reason: 'fail_streak',
        message: `当前订阅连续失败次数达到 ${failStreakThreshold} 次，已暂停自动跟单；${formatResumeAt(failStreak.pausedUntil)}`,
      };
    }
    if (!this.checkMarketWhitelist(ctx.marketId)) {
      return { ok: false, reason: 'market_blocked' };
    }
    if (!this.checkMinAmount(ctx.subscription, ctx.notionalUsd)) {
      return { ok: false, reason: 'min_amount' };
    }
    if (
      !this.checkMaxAmount(ctx.subscription, ctx.notionalUsd) &&
      !this.canTolerateBuyMaxAmountOverflow(ctx)
    ) {
      return { ok: false, reason: 'max_amount' };
    }
    const marketCooldown = await this.getMarketCooldownState(ctx);
    if (!marketCooldown.allowed) {
      return {
        ok: false,
        reason: 'market_cooldown',
        message: `当前市场仍在冷却时间内；约 ${formatDuration(
          marketCooldown.remainingMs
        )} 后可再次跟单。`,
      };
    }
    if (!this.checkSlippage(ctx.subscription, ctx.side, ctx.leaderPrice, orderPrice)) {
      return { ok: false, reason: 'slippage' };
    }
    if (!(await this.checkMarketAmountLimit(ctx))) {
      return { ok: false, reason: 'market_amount' };
    }
    if (!(await this.checkSubscriptionDailyNotional(ctx))) {
      return { ok: false, reason: 'daily_cap' };
    }
    if (!(await this.checkDailyNotional(ctx.userId, ctx.notionalUsd))) {
      return { ok: false, reason: 'daily_cap' };
    }
    return { ok: true };
  }
}
