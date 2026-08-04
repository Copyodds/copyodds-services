import { prisma } from '../../db';
import { recordAuditEvent } from '../../services/audit/events';
import {
  describeCopyFundingOperationalFailure,
  getCopyFundingSnapshot,
  type CopyFundingSnapshot,
} from './copyFundingCheck.js';
import { publishRobotControlEvent } from '../events/publishRobotControlEvent.js';
import { recordAdminActivity } from '../../services/adminDashboard/adminActivityLog.js';
import { invalidatePolymarketDepositUsdcBalanceCache } from '../../services/polymarket/polymarketDepositWithdraw.js';
import { invalidateCopyFundingPrecheckCache } from './copyOrderFundingPrecheck.js';

export const COPY_GAS_INSUFFICIENT_ERROR_CODE = 'user_gas_insufficient';
export const COPY_COLLATERAL_INSUFFICIENT_WARNING_CODE = 'user_collateral_insufficient';
export const COPY_FUNDS_EMPTY_ERROR_CODE = 'user_funds_empty';

/** 买单资金/Gas 不足：标记订阅预警并进入冷静期，不向 CLOB 发单、不写执行日志。 */
export const COPY_BUY_FUNDING_WARNING_CODES = new Set<string>([
  COPY_GAS_INSUFFICIENT_ERROR_CODE,
  COPY_COLLATERAL_INSUFFICIENT_WARNING_CODE,
  COPY_FUNDS_EMPTY_ERROR_CODE,
  'user_insufficient_balance',
]);

export function isCopyBuyFundingWarningCode(errorCode: string | null | undefined): boolean {
  const code = errorCode?.trim();
  return code != null && code.length > 0 && COPY_BUY_FUNDING_WARNING_CODES.has(code);
}

export function subscriptionHasBuyFundingWarning(
  sub:
    | {
        fundingWarningAt?: Date | null;
        fundingWarningCode?: string | null;
      }
    | null
    | undefined
): boolean {
  if (!sub?.fundingWarningAt) return false;
  return isCopyBuyFundingWarningCode(sub.fundingWarningCode);
}

/** 扫块监听无流量成本：运行时不再因订单失败自动暂停跟单。 */
export const COPY_ORDER_ERRORS_PAUSE_TRADING = new Set<string>();

export type CopyFundingPausedState = {
  errorCode: string;
  errorMsg: string;
  pausedAt: string;
};

export function shouldPauseCopyTradingForOrderError(errorCode: string | null | undefined): boolean {
  if (!errorCode?.trim()) return false;
  return COPY_ORDER_ERRORS_PAUSE_TRADING.has(errorCode.trim());
}

export async function getCopyFundingPausedState(
  userId: number
): Promise<CopyFundingPausedState | null> {
  const pausedSub = await (prisma as any).copySubscription.findFirst({
    where: { userId, fundingPausedAt: { not: null } },
    orderBy: { fundingPausedAt: 'desc' },
    select: {
      fundingPausedAt: true,
      fundingPausedCode: true,
      fundingPausedReason: true,
    },
  });

  if (pausedSub?.fundingPausedAt) {
    return {
      errorCode: pausedSub.fundingPausedCode?.trim() || 'copy_funding_paused',
      errorMsg:
        pausedSub.fundingPausedReason?.trim() ||
        '跟单已因平台 Gas 不足自动暂停，请充值 Gas 后重新开启。',
      pausedAt: pausedSub.fundingPausedAt.toISOString(),
    };
  }

  return null;
}

export async function pauseUserCopyTradingForFunding(params: {
  userId: number;
  errorCode: string;
  errorMsg: string;
}): Promise<boolean> {
  const { userId, errorCode, errorMsg } = params;
  const subscriptionsToPause = await prisma.copySubscription.findMany({
    where: { userId, enabled: true },
    include: { leader: { select: { address: true } } },
  });
  if (subscriptionsToPause.length === 0) {
    return false;
  }

  const pausedAt = new Date();
  const reason = errorMsg.slice(0, 500);

  await prisma.$transaction([
    (prisma as any).copySubscription.updateMany({
      where: { userId, enabled: true },
      data: {
        enabled: false,
        fundingPausedAt: pausedAt,
        fundingPausedCode: errorCode,
        fundingPausedReason: reason,
        fundingWarningAt: null,
        fundingWarningCode: null,
        fundingWarningReason: null,
      },
    }),
    prisma.copyRelation.updateMany({
      where: { followerUserId: userId, isActive: true },
      data: { isActive: false },
    }),
  ]);

  for (const sub of subscriptionsToPause) {
    await publishRobotControlEvent({
      subscriptionId: sub.id,
      event: 'pause',
      userId,
      leaderId: sub.leaderId,
      leaderAddress: sub.leader.address,
    });
  }

  console.warn('[copy-funding-monitor] paused all copy subscriptions for user', {
    userId,
    errorCode,
    activeSubscriptions: subscriptionsToPause.length,
  });

  await recordAuditEvent({
    actorType: 'COPY_FUNDING_MONITOR',
    actorId: String(userId),
    userId,
    action: 'COPY_TRADING_PAUSED_FUNDING',
    targetType: 'User',
    targetId: String(userId),
    result: 'paused',
    reasonCode: errorCode,
    metadata: { errorMsg: reason, pausedAt: pausedAt.toISOString() },
  });

  recordAdminActivity({
    eventType: 'copy.paused',
    title: 'Copy Trading Paused',
    level: 'warning',
    actorType: 'system',
    actorId: 'COPY_FUNDING_MONITOR',
    targetType: 'User',
    targetId: String(userId),
    content: errorCode,
  });

  return true;
}

