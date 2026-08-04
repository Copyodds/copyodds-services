import { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { assertAutomationPermission } from '../polymarket/automationSession';
import { recordAuditEvent, recordRiskEvent } from '../audit/events';
import { recordAdminActivity, recordAdminAlert } from '../adminDashboard/adminActivityLog';
import {
  type RiskContext,
  describeRiskReason,
  RiskService,
} from '../../copyTrading/services/riskService';
import {
  getEffectiveLeaderRiskStateByAddress,
  getEffectiveSystemControl,
} from './tradingControl';
import {
  USER_TRADE_ERROR,
  checkUserTradePermission,
  isUserTradePermissionError,
} from './userTradePermission';

export const TRADING_REASON_CODE = {
  SYSTEM_PAUSED: 'SYSTEM_PAUSED',
  SYSTEM_TRACK_ONLY: 'SYSTEM_TRACK_ONLY',
  USER_FROZEN: 'USER_FROZEN',
  USER_UNDER_REVIEW: 'USER_UNDER_REVIEW',
  LEADER_DISABLED: 'LEADER_DISABLED',
  LEADER_WATCHLIST: 'LEADER_WATCHLIST',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  ORDER_NOTIONAL_EXCEEDED: 'ORDER_NOTIONAL_EXCEEDED',
  DAILY_LIMIT_EXCEEDED: 'DAILY_LIMIT_EXCEEDED',
  MARKET_EXPOSURE_EXCEEDED: 'MARKET_EXPOSURE_EXCEEDED',
  MARKET_BLOCKED: 'MARKET_BLOCKED',
  SIDE_FILTER_MISMATCH: 'SIDE_FILTER_MISMATCH',
  CONCURRENT_ORDER_LIMIT_EXCEEDED: 'CONCURRENT_ORDER_LIMIT_EXCEEDED',
  CONSECUTIVE_FAILURE_LIMIT_EXCEEDED: 'CONSECUTIVE_FAILURE_LIMIT_EXCEEDED',
  MARKET_COOLDOWN_ACTIVE: 'MARKET_COOLDOWN_ACTIVE',
  ALREADY_OPEN_POSITION: 'ALREADY_OPEN_POSITION',
  SLIPPAGE_EXCEEDED: 'SLIPPAGE_EXCEEDED',
  USER_APPROVAL_REQUIRED: 'USER_APPROVAL_REQUIRED',
  USER_REDEMPTION_DISABLED: 'USER_REDEMPTION_DISABLED',
  RISK_INFRA_UNAVAILABLE: 'RISK_INFRA_UNAVAILABLE',
  UNKNOWN_RISK: 'UNKNOWN_RISK',
} as const;

export type TradingReasonCode = (typeof TRADING_REASON_CODE)[keyof typeof TRADING_REASON_CODE];
export type TradingSource = 'USER_ORDER' | 'PLATFORM_ORDER' | 'COPY_DISPATCH' | 'FOLLOW_ENGINE';

export type TradingGuardInput = {
  source: TradingSource;
  userId?: number;
  side: 'BUY' | 'SELL';
  expectedAddress?: string;
  orderPrice: number;
  notionalUsd: number;
  marketId?: string | null;
  tokenId?: string | null;
  leaderAddress?: string | null;
  leaderTradeId?: string | null;
  copyTradeRowId?: string | null;
  subscriptionId?: string | null;
  copyRiskContext?: RiskContext;
};

export type TradingGuardDecision = {
  allowed: boolean;
  reasonCode: TradingReasonCode | null;
  message: string | null;
  thresholdSnapshot?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
};

export class TradingGuardError extends Error {
  constructor(public readonly decision: TradingGuardDecision) {
    super(decision.message ?? decision.reasonCode ?? 'Trading guard blocked the request.');
    this.name = 'TradingGuardError';
  }
}

function buildDecision(
  allowed: boolean,
  reasonCode: TradingReasonCode | null,
  message: string | null,
  extras?: Pick<TradingGuardDecision, 'thresholdSnapshot' | 'context'>
): TradingGuardDecision {
  return {
    allowed,
    reasonCode,
    message,
    thresholdSnapshot: extras?.thresholdSnapshot ?? null,
    context: extras?.context ?? null,
  };
}

function mapCopyRiskReasonToReasonCode(reason: string | undefined): TradingReasonCode {
  switch (reason) {
    case 'fail_streak':
      return TRADING_REASON_CODE.CONSECUTIVE_FAILURE_LIMIT_EXCEEDED;
    case 'market_blocked':
      return TRADING_REASON_CODE.MARKET_BLOCKED;
    case 'side_filter':
      return TRADING_REASON_CODE.SIDE_FILTER_MISMATCH;
    case 'min_amount':
    case 'max_amount':
      return TRADING_REASON_CODE.ORDER_NOTIONAL_EXCEEDED;
    case 'market_amount':
      return TRADING_REASON_CODE.MARKET_EXPOSURE_EXCEEDED;
    case 'daily_cap':
      return TRADING_REASON_CODE.DAILY_LIMIT_EXCEEDED;
    case 'market_cooldown':
      return TRADING_REASON_CODE.MARKET_COOLDOWN_ACTIVE;
    case 'already_open_position':
      return TRADING_REASON_CODE.ALREADY_OPEN_POSITION;
    case 'slippage':
      return TRADING_REASON_CODE.SLIPPAGE_EXCEEDED;
    default:
      return TRADING_REASON_CODE.UNKNOWN_RISK;
  }
}

function mapAutomationErrorToReasonCode(message: string): TradingReasonCode {
  const text = message.toLowerCase();
  if (text.includes('permission denied')) {
    if (text.includes('redeem')) {
      return TRADING_REASON_CODE.USER_REDEMPTION_DISABLED;
    }
    return TRADING_REASON_CODE.SIDE_FILTER_MISMATCH;
  }
  if (text.includes('max order notional')) {
    return TRADING_REASON_CODE.ORDER_NOTIONAL_EXCEEDED;
  }
  if (text.includes('daily notional cap')) {
    return TRADING_REASON_CODE.DAILY_LIMIT_EXCEEDED;
  }
  if (text.includes('allowance')) {
    return TRADING_REASON_CODE.USER_APPROVAL_REQUIRED;
  }
  if (text.includes('insufficient') || text.includes('balance')) {
    return TRADING_REASON_CODE.INSUFFICIENT_BALANCE;
  }
  return TRADING_REASON_CODE.UNKNOWN_RISK;
}

function buildSystemModeMessage(mode: 'TRACK_ONLY' | 'PAUSED'): string {
  return mode === 'PAUSED' ? '系统当前处于全局暂停状态。' : '系统当前处于仅跟踪模式，不会实际发单。';
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

async function persistBlockedDecision(input: TradingGuardInput, decision: TradingGuardDecision) {
  if (!decision.reasonCode) {
    return;
  }

  await Promise.all([
    recordAuditEvent({
      actorType: input.source,
      actorId: input.userId != null ? String(input.userId) : null,
      userId: input.userId ?? null,
      action: 'TRADING_GUARD_BLOCKED',
      targetType: input.leaderAddress ? 'LeaderTrade' : 'TradeOrder',
      targetId: input.leaderTradeId ?? input.copyTradeRowId ?? input.tokenId ?? null,
      result: 'blocked',
      reasonCode: decision.reasonCode,
      metadata: toJsonValue({
        source: input.source,
        side: input.side,
        marketId: input.marketId ?? null,
        tokenId: input.tokenId ?? null,
        notionalUsd: input.notionalUsd,
        leaderAddress: input.leaderAddress ?? null,
        thresholdSnapshot: decision.thresholdSnapshot ?? null,
        context: decision.context ?? null,
      }),
    }),
    recordRiskEvent({
      userId: input.userId ?? null,
      leaderId: null,
      subscriptionId: input.subscriptionId ?? null,
      leaderTradeId: input.leaderTradeId ?? null,
      copyTradeRowId: input.copyTradeRowId ?? null,
      source: input.source,
      result: 'blocked',
      reasonCode: decision.reasonCode,
      marketId: input.marketId ?? null,
      tokenId: input.tokenId ?? null,
      side: input.side,
      notionalUsd: input.notionalUsd,
      thresholdSnapshot:
        decision.thresholdSnapshot != null ? toJsonValue(decision.thresholdSnapshot) : undefined,
      inputSnapshot: toJsonValue({
        orderPrice: input.orderPrice,
        notionalUsd: input.notionalUsd,
        leaderAddress: input.leaderAddress ?? null,
      }),
      metadata: decision.context != null ? toJsonValue(decision.context) : undefined,
    }),
  ]);

  recordAdminActivity({
    eventType: 'risk.blocked',
    title: 'Risk Control Blocked',
    level: 'warning',
    actorType: input.source,
    actorId: input.userId != null ? String(input.userId) : null,
    targetType: input.copyTradeRowId ? 'CopyTradeRow' : 'TradeOrder',
    targetId: input.copyTradeRowId ?? input.leaderTradeId ?? null,
    content: decision.reasonCode,
  });
  recordAdminAlert({
    alertType: 'risk.blocked',
    title: 'Risk Control Blocked',
    level: 'warning',
    source: input.source,
    targetId: input.copyTradeRowId ?? input.leaderTradeId ?? undefined,
    content: decision.reasonCode,
  });
}

export function isTradingGuardError(error: unknown): error is TradingGuardError {
  return error instanceof TradingGuardError;
}

export class TradingGuardService {
  private async block(
    input: TradingGuardInput,
    reasonCode: TradingReasonCode,
    message: string,
    extras?: Pick<TradingGuardDecision, 'thresholdSnapshot' | 'context'>
  ): Promise<TradingGuardDecision> {
    const decision = buildDecision(false, reasonCode, message, extras);
    await persistBlockedDecision(input, decision);
    return decision;
  }

  async evaluate(input: TradingGuardInput): Promise<TradingGuardDecision> {
    const systemControl = await getEffectiveSystemControl();
    if (systemControl.mode === 'PAUSED' || systemControl.mode === 'TRACK_ONLY') {
      return this.block(
        input,
        systemControl.mode === 'PAUSED'
          ? TRADING_REASON_CODE.SYSTEM_PAUSED
          : TRADING_REASON_CODE.SYSTEM_TRACK_ONLY,
        buildSystemModeMessage(systemControl.mode),
        {
          context: {
            systemMode: systemControl.mode,
            source: systemControl.source,
          },
        }
      );
    }

    if (input.userId != null) {
      try {
        await checkUserTradePermission(input.userId);
      } catch (error) {
        if (isUserTradePermissionError(error)) {
          const reasonCode =
            error.errorCode === USER_TRADE_ERROR.REVIEW
              ? TRADING_REASON_CODE.USER_UNDER_REVIEW
              : TRADING_REASON_CODE.USER_FROZEN;
          return this.block(input, reasonCode, error.message, {
            context: { tradeStatus: error.tradeStatus, errorCode: error.errorCode },
          });
        }
        return this.block(input, TRADING_REASON_CODE.UNKNOWN_RISK, '用户不存在。');
      }
    }

    if (input.leaderAddress) {
      const leaderRisk = await getEffectiveLeaderRiskStateByAddress(input.leaderAddress);
      if (leaderRisk.status === 'DISABLED') {
        return this.block(
          input,
          TRADING_REASON_CODE.LEADER_DISABLED,
          leaderRisk.note?.trim() || '当前 leader 已被风控停用。',
          {
            context: {
              leaderStatus: leaderRisk.status,
              leaderId: leaderRisk.leaderId,
              expiresAt: leaderRisk.expiresAt,
            },
          }
        );
      }
      if (leaderRisk.status === 'WATCHLIST') {
        return this.block(
          input,
          TRADING_REASON_CODE.LEADER_WATCHLIST,
          leaderRisk.note?.trim() || '当前 leader 处于观察名单，暂不允许自动交易。',
          {
            context: {
              leaderStatus: leaderRisk.status,
              leaderId: leaderRisk.leaderId,
              expiresAt: leaderRisk.expiresAt,
            },
          }
        );
      }
    }

    if (input.userId != null && input.source !== 'COPY_DISPATCH') {
      try {
        await assertAutomationPermission({
          userId: input.userId,
          action: input.side,
          expectedAddress: input.expectedAddress,
          notionalUsd: input.notionalUsd > 0 ? input.notionalUsd : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.block(input, mapAutomationErrorToReasonCode(message), message);
      }
    }

    if (input.copyRiskContext) {
      const risk = new RiskService();
      const result = await risk.evaluate(input.copyRiskContext, input.orderPrice);
      if (!result.ok) {
        return this.block(
          input,
          mapCopyRiskReasonToReasonCode(result.reason),
          result.message ?? describeRiskReason(result.reason) ?? '风险控制已阻止本次交易。',
          {
            thresholdSnapshot: {
              subscriptionId: input.copyRiskContext.subscription.id,
              marketId: input.copyRiskContext.marketId,
              notionalUsd: input.copyRiskContext.notionalUsd,
              originalNotionalUsd: input.copyRiskContext.originalNotionalUsd,
              minAmountUsd: input.copyRiskContext.subscription.minAmountUsd?.toString() ?? null,
              maxAmount: input.copyRiskContext.subscription.maxAmount?.toString() ?? null,
              maxAmountPerMarketUsd:
                input.copyRiskContext.subscription.maxAmountPerMarketUsd?.toString() ?? null,
              dailyTotalCapUsd:
                input.copyRiskContext.subscription.dailyTotalCapUsd?.toString() ?? null,
              slippage: input.copyRiskContext.subscription.slippage?.toString() ?? null,
              marketCooldownMinutes: input.copyRiskContext.subscription.marketCooldownMinutes ?? null,
              pauseAfterConsecutiveFails:
                input.copyRiskContext.subscription.pauseAfterConsecutiveFails ?? null,
              skipBuyIfOpenPosition:
                input.copyRiskContext.subscription.skipBuyIfOpenPosition !== false,
            },
            context: {
              subscriptionId: input.copyRiskContext.subscription.id,
              leaderPrice: input.copyRiskContext.leaderPrice,
              orderPrice: input.orderPrice,
            },
          }
        );
      }
    }

    return buildDecision(true, null, null);
  }

  async assertAllowed(input: TradingGuardInput): Promise<TradingGuardDecision> {
    const decision = await this.evaluate(input);
    if (!decision.allowed) {
      throw new TradingGuardError(decision);
    }
    return decision;
  }
}
