import { prisma } from '../../db';

/** 同一持仓自动兑换连续失败达到此次数后不再自动重试。 */
export const AUTO_REDEEM_MAX_FAILURES = 3;

export function normalizeRedeemConditionId(conditionId: string): string {
  return conditionId.trim().toLowerCase();
}

export function isAutoRedeemDisabledByFailures(failCount: number): boolean {
  return failCount >= AUTO_REDEEM_MAX_FAILURES;
}

export async function getAutoRedeemFailCount(params: {
  userId: number;
  conditionId: string;
  outcomeIndex: number;
}): Promise<number> {
  const row = await prisma.polymarketRedeemAttemptState.findUnique({
    where: {
      userId_conditionId_outcomeIndex: {
        userId: params.userId,
        conditionId: normalizeRedeemConditionId(params.conditionId),
        outcomeIndex: params.outcomeIndex,
      },
    },
    select: { failCount: true },
  });
  return row?.failCount ?? 0;
}

export async function shouldSkipAutoRedeemForFailures(params: {
  userId: number;
  conditionId: string;
  outcomeIndex: number;
}): Promise<boolean> {
  const failCount = await getAutoRedeemFailCount(params);
  return isAutoRedeemDisabledByFailures(failCount);
}

export async function recordAutoRedeemFailure(params: {
  userId: number;
  conditionId: string;
  outcomeIndex: number;
  error?: string;
}): Promise<{ failCount: number; disabled: boolean }> {
  const conditionId = normalizeRedeemConditionId(params.conditionId);
  const lastError = (params.error ?? '').trim().slice(0, 500) || null;
  const now = new Date();
  const row = await prisma.polymarketRedeemAttemptState.upsert({
    where: {
      userId_conditionId_outcomeIndex: {
        userId: params.userId,
        conditionId,
        outcomeIndex: params.outcomeIndex,
      },
    },
    create: {
      userId: params.userId,
      conditionId,
      outcomeIndex: params.outcomeIndex,
      failCount: 1,
      lastError,
      lastFailedAt: now,
    },
    update: {
      failCount: { increment: 1 },
      lastError,
      lastFailedAt: now,
    },
    select: { failCount: true },
  });
  return {
    failCount: row.failCount,
    disabled: isAutoRedeemDisabledByFailures(row.failCount),
  };
}

/** 赎回成功（自动或手动）后清零失败计数，允许后续新仓位逻辑干净。 */
export async function clearAutoRedeemFailures(params: {
  userId: number;
  conditionId: string;
  outcomeIndex?: number;
}): Promise<void> {
  const conditionId = normalizeRedeemConditionId(params.conditionId);
  if (params.outcomeIndex != null) {
    await prisma.polymarketRedeemAttemptState.deleteMany({
      where: {
        userId: params.userId,
        conditionId,
        outcomeIndex: params.outcomeIndex,
      },
    });
    return;
  }
  await prisma.polymarketRedeemAttemptState.deleteMany({
    where: { userId: params.userId, conditionId },
  });
}
