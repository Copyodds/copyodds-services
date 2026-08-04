/**
 * 交易/跟单审计事件与风险事件写入（原 services/admin/audit 中非 Admin 路由依赖部分）。
 * Admin HTTP 已迁移至 polymarket-admin-api；此处仅保留主 API 与 worker 仍会调用的记录函数。
 */
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { decimalToString } from '../../utils/format';

type RecordAuditEventInput = {
  actorType: string;
  actorId?: string | null;
  userId?: number | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  result: string;
  reasonCode?: string | null;
  metadata?: Prisma.InputJsonValue;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

type RecordRiskEventInput = {
  userId?: number | null;
  leaderId?: string | null;
  subscriptionId?: string | null;
  leaderTradeId?: string | null;
  copyTradeRowId?: string | null;
  source: string;
  result: string;
  reasonCode?: string | null;
  marketId?: string | null;
  tokenId?: string | null;
  side?: string | null;
  notionalUsd?: Prisma.Decimal | number | string | null;
  thresholdSnapshot?: Prisma.InputJsonValue;
  inputSnapshot?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
};

export async function recordAuditEvent(input: RecordAuditEventInput) {
  await prisma.auditEvent.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      userId: input.userId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      result: input.result,
      reasonCode: input.reasonCode ?? null,
      metadata: input.metadata ?? undefined,
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

export async function recordRiskEvent(input: RecordRiskEventInput) {
  await prisma.riskEvent.create({
    data: {
      userId: input.userId ?? null,
      leaderId: input.leaderId ?? null,
      subscriptionId: input.subscriptionId ?? null,
      leaderTradeId: input.leaderTradeId ?? null,
      copyTradeRowId: input.copyTradeRowId ?? null,
      source: input.source,
      result: input.result,
      reasonCode: input.reasonCode ?? null,
      marketId: input.marketId ?? null,
      tokenId: input.tokenId ?? null,
      side: input.side ?? null,
      notionalUsd:
        input.notionalUsd == null ? null : new Prisma.Decimal(String(input.notionalUsd)),
      thresholdSnapshot: input.thresholdSnapshot ?? undefined,
      inputSnapshot: input.inputSnapshot ?? undefined,
      metadata: input.metadata ?? undefined,
    },
  });
}