export async function clearCopyFundingPause(params: { userId: number }): Promise<void> {
  await (prisma as any).copySubscription.updateMany({
    where: { userId: params.userId },
    data: {
      fundingPausedAt: null,
      fundingPausedCode: null,
      fundingPausedReason: null,
    },
  });
}

export async function markUserCopyTradingFundingWarning(params: {
  userId: number;
  errorCode: string;
  errorMsg: string;
}): Promise<number> {
  const warnedAt = new Date();
  const reason = params.errorMsg.slice(0, 500);
  const updated = await (prisma as any).copySubscription.updateMany({
    where: { userId: params.userId, enabled: true, deletedAt: null },
    data: {
      fundingWarningAt: warnedAt,
      fundingWarningCode: params.errorCode,
      fundingWarningReason: reason,
    },
  });

  if (updated.count > 0) {
    console.warn('[copy-funding-monitor] marked copy subscriptions funding-warning', {
      userId: params.userId,
      errorCode: params.errorCode,
      activeSubscriptions: updated.count,
    });
    await recordAuditEvent({
      actorType: 'COPY_FUNDING_MONITOR',
      actorId: String(params.userId),
      userId: params.userId,
      action: 'COPY_TRADING_FUNDING_WARNING',
      targetType: 'User',
      targetId: String(params.userId),
      result: 'warned',
      reasonCode: params.errorCode,
      metadata: { errorMsg: reason, warnedAt: warnedAt.toISOString() },
    });
  }

  return updated.count;
}

async function publishRobotReloadAfterFundingWarningClear(userId: number): Promise<void> {
  const subscriptions = await prisma.copySubscription.findMany({
    where: { userId, enabled: true, deletedAt: null },
    include: { leader: { select: { address: true } } },
  });
  for (const sub of subscriptions) {
    await publishRobotControlEvent({
      subscriptionId: sub.id,
      event: 'modify',
      userId,
      leaderId: sub.leaderId,
      leaderAddress: sub.leader.address,
    });
  }
}

export async function clearCopyFundingWarning(params: { userId: number }): Promise<void> {
  const updated = await (prisma as any).copySubscription.updateMany({
    where: { userId: params.userId, fundingWarningAt: { not: null } },
    data: {
      fundingWarningAt: null,
      fundingWarningCode: null,
      fundingWarningReason: null,
    },
  });
  if (updated.count > 0) {
    await publishRobotReloadAfterFundingWarningClear(params.userId);
  }
}

export async function clearCopyFundingWarningForCode(params: {
  userId: number;
  errorCode: string;
}): Promise<void> {
  const updated = await (prisma as any).copySubscription.updateMany({
    where: { userId: params.userId, fundingWarningCode: params.errorCode },
    data: {
      fundingWarningAt: null,
      fundingWarningCode: null,
      fundingWarningReason: null,
    },
  });
  if (updated.count > 0) {
    await publishRobotReloadAfterFundingWarningClear(params.userId);
  }
}

