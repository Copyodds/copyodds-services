import { prisma } from '../../db';

export const USER_TRADE_ERROR = {
  FROZEN: 'USER_TRADE_FROZEN',
  REVIEW: 'USER_UNDER_REVIEW',
} as const;

export type UserTradePermissionErrorCode =
  (typeof USER_TRADE_ERROR)[keyof typeof USER_TRADE_ERROR];

export class UserTradePermissionError extends Error {
  constructor(
    public readonly errorCode: UserTradePermissionErrorCode,
    message: string,
    public readonly tradeStatus: string
  ) {
    super(message);
    this.name = 'UserTradePermissionError';
  }
}

export function isUserTradePermissionError(error: unknown): error is UserTradePermissionError {
  return error instanceof UserTradePermissionError;
}

function isTimedFreezeExpired(frozenUntil: Date | null, now: Date): boolean {
  return frozenUntil != null && frozenUntil.getTime() <= now.getTime();
}

async function autoRestoreExpiredFreeze(userId: number, now: Date): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        tradeStatus: 'NORMAL',
        tradingDisabled: false,
        tradingDisabledUntil: null,
        riskUpdatedAt: now,
      },
    }),
    prisma.userRiskLog.create({
      data: {
        userId,
        adminId: null,
        action: 'RESTORE_NORMAL',
        beforeStatus: 'FROZEN',
        afterStatus: 'NORMAL',
        reason: 'AUTO_EXPIRED',
        remark: '冻结时间到期自动恢复',
      },
    }),
  ]);
}

/**
 * 统一交易权限校验：FROZEN 禁止交易；REVIEW 禁止交易；到期自动恢复 NORMAL。
 */
export async function checkUserTradePermission(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      tradeStatus: true,
      tradingDisabled: true,
      tradingDisabledReason: true,
      tradingDisabledUntil: true,
      frozenUntil: true,
      frozenRemark: true,
      frozenReason: true,
      riskReviewReason: true,
    },
  });

  if (!user) {
    throw new UserTradePermissionError(USER_TRADE_ERROR.FROZEN, '用户不存在。', 'UNKNOWN');
  }

  const now = new Date();
  let status = (user.tradeStatus ?? 'NORMAL').toUpperCase();

  // 兼容旧数据：仅有 tradingDisabled 无 tradeStatus
  if (status === 'NORMAL' && user.tradingDisabled) {
    if (user.tradingDisabledUntil && user.tradingDisabledUntil.getTime() <= now.getTime()) {
      await autoRestoreExpiredFreeze(userId, now);
      return;
    }
    status = 'FROZEN';
  }

  if (status === 'FROZEN') {
    const until = user.frozenUntil ?? user.tradingDisabledUntil;
    if (isTimedFreezeExpired(until, now)) {
      await autoRestoreExpiredFreeze(userId, now);
      return;
    }
    const msg =
      user.frozenRemark?.trim() ||
      user.tradingDisabledReason?.trim() ||
      user.frozenReason?.trim() ||
      '用户交易权限已被冻结';
    throw new UserTradePermissionError(USER_TRADE_ERROR.FROZEN, msg, 'FROZEN');
  }

  if (status === 'REVIEW') {
    const msg = user.riskReviewReason?.trim() || '用户正在风控复核中';
    throw new UserTradePermissionError(USER_TRADE_ERROR.REVIEW, msg, 'REVIEW');
  }
}
