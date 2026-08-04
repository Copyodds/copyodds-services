import { Prisma } from '../../generated/prisma/client';
import type { LeaderRiskStatus, TradingSystemMode } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { recordAdminActivity } from '../adminDashboard/adminActivityLog';
import { CONFIG } from '../../config/env';

export const SYSTEM_CONTROL_KEY = 'GLOBAL_TRADING';

const MODE_PRIORITY: Record<TradingSystemMode, number> = {
  NORMAL: 0,
  TRACK_ONLY: 1,
  PAUSED: 2,
};

export type EffectiveSystemControl = {
  key: string;
  mode: TradingSystemMode;
  reason: string | null;
  source: 'env' | 'db' | 'env+db';
  restoreAt: string | null;
  updatedAt: string | null;
  envMode: TradingSystemMode;
};

export type EffectiveLeaderRiskState = {
  leaderId: string | null;
  status: LeaderRiskStatus;
  reasonCode: string | null;
  note: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
};

function chooseMostRestrictiveMode(left: TradingSystemMode, right: TradingSystemMode): TradingSystemMode {
  return MODE_PRIORITY[left] >= MODE_PRIORITY[right] ? left : right;
}

export function getConfiguredTradingSystemMode(): TradingSystemMode {
  return CONFIG.tradingSystemMode;
}

export async function getEffectiveSystemControl(): Promise<EffectiveSystemControl> {
  const envMode = getConfiguredTradingSystemMode();
  const control = await prisma.systemControl.findUnique({
    where: { key: SYSTEM_CONTROL_KEY },
  });

  if (!control) {
    return {
      key: SYSTEM_CONTROL_KEY,
      mode: envMode,
      reason: null,
      source: 'env',
      restoreAt: null,
      updatedAt: null,
      envMode,
    };
  }

  const mode = chooseMostRestrictiveMode(envMode, control.mode);
  return {
    key: control.key,
    mode,
    reason: control.reason ?? null,
    source: mode === control.mode && envMode === 'NORMAL' ? 'db' : 'env+db',
    restoreAt: control.restoreAt?.toISOString() ?? null,
    updatedAt: control.updatedAt.toISOString(),
    envMode,
  };
}

export async function setSystemControlMode(input: {
  mode: TradingSystemMode;
  reason?: string | null;
  restoreAt?: Date | null;
  metadata?: Prisma.InputJsonValue;
  adminUserId?: string | null;
}) {
  return prisma.systemControl.upsert({
    where: { key: SYSTEM_CONTROL_KEY },
    update: {
      mode: input.mode,
      reason: input.reason ?? null,
      restoreAt: input.restoreAt ?? null,
      metadata: input.metadata ?? undefined,
      updatedByAdminUserId: input.adminUserId ?? null,
    },
    create: {
      key: SYSTEM_CONTROL_KEY,
      mode: input.mode,
      reason: input.reason ?? null,
      restoreAt: input.restoreAt ?? null,
      metadata: input.metadata ?? undefined,
      updatedByAdminUserId: input.adminUserId ?? null,
    },
  });
}

export async function getEffectiveLeaderRiskStateByAddress(
  leaderAddress: string
): Promise<EffectiveLeaderRiskState> {
  const normalizedAddress = leaderAddress.trim().toLowerCase();
  const leader = await prisma.copyLeader.findUnique({
    where: { address: normalizedAddress },
    include: {
      riskState: true,
    },
  });

  if (!leader?.riskState) {
    return {
      leaderId: leader?.id ?? null,
      status: 'ACTIVE',
      reasonCode: null,
      note: null,
      expiresAt: null,
      updatedAt: null,
    };
  }

  const expired =
    leader.riskState.expiresAt != null && leader.riskState.expiresAt.getTime() <= Date.now();
  if (expired) {
    return {
      leaderId: leader.id,
      status: 'ACTIVE',
      reasonCode: null,
      note: leader.riskState.note ?? null,
      expiresAt: leader.riskState.expiresAt?.toISOString() ?? null,
      updatedAt: leader.riskState.updatedAt.toISOString(),
    };
  }

  return {
    leaderId: leader.id,
    status: leader.riskState.status,
    reasonCode: leader.riskState.reasonCode ?? null,
    note: leader.riskState.note ?? null,
    expiresAt: leader.riskState.expiresAt?.toISOString() ?? null,
    updatedAt: leader.riskState.updatedAt.toISOString(),
  };
}

export async function upsertLeaderRiskState(input: {
  leaderId: string;
  status: LeaderRiskStatus;
  reasonCode?: string | null;
  note?: string | null;
  expiresAt?: Date | null;
  metadata?: Prisma.InputJsonValue;
  adminUserId?: string | null;
}) {
  return prisma.leaderRiskState.upsert({
    where: { leaderId: input.leaderId },
    update: {
      status: input.status,
      reasonCode: input.reasonCode ?? null,
      note: input.note ?? null,
      expiresAt: input.expiresAt ?? null,
      metadata: input.metadata ?? undefined,
      updatedByAdminUserId: input.adminUserId ?? null,
    },
    create: {
      leaderId: input.leaderId,
      status: input.status,
      reasonCode: input.reasonCode ?? null,
      note: input.note ?? null,
      expiresAt: input.expiresAt ?? null,
      metadata: input.metadata ?? undefined,
      updatedByAdminUserId: input.adminUserId ?? null,
    },
  });
}

export async function updateUserTradingRestriction(input: {
  userId: number;
  tradingDisabled: boolean;
  tradingDisabledReason?: string | null;
  tradingDisabledUntil?: Date | null;
}) {
  const before = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      username: true,
      tradingDisabled: true,
      tradingDisabledReason: true,
      tradingDisabledUntil: true,
      updatedAt: true,
    },
  });

  if (!before) {
    return null;
  }

  const after = await prisma.user.update({
    where: { id: input.userId },
    data: {
      tradingDisabled: input.tradingDisabled,
      tradingDisabledReason: input.tradingDisabled ? input.tradingDisabledReason ?? null : null,
      tradingDisabledUntil: input.tradingDisabled ? input.tradingDisabledUntil ?? null : null,
    },
    select: {
      id: true,
      username: true,
      tradingDisabled: true,
      tradingDisabledReason: true,
      tradingDisabledUntil: true,
      updatedAt: true,
    },
  });

  if (input.tradingDisabled && !before.tradingDisabled) {
    recordAdminActivity({
      eventType: 'user.frozen',
      title: 'User Trading Frozen',
      level: 'warning',
      actorType: 'admin',
      targetType: 'User',
      targetId: String(input.userId),
      content: input.tradingDisabledReason ?? undefined,
    });
  }

  return { before, after };
}

export function isUserTradingDisabled(user: {
  tradingDisabled: boolean;
  tradingDisabledUntil: Date | null;
}): boolean {
  if (!user.tradingDisabled) {
    return false;
  }
  if (!user.tradingDisabledUntil) {
    return true;
  }
  return user.tradingDisabledUntil.getTime() > Date.now();
}
