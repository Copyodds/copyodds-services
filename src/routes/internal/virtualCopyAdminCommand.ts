import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { adminAuth, type AdminAuthLocals } from '../../middlewares/adminAuth';
import { Code, fail, success } from '../../utils/response';
import {
  archiveOwnedVirtualAccount,
  moneyStrings,
  VirtualCopyDomainError,
} from '../../virtualCopyTrading/virtualAccountService';
import { invalidateVirtualCopyQueryCache } from '../../virtualCopyTrading/virtualCopyQueryService';

export const internalVirtualCopyAdminRouter = Router();
internalVirtualCopyAdminRouter.use(adminAuth);

const idSchema = z.string().uuid();
const commandSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  requestId: z.string().trim().min(8).max(128),
}).strict();

function adminLocals(res: Response): AdminAuthLocals {
  return res.locals.adminAuth as AdminAuthLocals;
}

function command(
  handler: (req: Request, res: Response) => Promise<void>,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!CONFIG.virtualCopyAccountsEnabled) {
        fail(res, Code.FEATURE_DISABLED, 'Virtual copy trading is disabled', 404);
        return;
      }
      await handler(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) {
        fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
          details: error.flatten(),
        });
        return;
      }
      if (error instanceof VirtualCopyDomainError) {
        fail(
          res,
          error.code === 'NOT_FOUND' ? Code.NOT_FOUND : Code.STATE_CONFLICT,
          error.message,
          error.httpStatus,
        );
        return;
      }
      next(error);
    }
  };
}

function accountAuditSnapshot(account: {
  id: string;
  userId: number;
  status: string;
  version: number;
  expiresAt: Date;
  archivedAt: Date | null;
}) {
  return {
    id: account.id,
    userId: account.userId,
    status: account.status,
    version: account.version,
    expiresAt: account.expiresAt.toISOString(),
    archivedAt: account.archivedAt?.toISOString() ?? null,
  };
}

async function existingAccountCommand(requestId: string, action: string, accountId: string) {
  const audit = await prisma.auditEvent.findFirst({
    where: { requestId, action, targetType: 'VirtualCopyAccount', targetId: accountId, result: 'SUCCESS' },
  });
  if (!audit) return null;
  return prisma.virtualCopyAccount.findUnique({ where: { id: accountId } });
}

for (const action of ['pause', 'resume'] as const) {
  internalVirtualCopyAdminRouter.post(`/accounts/:id/${action}`, command(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const body = commandSchema.parse(req.body ?? {});
    const auditAction = `VIRTUAL_COPY_ACCOUNT_${action.toUpperCase()}`;
    const repeated = await existingAccountCommand(body.requestId, auditAction, id);
    if (repeated) {
      success(res, moneyStrings({ account: repeated, idempotent: true, asOf: new Date() }));
      return;
    }
    const actor = adminLocals(res);
    const account = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{
        id: string;
        userId: number;
        status: string;
        version: number;
        expiresAt: Date;
        archivedAt: Date | null;
      }>>`
        SELECT id, "userId", status::text, version, "expiresAt", "archivedAt"
        FROM "VirtualCopyAccount"
        WHERE id = ${id}
        FOR UPDATE
      `;
      const before = locked[0];
      if (!before) throw new VirtualCopyDomainError('Virtual account not found', 404, 'NOT_FOUND');
      const target = action === 'pause' ? 'PAUSED' : 'ACTIVE';
      if (before.status !== target) {
        const expected = action === 'pause' ? 'ACTIVE' : 'PAUSED';
        if (before.status !== expected) {
          throw new VirtualCopyDomainError(
            `Account cannot ${action} from ${before.status}`,
            409,
            'CONFLICT',
          );
        }
        if (action === 'resume' && before.expiresAt <= new Date()) {
          throw new VirtualCopyDomainError('Expired account cannot be resumed', 409, 'CONFLICT');
        }
      }
      const after = before.status === target
        ? await tx.virtualCopyAccount.findUniqueOrThrow({ where: { id } })
        : await tx.virtualCopyAccount.update({
            where: { id, version: before.version },
            data: { status: target, version: { increment: 1 } },
          });
      await tx.auditEvent.create({
        data: {
          actorType: 'ADMIN',
          actorId: actor.adminUserId,
          userId: before.userId,
          action: auditAction,
          targetType: 'VirtualCopyAccount',
          targetId: id,
          result: 'SUCCESS',
          reasonCode: body.reason,
          requestId: body.requestId,
          ip: req.ip,
          userAgent: req.get('user-agent') ?? null,
          metadata: {
            reason: body.reason,
            before: accountAuditSnapshot(before),
            after: accountAuditSnapshot(after),
          },
        },
      });
      return after;
    });
    invalidateVirtualCopyQueryCache(id);
    success(res, moneyStrings({ account, idempotent: account.status === (
      action === 'pause' ? 'PAUSED' : 'ACTIVE'
    ), asOf: new Date() }));
  }));
}

