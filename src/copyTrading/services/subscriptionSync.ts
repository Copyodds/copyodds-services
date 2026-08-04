import { Prisma, type CopyMode } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { createConflictError } from '../../utils/appError';
import {
  copyLeaderDisplayUpdateData,
  loadCopyLeaderDisplaySnapshot,
} from './copyLeaderDisplaySnapshot';

export const COPY_MIN_NOTIONAL_MODES = ['SKIP', 'BUMP_TO_MIN'] as const;
export type CopyMinNotionalMode = (typeof COPY_MIN_NOTIONAL_MODES)[number];

/** 单用户同时开启的跟单规则上限（enabled + 未软删 + Leader 未停用） */
export const MAX_ENABLED_COPY_SUBSCRIPTIONS_PER_USER = 50;

export function normalizeCopyMinNotionalMode(
  value: string | null | undefined,
  copyMode: CopyMode | undefined
): CopyMinNotionalMode {
  return 'BUMP_TO_MIN';
}

export async function countEnabledCopySubscriptionsForUser(userId: number): Promise<number> {
  return prisma.copySubscription.count({
    where: {
      userId,
      deletedAt: null,
      enabled: true,
      leader: { enabled: true },
    },
  });
}

/** 新开或恢复跟单前检查；已开启的同一 leader 更新参数不受限 */
export async function assertCanEnableCopySubscription(
  userId: number,
  leaderAddress: string
): Promise<void> {
  const addr = leaderAddress.toLowerCase();
  const existing = await prisma.copySubscription.findFirst({
    where: { userId, deletedAt: null, leader: { address: addr } },
    select: { enabled: true },
  });
  if (existing?.enabled) {
    return;
  }

  const activeCount = await countEnabledCopySubscriptionsForUser(userId);
  if (activeCount >= MAX_ENABLED_COPY_SUBSCRIPTIONS_PER_USER) {
    throw createConflictError(
      `最多同时开启 ${MAX_ENABLED_COPY_SUBSCRIPTIONS_PER_USER} 个跟单规则，请先暂停或删除其他规则。`,
      {
        max: MAX_ENABLED_COPY_SUBSCRIPTIONS_PER_USER,
        activeCount,
      }
    );
  }
}

