import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { CONFIG } from '../config/env';
import { prisma } from '../db';
import { virtualCopyMetrics } from '../observability/virtualCopyMetrics';
import { D, ZERO } from './virtualCopyMath';
import { getVirtualMarkPriceResolver } from './virtualCopyMarketData';
import {
  valueVirtualLots,
  type VirtualLotForValuation,
  type VirtualMarkPrice,
} from './virtualCopyMarkPrice';

type Db = PrismaClient | Prisma.TransactionClient;

export class VirtualCopyDomainError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION',
  ) {
    super(message);
  }
}

export async function requireOwnedVirtualAccount(userId: number, accountId: string, db: Db = prisma) {
  const account = await db.virtualCopyAccount.findFirst({ where: { id: accountId, userId } });
  if (!account) throw new VirtualCopyDomainError('Virtual account not found', 404, 'NOT_FOUND');
  return account;
}

export async function createVirtualAccount(params: {
  userId: number;
  name: string;
  initialBalanceUsd: string;
  effectiveDays: number;
  idempotencyKey: string;
}) {
  const amount = D(params.initialBalanceUsd);
  const name = params.name.trim();
  const ledgerKey = `virtual-account-open:${params.userId}:${params.idempotencyKey.trim()}`;
  const existingLedger = await prisma.virtualAccountLedger.findUnique({ where: { idempotencyKey: ledgerKey } });
  if (existingLedger) return requireOwnedVirtualAccount(params.userId, existingLedger.accountId);

  try {
    return await prisma.$transaction(async (tx) => {
      const lockStartedAt = performance.now();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${params.userId}, 94621)`;
      virtualCopyMetrics.lockWaitSeconds
        .labels('account_create_advisory')
        .observe((performance.now() - lockStartedAt) / 1_000);
      const racedLedger = await tx.virtualAccountLedger.findUnique({
        where: { idempotencyKey: ledgerKey },
      });
      if (racedLedger) return requireOwnedVirtualAccount(params.userId, racedLedger.accountId, tx);
      const activeAccountCount = await tx.virtualCopyAccount.count({
        where: { userId: params.userId, status: { not: 'ARCHIVED' } },
      });
      if (activeAccountCount >= CONFIG.virtualCopyActiveAccountQuota) {
        throw new VirtualCopyDomainError(
          `Active virtual account quota exceeded (${CONFIG.virtualCopyActiveAccountQuota})`,
          409,
          'CONFLICT',
        );
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + params.effectiveDays * 86_400_000);
      const account = await tx.virtualCopyAccount.create({
        data: {
          userId: params.userId,
          name,
          initialBalanceUsd: amount,
          cashBalanceUsd: amount,
          startedAt: now,
          expiresAt,
        },
      });
      await tx.virtualAccountLedger.create({
        data: {
          userId: params.userId,
          accountId: account.id,
          direction: 'CREDIT',
          category: 'INITIAL_FUNDING',
          amountUsd: amount,
          balanceAfterUsd: amount,
          refType: 'VirtualCopyAccount',
          refId: account.id,
          idempotencyKey: ledgerKey,
        },
      });
      await tx.virtualAccountEquitySnapshot.create({
        data: {
          accountId: account.id,
          cashBalanceUsd: amount,
          positionValueUsd: ZERO,
          equityUsd: amount,
          realizedPnlUsd: ZERO,
          unrealizedPnlUsd: ZERO,
          totalPnlUsd: ZERO,
          totalReturn: ZERO,
          drawdownUsd: ZERO,
          drawdownPercent: ZERO,
          priceAsOf: now,
          priceStatus: 'NO_OPEN_POSITIONS',
          priceSource: 'UNAVAILABLE',
          unavailableMarkCount: 0,
          snapshotAt: now,
        },
      });
      return account;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const racedLedger = await prisma.virtualAccountLedger.findUnique({
        where: { idempotencyKey: ledgerKey },
      });
      if (racedLedger) {
        return requireOwnedVirtualAccount(params.userId, racedLedger.accountId);
      }
    }
    throw error;
  }
}

export async function resolveVirtualMarks(tokenIds: string[]) {
  const resolver = getVirtualMarkPriceResolver();
  const uniqueTokenIds = [...new Set(tokenIds)];
  const resolved = await Promise.all(uniqueTokenIds.map(async (tokenId): Promise<VirtualMarkPrice> => {
    try {
      return await resolver.resolve(tokenId);
    } catch (error) {
      return {
        tokenId,
        price: null,
        source: 'UNAVAILABLE',
        asOf: null,
        stalenessMs: null,
        status: 'UNAVAILABLE',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  return new Map(resolved.map((mark) => [mark.tokenId, mark]));
}

export async function valueLotsWithLiveMarks(lots: VirtualLotForValuation[]) {
  return valueVirtualLots(lots, await resolveVirtualMarks(lots.map((lot) => lot.tokenId)));
}

export async function upsertVirtualSubscriptionWithQuota(params: {
  userId: number;
  accountId: string;
  leaderId: string;
  enabled: boolean;
  createData: Prisma.VirtualCopySubscriptionUncheckedCreateInput;
  updateData: Prisma.VirtualCopySubscriptionUncheckedUpdateInput;
}) {
  return prisma.$transaction(async (tx) => {
    const lockStartedAt = performance.now();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${params.userId}, 94622)`;
    virtualCopyMetrics.lockWaitSeconds
      .labels('subscription_advisory')
      .observe((performance.now() - lockStartedAt) / 1_000);
    const existing = await tx.virtualCopySubscription.findUnique({
      where: { accountId_leaderId: { accountId: params.accountId, leaderId: params.leaderId } },
    });
    const activates = params.enabled && (!existing || existing.deletedAt || !existing.enabled);
    if (activates) {
      const [activeCount, leaderFanout] = await Promise.all([
        tx.virtualCopySubscription.count({
          where: {
            userId: params.userId,
            enabled: true,
            deletedAt: null,
            status: 'ACTIVE',
          },
        }),
        tx.virtualCopySubscription.count({
          where: {
            leaderId: params.leaderId,
            enabled: true,
            deletedAt: null,
            status: 'ACTIVE',
          },
        }),
      ]);
      virtualCopyMetrics.fanout.observe(leaderFanout);
      if (activeCount >= CONFIG.virtualCopyActiveSubscriptionQuota) {
        throw new VirtualCopyDomainError(
          `Active virtual subscription quota exceeded (${CONFIG.virtualCopyActiveSubscriptionQuota})`,
          409,
          'CONFLICT',
        );
      }
      if (leaderFanout >= CONFIG.virtualCopyFanoutLimit) {
        throw new VirtualCopyDomainError(
          `Virtual copy leader fan-out limit exceeded (${CONFIG.virtualCopyFanoutLimit})`,
          409,
          'CONFLICT',
        );
      }
    }
    return tx.virtualCopySubscription.upsert({
      where: { accountId_leaderId: { accountId: params.accountId, leaderId: params.leaderId } },
      create: params.createData,
      update: params.updateData,
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function archiveOwnedVirtualAccount(userId: number, accountId: string) {
  return prisma.$transaction(async (tx) => {
    const lockStartedAt = performance.now();
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status::text
      FROM "VirtualCopyAccount"
      WHERE id = ${accountId} AND "userId" = ${userId}
      FOR UPDATE
    `;
    virtualCopyMetrics.lockWaitSeconds
      .labels('account_archive')
      .observe((performance.now() - lockStartedAt) / 1_000);
    const account = locked[0];
    if (!account) throw new VirtualCopyDomainError('Virtual account not found', 404, 'NOT_FOUND');
    if (account.status === 'ARCHIVED') {
      return tx.virtualCopyAccount.findUniqueOrThrow({ where: { id: accountId } });
    }
    const openLots = await tx.virtualPositionLot.count({
      where: { accountId, userId, remainingSize: { gt: 0 } },
    });
    if (openLots > 0) {
      throw new VirtualCopyDomainError(
        'Open positions must be closed before archive',
        409,
        'CONFLICT',
      );
    }
    const now = new Date();
    await tx.virtualCopySubscription.updateMany({
      where: { accountId, userId, deletedAt: null },
      data: { enabled: false, status: 'CANCELLED', deletedAt: now },
    });
    return tx.virtualCopyAccount.update({
      where: { id: accountId },
      data: { status: 'ARCHIVED', archivedAt: now, version: { increment: 1 } },
    });
  });
}

/** Persists a mark-to-market account snapshot using CLOB then explicit Gamma degradation. */
export async function snapshotAccount(accountId: string, now = new Date()) {
  const [account, lots] = await Promise.all([
    prisma.virtualCopyAccount.findUniqueOrThrow({ where: { id: accountId } }),
    prisma.virtualPositionLot.findMany({
      where: { accountId, remainingSize: { gt: 0 } },
      select: { tokenId: true, remainingSize: true, entryPrice: true, entryFeeUsd: true },
    }),
  ]);
  const valuation = await valueLotsWithLiveMarks(lots);
  const equity = account.cashBalanceUsd.add(account.reservedBalanceUsd).add(valuation.positionValueUsd);
  const totalPnl = equity.sub(account.initialBalanceUsd);
  const totalReturn = account.initialBalanceUsd.gt(0) ? totalPnl.div(account.initialBalanceUsd) : ZERO;
  const peak = await prisma.virtualAccountEquitySnapshot.aggregate({
    where: { accountId },
    _max: { equityUsd: true },
  });
  const peakEquity = Prisma.Decimal.max(peak._max.equityUsd ?? equity, equity);
  const drawdown = peakEquity.sub(equity);
  return prisma.virtualAccountEquitySnapshot.create({
    data: {
      accountId,
      cashBalanceUsd: account.cashBalanceUsd,
      positionValueUsd: valuation.positionValueUsd,
      equityUsd: equity,
      realizedPnlUsd: account.realizedPnlUsd,
      unrealizedPnlUsd: valuation.unrealizedPnlUsd,
      totalPnlUsd: totalPnl,
      totalReturn,
      drawdownUsd: drawdown,
      drawdownPercent: peakEquity.gt(0) ? drawdown.div(peakEquity) : ZERO,
      priceAsOf: valuation.priceAsOf ?? now,
      priceStatus: valuation.priceStatus,
      priceSource: valuation.priceSource,
      unavailableMarkCount: valuation.unavailableMarkCount,
      snapshotAt: now,
    },
  });
}

export async function getVirtualAccountSummary(userId: number, accountId: string, db: Db = prisma) {
  const account = await requireOwnedVirtualAccount(userId, accountId, db);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const [lots, activeSubscriptions, latestSnapshot, maxDrawdown, todayExecutionCount] = await Promise.all([
    db.virtualPositionLot.findMany({
      where: { accountId, userId, remainingSize: { gt: 0 } },
      select: { tokenId: true, remainingSize: true, entryPrice: true, entryFeeUsd: true },
    }),
    db.virtualCopySubscription.count({
      where: { accountId, userId, enabled: true, deletedAt: null },
    }),
    db.virtualAccountEquitySnapshot.findFirst({
      where: { accountId },
      orderBy: { snapshotAt: 'desc' },
    }),
    db.virtualAccountEquitySnapshot.aggregate({
      where: { accountId },
      _max: { drawdownPercent: true },
      _min: { drawdownPercent: true },
    }),
    db.virtualCopyExecution.count({
      where: { accountId, userId, createdAt: { gte: dayStart } },
    }),
  ]);
  const valuation = await valueLotsWithLiveMarks(lots);
  const equity = account.cashBalanceUsd.add(account.reservedBalanceUsd).add(valuation.positionValueUsd);
  const totalPnl = equity.sub(account.initialBalanceUsd);
  const totalReturn = account.initialBalanceUsd.gt(0) ? totalPnl.div(account.initialBalanceUsd) : ZERO;
  const remainingDays = account.expiresAt.getTime() > Date.now()
    ? Math.max(0, Math.ceil((account.expiresAt.getTime() - Date.now()) / 86_400_000))
    : 0;
  return {
    ...account,
    cashBalanceUsd: account.cashBalanceUsd,
    positionValueUsd: valuation.positionValueUsd,
    equityUsd: equity,
    realizedPnlUsd: account.realizedPnlUsd,
    unrealizedPnlUsd: valuation.unrealizedPnlUsd,
    totalPnlUsd: totalPnl,
    totalReturn,
    maxDrawdownPercent: Prisma.Decimal.max(
      maxDrawdown._max.drawdownPercent ?? ZERO,
      (maxDrawdown._min.drawdownPercent ?? ZERO).abs(),
    ),
    activeSubscriptionCount: activeSubscriptions,
    todayExecutionCount,
    remainingDays,
    openLots: lots.length,
    priceAsOf: valuation.priceAsOf ?? latestSnapshot?.priceAsOf ?? account.updatedAt,
    priceStatus: valuation.priceStatus,
    priceSource: valuation.priceSource,
    unavailableMarkCount: valuation.unavailableMarkCount,
  };
}

export function moneyStrings<T>(value: T): T {
  if (value instanceof Prisma.Decimal) return value.toString() as T;
  if (typeof value === 'bigint') return value.toString() as T;
  if (Array.isArray(value)) return value.map(moneyStrings) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, moneyStrings(item)]),
    ) as T;
  }
  return value;
}
