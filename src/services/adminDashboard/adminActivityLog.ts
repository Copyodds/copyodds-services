import type { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import type { AdminActivityEventType, AdminActivityLevel } from './types';

export type RecordAdminActivityInput = {
  eventType: AdminActivityEventType | string;
  title: string;
  content?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  level?: AdminActivityLevel;
  metadata?: Prisma.InputJsonValue;
};

export type RecordAdminAlertInput = {
  alertType: string;
  title: string;
  content?: string | null;
  level?: AdminActivityLevel;
  source?: string | null;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

/** 脱敏：仅保留钱包前 4 + 后 4 字符 */
export function maskWalletAddress(address: string): string {
  const raw = address.trim();
  if (raw.length <= 10) {
    return raw;
  }
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

/** 非阻塞写入活动日志 */
export function recordAdminActivity(input: RecordAdminActivityInput): void {
  void prisma.adminActivityLog
    .create({
      data: {
        eventType: input.eventType,
        title: input.title,
        content: input.content ?? null,
        actorType: input.actorType ?? null,
        actorId: input.actorId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        level: input.level ?? 'info',
        metadata: input.metadata ?? undefined,
      },
    })
    .catch((err) => {
      console.warn('[admin-activity] write failed', {
        eventType: input.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/** 非阻塞写入开放告警 */
export function recordAdminAlert(input: RecordAdminAlertInput): void {
  void prisma.adminAlert
    .create({
      data: {
        alertType: input.alertType,
        title: input.title,
        content: input.content ?? null,
        level: input.level ?? 'warning',
        status: 'open',
        source: input.source ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? undefined,
      },
    })
    .catch((err) => {
      console.warn('[admin-alert] write failed', {
        alertType: input.alertType,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