/** 恢复因资金/Gas 自动暂停的订阅（扫块模式下改为仅预警，不再长期 disabled）。 */
export async function resumeUserCopyTradingFromAutoFundingPause(params: {
  userId: number;
  fundingPausedCode?: string;
}): Promise<number> {
  const { userId, fundingPausedCode } = params;
  const subscriptions = await (prisma as any).copySubscription.findMany({
    where: {
      userId,
      enabled: false,
      deletedAt: null,
      fundingPausedAt: { not: null },
      ...(fundingPausedCode ? { fundingPausedCode } : {}),
    },
    include: { leader: { select: { address: true } } },
  });

  if (subscriptions.length === 0) {
    return 0;
  }

  const ids = subscriptions.map((sub: { id: string }) => sub.id);
  const leaderAddresses = subscriptions.map(
    (sub: { leader: { address: string } }) => sub.leader.address.toLowerCase()
  );

  await prisma.$transaction([
    (prisma as any).copySubscription.updateMany({
      where: {
        id: { in: ids },
        fundingPausedAt: { not: null },
        ...(fundingPausedCode ? { fundingPausedCode } : {}),
      },
      data: {
        enabled: true,
        fundingPausedAt: null,
        fundingPausedCode: null,
        fundingPausedReason: null,
        fundingWarningAt: null,
        fundingWarningCode: null,
        fundingWarningReason: null,
      },
    }),
    prisma.copyRelation.updateMany({
      where: { followerUserId: userId, leaderAddress: { in: leaderAddresses } },
      data: { isActive: true },
    }),
  ]);

  for (const sub of subscriptions) {
    await publishRobotControlEvent({
      subscriptionId: sub.id,
      event: 'resume',
      userId,
      leaderId: sub.leaderId,
      leaderAddress: sub.leader.address,
    });
  }

  console.info('[copy-funding-monitor] resumed auto-funding-paused copy subscriptions', {
    userId,
    fundingPausedCode: fundingPausedCode ?? 'any',
    resumedSubscriptions: subscriptions.length,
  });

  await recordAuditEvent({
    actorType: 'COPY_FUNDING_MONITOR',
    actorId: String(userId),
    userId,
    action: 'COPY_TRADING_RESUMED_FUNDING_RECHARGE',
    targetType: 'User',
    targetId: String(userId),
    result: 'resumed',
    reasonCode: fundingPausedCode ?? 'auto_funding_pause',
    metadata: { resumedSubscriptions: subscriptions.length },
  });

  return subscriptions.length;
}

export async function resumeUserCopyTradingPausedForGas(params: {
  userId: number;
}): Promise<number> {
  return resumeUserCopyTradingFromAutoFundingPause({
    userId: params.userId,
    fundingPausedCode: COPY_GAS_INSUFFICIENT_ERROR_CODE,
  });
}

export async function syncCopyTradingGasFundingState(params: {
  userId: number;
  funding?: CopyFundingSnapshot;
}): Promise<void> {
  const funding = params.funding ?? (await getCopyFundingSnapshot(params.userId, { readOnly: true }));
  if (funding.hasGas) {
    await clearCopyFundingWarningForCode({
      userId: params.userId,
      errorCode: COPY_GAS_INSUFFICIENT_ERROR_CODE,
    });
    return;
  }
  await markUserCopyTradingFundingWarning({
    userId: params.userId,
    errorCode: COPY_GAS_INSUFFICIENT_ERROR_CODE,
    errorMsg: describeCopyFundingOperationalFailure(funding),
  });
}

/** After sell proceeds / deposit refresh: clear USDC funding warnings when balance is operational again. */
export async function syncCopyTradingCollateralFundingState(params: {
  userId: number;
  funding?: CopyFundingSnapshot;
}): Promise<void> {
  invalidatePolymarketDepositUsdcBalanceCache(params.userId);
  invalidateCopyFundingPrecheckCache(params.userId);
  const funding =
    params.funding ?? (await getCopyFundingSnapshot(params.userId, { readOnly: false }));
  if (!funding.hasOperationalUsdc) return;
  await clearCopyFundingWarningForCode({
    userId: params.userId,
    errorCode: COPY_COLLATERAL_INSUFFICIENT_WARNING_CODE,
  });
  await clearCopyFundingWarningForCode({
    userId: params.userId,
    errorCode: COPY_FUNDS_EMPTY_ERROR_CODE,
  });
  await clearCopyFundingWarningForCode({
    userId: params.userId,
    errorCode: 'user_insufficient_balance',
  });
}

/**
 * 闈炵儹璺緞锛氳祫閲戝揩鐓т笉瓒虫椂鏆傚仠锛堝鍓嶇杞 funding-status锛夈€?
 * 涓嶅湪姣忕瑪 dispatch 鍓嶆墦 RPC銆?
 */
export async function pauseUserCopyTradingIfFundingInsufficient(params: {
  userId: number;
  funding?: CopyFundingSnapshot;
}): Promise<boolean> {
  await syncCopyTradingGasFundingState(params);
  return false;
}

export async function maybePauseCopyTradingAfterOrderFailure(params: {
  userId: number;
  errorCode: string | null | undefined;
  errorMsg: string | null | undefined;
  terminal: boolean;
}): Promise<void> {
  if (!params.terminal) return;
  const code = params.errorCode?.trim();
  if (code !== COPY_GAS_INSUFFICIENT_ERROR_CODE) return;
  await markUserCopyTradingFundingWarning({
    userId: params.userId,
    errorCode: code,
    errorMsg:
      params.errorMsg?.trim() ||
      '平台 Gas 不足，买单已跳过；有持仓时仍可跟卖，请充值 Gas 后恢复买入。',
  });
}