/** 与 POST /copy-trade/relations 同步：维护 CopyLeader + CopySubscription（事件驱动跟单） */
export async function ensureLeaderAndSubscriptionForUser(opts: {
  userId: number;
  leaderAddress: string;
  enabled?: boolean;
  ruleName?: string | null;
  note?: string | null;
  copyMode?: CopyMode;
  copyRatio?: number;
  fixedAmountUsd?: number | null;
  minNotionalMode?: CopyMinNotionalMode;
  minAmountUsd?: number | null;
  maxAmount?: number | null;
  maxAmountPerMarketUsd?: number | null;
  dailyTotalCapUsd?: number | null;
  slippage?: number | null;
  delayMs?: number;
  marketCooldownMinutes?: number | null;
  pauseAfterConsecutiveFails?: number | null;
  skipBuyIfOpenPosition?: boolean;
  onlyBuy?: boolean;
  onlySell?: boolean;
}) {
  const addr = opts.leaderAddress.toLowerCase();
  const displaySnapshot = await loadCopyLeaderDisplaySnapshot(addr);
  const displayUpdate = displaySnapshot
    ? copyLeaderDisplayUpdateData(displaySnapshot)
    : {};
  const leader = await prisma.copyLeader.upsert({
    where: { address: addr },
    create: {
      address: addr,
      enabled: true,
      displayName: displaySnapshot?.displayName ?? null,
      xUsername: displaySnapshot?.xUsername ?? null,
      tier: displaySnapshot?.tier ?? null,
    },
    update: {
      enabled: true,
      ...displayUpdate,
    },
  });

  const existing = await prisma.copySubscription.findUnique({
    where: { userId_leaderId: { userId: opts.userId, leaderId: leader.id } },
  });

  const ratioDec: Prisma.Decimal | undefined =
    opts.copyRatio != null
      ? new Prisma.Decimal(opts.copyRatio)
      : existing
        ? undefined
        : new Prisma.Decimal(1);

  const ruleName =
    opts.ruleName === undefined ? undefined : opts.ruleName === null ? null : opts.ruleName.trim();
  const note =
    opts.note === undefined ? undefined : opts.note === null ? null : opts.note.trim();
  const copyMode = opts.copyMode ?? undefined;
  const effectiveCopyMode = copyMode ?? existing?.copyMode ?? 'RATIO';
  const minNotionalMode = normalizeCopyMinNotionalMode(
    opts.minNotionalMode ?? existing?.minNotionalMode,
    effectiveCopyMode
  );

  const fixedAmountDec =
    opts.fixedAmountUsd === undefined
      ? undefined
      : opts.fixedAmountUsd === null
        ? null
        : new Prisma.Decimal(opts.fixedAmountUsd);

  const minAmountDec =
    opts.minAmountUsd === undefined
      ? undefined
      : opts.minAmountUsd === null
        ? null
        : new Prisma.Decimal(opts.minAmountUsd);

  const maxDec =
    opts.maxAmount === undefined
      ? undefined
      : opts.maxAmount === null
        ? null
        : new Prisma.Decimal(opts.maxAmount);

  const maxAmountPerMarketDec =
    opts.maxAmountPerMarketUsd === undefined
      ? undefined
      : opts.maxAmountPerMarketUsd === null
        ? null
        : new Prisma.Decimal(opts.maxAmountPerMarketUsd);

  const dailyTotalCapDec =
    opts.dailyTotalCapUsd === undefined
      ? undefined
      : opts.dailyTotalCapUsd === null
        ? null
        : new Prisma.Decimal(opts.dailyTotalCapUsd);

  const slipDec =
    opts.slippage === undefined
      ? existing
        ? undefined
        : new Prisma.Decimal(CONFIG.copyDefaultSlippage)
      : opts.slippage === null
        ? new Prisma.Decimal(CONFIG.copyDefaultSlippage)
        : new Prisma.Decimal(opts.slippage);

  const delayMs = opts.delayMs ?? existing?.delayMs ?? 0;
  const marketCooldownMinutes =
    opts.marketCooldownMinutes === undefined ? undefined : opts.marketCooldownMinutes;
  const pauseAfterConsecutiveFails =
    opts.pauseAfterConsecutiveFails === undefined ? undefined : opts.pauseAfterConsecutiveFails;
  const skipBuyIfOpenPosition =
    opts.skipBuyIfOpenPosition ?? existing?.skipBuyIfOpenPosition ?? true;
  const onlyBuy = opts.onlyBuy ?? existing?.onlyBuy ?? false;
  const onlySell = opts.onlySell ?? existing?.onlySell ?? false;

  const effectiveEnabled = opts.enabled ?? existing?.enabled ?? true;

  if (effectiveEnabled) {
    await assertCanEnableCopySubscription(opts.userId, addr);
  }

  const createData = {
    userId: opts.userId,
    leaderId: leader.id,
    ruleName: ruleName ?? undefined,
    note: note ?? undefined,
    copyMode: copyMode ?? 'RATIO',
    copyRatio: ratioDec ?? new Prisma.Decimal(1),
    fixedAmountUsd: fixedAmountDec ?? undefined,
    minNotionalMode,
    minAmountUsd: minAmountDec ?? undefined,
    maxAmount: maxDec ?? undefined,
    maxAmountPerMarketUsd: maxAmountPerMarketDec ?? undefined,
    dailyTotalCapUsd: dailyTotalCapDec ?? undefined,
    slippage: slipDec ?? undefined,
    delayMs,
    marketCooldownMinutes: marketCooldownMinutes ?? undefined,
    pauseAfterConsecutiveFails: pauseAfterConsecutiveFails ?? undefined,
    skipBuyIfOpenPosition,
    onlyBuy,
    onlySell,
    enabled: effectiveEnabled,
    deletedAt: null,
  };

  const clearFundingPause =
    opts.enabled !== undefined
      ? {
          fundingPausedAt: null,
          fundingPausedCode: null,
          fundingPausedReason: null,
          fundingWarningAt: null,
          fundingWarningCode: null,
          fundingWarningReason: null,
        }
      : {};

  const updateData = {
    deletedAt: null,
    ...clearFundingPause,
    ...(ruleName !== undefined && { ruleName }),
    ...(note !== undefined && { note }),
    ...(copyMode !== undefined && { copyMode }),
    ...(opts.minNotionalMode !== undefined && { minNotionalMode }),
    ...(copyMode === 'RATIO' && { fixedAmountUsd: null }),
    ...(copyMode === 'FIXED_AMOUNT' && { copyRatio: new Prisma.Decimal(1) }),
    ...(ratioDec !== undefined && { copyRatio: ratioDec }),
    ...(fixedAmountDec !== undefined && { fixedAmountUsd: fixedAmountDec }),
    ...(minAmountDec !== undefined && { minAmountUsd: minAmountDec }),
    ...(maxDec !== undefined && { maxAmount: maxDec }),
    ...(maxAmountPerMarketDec !== undefined && {
      maxAmountPerMarketUsd: maxAmountPerMarketDec,
    }),
    ...(dailyTotalCapDec !== undefined && {
      dailyTotalCapUsd: dailyTotalCapDec,
    }),
    ...(opts.slippage !== undefined && {
      slippage: slipDec,
    }),
    ...(opts.delayMs !== undefined && { delayMs }),
    ...(marketCooldownMinutes !== undefined && { marketCooldownMinutes }),
    ...(pauseAfterConsecutiveFails !== undefined && {
      pauseAfterConsecutiveFails,
    }),
    ...(opts.skipBuyIfOpenPosition !== undefined && { skipBuyIfOpenPosition }),
    ...(opts.onlyBuy !== undefined && { onlyBuy }),
    ...(opts.onlySell !== undefined && { onlySell }),
    ...(opts.enabled !== undefined && { enabled: effectiveEnabled }),
  };

  const subscription = await prisma.copySubscription.upsert({
    where: {
      userId_leaderId: { userId: opts.userId, leaderId: leader.id },
    },
    create: createData,
    update: existing ? updateData : createData,
  });

  return {
    leaderId: leader.id,
    subscriptionId: subscription.id,
    leaderAddress: addr,
    enabled: subscription.enabled,
    wasCreated: !existing,
    previousEnabled: existing?.enabled ?? null,
  };
}