internalVirtualCopyAdminRouter.post('/accounts/:id/archive', command(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const body = commandSchema.parse(req.body ?? {});
  const action = 'VIRTUAL_COPY_ACCOUNT_ARCHIVE';
  const repeated = await existingAccountCommand(body.requestId, action, id);
  if (repeated) {
    success(res, moneyStrings({ account: repeated, idempotent: true, asOf: new Date() }));
    return;
  }
  const before = await prisma.virtualCopyAccount.findUnique({ where: { id } });
  if (!before) throw new VirtualCopyDomainError('Virtual account not found', 404, 'NOT_FOUND');
  const account = await archiveOwnedVirtualAccount(before.userId, id);
  const actor = adminLocals(res);
  await prisma.auditEvent.create({
    data: {
      actorType: 'ADMIN',
      actorId: actor.adminUserId,
      userId: before.userId,
      action,
      targetType: 'VirtualCopyAccount',
      targetId: id,
      result: 'SUCCESS',
      reasonCode: body.reason,
      requestId: body.requestId,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
      metadata: {
        reason: body.reason,
        before: accountAuditSnapshot(before),
        after: accountAuditSnapshot(account),
      },
    },
  });
  invalidateVirtualCopyQueryCache(id);
  success(res, moneyStrings({ account, asOf: new Date() }));
}));

internalVirtualCopyAdminRouter.post('/executions/:id/retry', command(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const body = commandSchema.parse(req.body ?? {});
  const action = 'VIRTUAL_COPY_EXECUTION_RETRY';
  const repeatedAudit = await prisma.auditEvent.findFirst({
    where: { requestId: body.requestId, action, targetType: 'VirtualCopyExecution', targetId: id, result: 'SUCCESS' },
  });
  if (repeatedAudit) {
    const execution = await prisma.virtualCopyExecution.findUnique({ where: { id } });
    success(res, moneyStrings({ execution, idempotent: true, asOf: new Date() }));
    return;
  }
  const actor = adminLocals(res);
  const execution = await prisma.$transaction(async (tx) => {
    const before = await tx.virtualCopyExecution.findUnique({ where: { id } });
    if (!before) throw new VirtualCopyDomainError('Virtual execution not found', 404, 'NOT_FOUND');
    if (before.status !== 'FAILED' && before.status !== 'DEAD') {
      throw new VirtualCopyDomainError(
        `Execution retry is only allowed from FAILED or DEAD, got ${before.status}`,
        409,
        'CONFLICT',
      );
    }
    const updated = await tx.virtualCopyExecution.updateMany({
      where: { id, status: { in: ['FAILED', 'DEAD'] } },
      data: {
        status: 'QUEUED',
        scheduledAt: new Date(),
        claimedAt: null,
        claimToken: null,
        claimExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        retryCount: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new VirtualCopyDomainError('Execution state changed concurrently', 409, 'CONFLICT');
    }
    const after = await tx.virtualCopyExecution.findUniqueOrThrow({ where: { id } });
    await tx.auditEvent.create({
      data: {
        actorType: 'ADMIN',
        actorId: actor.adminUserId,
        userId: before.userId,
        action,
        targetType: 'VirtualCopyExecution',
        targetId: id,
        result: 'SUCCESS',
        reasonCode: body.reason,
        requestId: body.requestId,
        ip: req.ip,
        userAgent: req.get('user-agent') ?? null,
        metadata: {
          reason: body.reason,
          before: {
            status: before.status,
            retryCount: before.retryCount,
            errorCode: before.errorCode,
          },
          after: {
            status: after.status,
            retryCount: after.retryCount,
            scheduledAt: after.scheduledAt.toISOString(),
          },
        } satisfies Prisma.InputJsonValue,
      },
    });
    return after;
  });
  invalidateVirtualCopyQueryCache(execution.accountId);
  success(res, moneyStrings({ execution, asOf: new Date() }), 202);
}));
