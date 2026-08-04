import { Prisma } from '../generated/prisma/client';
import { prisma } from '../db';
import { valueVirtualLots } from './virtualCopyMarkPrice';
import {
  requireOwnedVirtualAccount,
  resolveVirtualMarks,
  VirtualCopyDomainError,
} from './virtualAccountService';

export type VirtualCopyQuery = {
  search?: string;
  status?: string;
  side?: 'BUY' | 'SELL';
  leader?: string;
  hasPosition?: boolean;
  from?: Date;
  to?: Date;
  sort: string;
  order: 'asc' | 'desc';
  cursor?: string;
  limit: number;
  includeLots?: boolean;
};

type CursorPayload = {
  v: 1;
  sort: string;
  order: 'asc' | 'desc';
  values: Array<string | number>;
};

// Query responses are deliberately uncached today. Admin commands still call this boundary so
// adding a cache later cannot omit command-side invalidation.
export function invalidateVirtualCopyQueryCache(accountId: string): void {
  void accountId;
}

function encodeCursor(query: VirtualCopyQuery, values: Array<string | number>): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    sort: query.sort,
    order: query.order,
    values,
  } satisfies CursorPayload)).toString('base64url');
}

function decodeCursor(query: VirtualCopyQuery, expectedValues: number): CursorPayload | null {
  if (!query.cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (
      parsed.v !== 1 ||
      parsed.sort !== query.sort ||
      parsed.order !== query.order ||
      !Array.isArray(parsed.values) ||
      parsed.values.length !== expectedValues
    ) throw new Error('mismatch');
    return parsed;
  } catch {
    throw new VirtualCopyDomainError('Invalid or incompatible cursor', 400, 'VALIDATION');
  }
}

function dateRange(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
  return from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;
}

function text(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function dateCursorWhere(
  query: VirtualCopyQuery,
  field: string,
): Record<string, unknown> | undefined {
  const cursor = decodeCursor(query, 2);
  if (!cursor) return undefined;
  const date = new Date(String(cursor.values[0]));
  if (!Number.isFinite(date.getTime())) {
    throw new VirtualCopyDomainError('Invalid cursor date', 400, 'VALIDATION');
  }
  const id = String(cursor.values[1]);
  const op = query.order === 'asc' ? 'gt' : 'lt';
  return {
    OR: [
      { [field]: { [op]: date } },
      { [field]: date, id: { [op]: id } },
    ],
  };
}

function dateOrder(query: VirtualCopyQuery, field: string): Array<Record<string, 'asc' | 'desc'>> {
  return [{ [field]: query.order }, { id: query.order }];
}

function pageResult<T>(
  rows: T[],
  query: VirtualCopyQuery,
  cursorFor: (row: T) => Array<string | number>,
) {
  const hasMore = rows.length > query.limit;
  const items = rows.slice(0, query.limit);
  return {
    items,
    nextCursor: hasMore && items.length > 0
      ? encodeCursor(query, cursorFor(items[items.length - 1]))
      : null,
    asOf: new Date(),
  };
}

const ACCOUNT_SORTS = new Set(['createdAt', 'updatedAt', 'startedAt', 'expiresAt']);

export async function listVirtualAccounts(userId: number, query: VirtualCopyQuery) {
  const sort = ACCOUNT_SORTS.has(query.sort) ? query.sort : 'createdAt';
  const effective = { ...query, sort };
  const keyword = text(query.search);
  const where: Prisma.VirtualCopyAccountWhereInput = {
    userId,
    ...(query.status ? { status: query.status as Prisma.EnumVirtualAccountStatusFilter['equals'] } : {}),
    ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}),
    AND: [
      ...(keyword ? [{
        OR: [
          { name: { contains: keyword, mode: 'insensitive' as const } },
          { id: { contains: keyword, mode: 'insensitive' as const } },
        ],
      }] : []),
      ...(dateCursorWhere(effective, sort) ? [dateCursorWhere(effective, sort)!] : []),
    ],
    ...(query.leader ? {
      subscriptions: {
        some: {
          deletedAt: null,
          leader: { address: { contains: query.leader, mode: 'insensitive' } },
        },
      },
    } : {}),
    ...(query.hasPosition === undefined ? {} : {
      lots: query.hasPosition
        ? { some: { remainingSize: { gt: 0 } } }
        : { none: { remainingSize: { gt: 0 } } },
    }),
  };
  const rows = await prisma.virtualCopyAccount.findMany({
    where,
    orderBy: dateOrder(effective, sort) as Prisma.VirtualCopyAccountOrderByWithRelationInput[],
    take: query.limit + 1,
    include: {
      _count: {
        select: {
          lots: { where: { remainingSize: { gt: 0 } } },
          subscriptions: { where: { enabled: true, deletedAt: null } },
        },
      },
      equitySnapshots: { orderBy: { snapshotAt: 'desc' }, take: 1 },
    },
  });
  const page = pageResult(rows, effective, (row) => [
    (row[sort as keyof typeof row] as Date).toISOString(),
    row.id,
  ]);
  return {
    ...page,
    items: page.items.map(({ _count, equitySnapshots, ...account }) => ({
      ...account,
      activeSubscriptionCount: _count.subscriptions,
      openLots: _count.lots,
      ...(equitySnapshots[0] ? {
        positionValueUsd: equitySnapshots[0].positionValueUsd,
        equityUsd: equitySnapshots[0].equityUsd,
        unrealizedPnlUsd: equitySnapshots[0].unrealizedPnlUsd,
        totalPnlUsd: equitySnapshots[0].totalPnlUsd,
        totalReturn: equitySnapshots[0].totalReturn,
        priceAsOf: equitySnapshots[0].priceAsOf,
        priceStatus: equitySnapshots[0].priceStatus,
        priceSource: equitySnapshots[0].priceSource,
      } : {
        positionValueUsd: new Prisma.Decimal(0),
        equityUsd: account.cashBalanceUsd.add(account.reservedBalanceUsd),
        unrealizedPnlUsd: new Prisma.Decimal(0),
        totalPnlUsd: account.realizedPnlUsd,
        totalReturn: account.initialBalanceUsd.gt(0)
          ? account.realizedPnlUsd.div(account.initialBalanceUsd)
          : new Prisma.Decimal(0),
        priceAsOf: account.updatedAt,
        priceStatus: 'NO_OPEN_POSITIONS',
        priceSource: 'UNAVAILABLE',
      }),
    })),
  };
}

const SUBSCRIPTION_SORTS = new Set(['createdAt', 'updatedAt', 'startedAt']);

export async function listVirtualSubscriptions(
  userId: number,
  accountId: string,
  query: VirtualCopyQuery,
) {
  await requireOwnedVirtualAccount(userId, accountId);
  const sort = SUBSCRIPTION_SORTS.has(query.sort) ? query.sort : 'createdAt';
  const effective = { ...query, sort };
  const keyword = text(query.search);
  const rows = await prisma.virtualCopySubscription.findMany({
    where: {
      accountId,
      userId,
      deletedAt: null,
      ...(query.status ? { status: query.status as Prisma.EnumSubscriptionStatusFilter['equals'] } : {}),
      ...(query.leader ? {
        leader: { address: { contains: query.leader, mode: 'insensitive' } },
      } : {}),
      AND: [
        ...(keyword ? [{
          OR: [
            { ruleName: { contains: keyword, mode: 'insensitive' as const } },
            { note: { contains: keyword, mode: 'insensitive' as const } },
            { leader: { address: { contains: keyword, mode: 'insensitive' as const } } },
            { leader: { label: { contains: keyword, mode: 'insensitive' as const } } },
          ],
        }] : []),
        ...(dateCursorWhere(effective, sort) ? [dateCursorWhere(effective, sort)!] : []),
      ],
      ...(query.hasPosition === undefined ? {} : {
        lots: query.hasPosition
          ? { some: { remainingSize: { gt: 0 } } }
          : { none: { remainingSize: { gt: 0 } } },
      }),
      ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}),
    },
    include: {
      leader: { select: { address: true, label: true, status: true, riskLevel: true } },
      lots: {
        where: { remainingSize: { gt: 0 } },
        select: {
          id: true,
          tokenId: true,
          remainingSize: true,
          entryPrice: true,
          entryFeeUsd: true,
        },
      },
    },
    orderBy: dateOrder(effective, sort) as Prisma.VirtualCopySubscriptionOrderByWithRelationInput[],
    take: query.limit + 1,
  });
  const pageRows = rows.slice(0, query.limit);
  const ids = pageRows.map((row) => row.id);
  const [closeAggregates, executionCounts, latestExecutions, marks] = await Promise.all([
    ids.length ? prisma.virtualPositionLotClose.groupBy({
      by: ['subscriptionId'],
      where: { accountId, userId, subscriptionId: { in: ids } },
      _sum: { realizedPnlUsd: true, costBasisUsd: true },
    }) : [],
    ids.length ? prisma.virtualCopyExecution.groupBy({
      by: ['subscriptionId', 'status'],
      where: {
        accountId,
        userId,
        subscriptionId: { in: ids },
        ...(query.side ? { side: query.side } : {}),
        ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}),
      },
      _count: { _all: true },
    }) : [],
    ids.length ? prisma.virtualCopyExecution.findMany({
      where: { accountId, userId, subscriptionId: { in: ids } },
      orderBy: [{ subscriptionId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['subscriptionId'],
      select: {
        subscriptionId: true,
        errorMessage: true,
        createdAt: true,
        filledAt: true,
        leaderTrade: { select: { createdAt: true } },
      },
    }) : [],
    resolveVirtualMarks(pageRows.flatMap((row) => row.lots.map((lot) => lot.tokenId))),
  ]);
  const closes = new Map(closeAggregates.map((row) => [row.subscriptionId, row._sum]));
  const latest = new Map(latestExecutions.map((row) => [row.subscriptionId, row]));
  const counts = new Map<string, Record<string, number>>();
  for (const row of executionCounts) {
    const value = counts.get(row.subscriptionId) ?? {
      successCount: 0, partialCount: 0, skippedCount: 0, failedCount: 0,
    };
    if (row.status === 'FILLED') value.successCount += row._count._all;
    else if (row.status === 'PARTIALLY_FILLED') value.partialCount += row._count._all;
    else if (row.status === 'SKIPPED') value.skippedCount += row._count._all;
    else if (row.status === 'FAILED' || row.status === 'DEAD') value.failedCount += row._count._all;
    counts.set(row.subscriptionId, value);
  }
  const page = pageResult(rows, effective, (row) => [
    (row[sort as keyof typeof row] as Date).toISOString(),
    row.id,
  ]);
  return {
    ...page,
    items: page.items.map(({ leader, lots, ...subscription }) => {
      const valuation = valueVirtualLots(lots, marks);
      const close = closes.get(subscription.id);
      const realizedPnlUsd = close?.realizedPnlUsd ?? new Prisma.Decimal(0);
      const closedCostUsd = close?.costBasisUsd ?? new Prisma.Decimal(0);
      const capitalBasisUsd = valuation.costBasisUsd.add(closedCostUsd);
      const current = latest.get(subscription.id);
      return {
        ...subscription,
        leaderProfile: leader,
        leaderAddress: leader.address,
        leaderName: leader.label,
        positionSummary: {
          openLotCount: lots.length,
          costBasisUsd: valuation.costBasisUsd,
          positionValueUsd: valuation.positionValueUsd,
          unrealizedPnlUsd: valuation.unrealizedPnlUsd,
        },
        pnlSummary: {
          realizedPnlUsd,
          unrealizedPnlUsd: valuation.unrealizedPnlUsd,
          totalPnlUsd: realizedPnlUsd.add(valuation.unrealizedPnlUsd),
          returnRate: capitalBasisUsd.gt(0)
            ? realizedPnlUsd.add(valuation.unrealizedPnlUsd).div(capitalBasisUsd)
            : new Prisma.Decimal(0),
        },
        executionSummary: counts.get(subscription.id) ?? {
          successCount: 0, partialCount: 0, skippedCount: 0, failedCount: 0,
        },
        lastSignalAt: current?.leaderTrade?.createdAt ?? null,
        lastExecutionAt: current?.filledAt ?? current?.createdAt ?? null,
        lastError: current?.errorMessage ?? null,
        priceAsOf: valuation.priceAsOf,
        priceStatus: valuation.priceStatus,
        priceSource: valuation.priceSource,
        asOf: page.asOf,
      };
    }),
  };
}

export async function listVirtualPositions(
  userId: number,
  accountId: string,
  query: VirtualCopyQuery,
  subscriptionId?: string,
) {
  await requireOwnedVirtualAccount(userId, accountId);
  const sort = ['tokenId', 'subscriptionId', 'leaderAddress'].includes(query.sort)
    ? query.sort
    : 'tokenId';
  const effective = { ...query, sort };
  const cursor = decodeCursor(effective, 3);
  const op = query.order === 'asc' ? 'gt' : 'lt';
  const cursorFields = sort === 'tokenId'
    ? ['tokenId', 'subscriptionId', 'leaderAddress'] as const
    : sort === 'subscriptionId'
      ? ['subscriptionId', 'tokenId', 'leaderAddress'] as const
      : ['leaderAddress', 'subscriptionId', 'tokenId'] as const;
  const keyword = text(query.search);
  const cursorWhere = cursor ? {
    OR: [
      { [cursorFields[0]]: { [op]: String(cursor.values[0]) } },
      {
        [cursorFields[0]]: String(cursor.values[0]),
        [cursorFields[1]]: { [op]: String(cursor.values[1]) },
      },
      {
        [cursorFields[0]]: String(cursor.values[0]),
        [cursorFields[1]]: String(cursor.values[1]),
        [cursorFields[2]]: { [op]: String(cursor.values[2]) },
      },
    ],
  } : {};
  const where: Prisma.VirtualPositionLotWhereInput = {
    accountId,
    userId,
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(query.hasPosition === false ? {} : { remainingSize: { gt: 0 } }),
    ...(query.status ? { status: query.status } : {}),
    ...(query.leader ? { leaderAddress: { contains: query.leader, mode: 'insensitive' } } : {}),
    ...(dateRange(query.from, query.to) ? { openedAt: dateRange(query.from, query.to) } : {}),
    AND: [
      ...(keyword ? [{
        OR: [
          { tokenId: { contains: keyword, mode: 'insensitive' as const } },
          { marketId: { contains: keyword, mode: 'insensitive' as const } },
          { leaderAddress: { contains: keyword, mode: 'insensitive' as const } },
          { buyExecution: { marketTitle: { contains: keyword, mode: 'insensitive' as const } } },
        ],
      }] : []),
      ...(cursor ? [cursorWhere] : []),
    ],
  };
  const groupArgs = {
    where,
    _sum: { remainingSize: true } as const,
    take: query.limit + 1,
  };
  const groups = sort === 'subscriptionId'
    ? await prisma.virtualPositionLot.groupBy({
        ...groupArgs,
        by: ['tokenId', 'subscriptionId', 'leaderAddress'],
        orderBy: [
          { subscriptionId: query.order },
          { tokenId: query.order },
          { leaderAddress: query.order },
        ],
      })
    : sort === 'leaderAddress'
      ? await prisma.virtualPositionLot.groupBy({
          ...groupArgs,
          by: ['tokenId', 'subscriptionId', 'leaderAddress'],
          orderBy: [
            { leaderAddress: query.order },
            { subscriptionId: query.order },
            { tokenId: query.order },
          ],
        })
      : await prisma.virtualPositionLot.groupBy({
          ...groupArgs,
          by: ['tokenId', 'subscriptionId', 'leaderAddress'],
          orderBy: [
            { tokenId: query.order },
            { subscriptionId: query.order },
            { leaderAddress: query.order },
          ],
        });
  const pageGroups = groups.slice(0, query.limit);
  const lots = pageGroups.length ? await prisma.virtualPositionLot.findMany({
    where: {
      accountId,
      userId,
      OR: pageGroups.map((group) => ({
        tokenId: group.tokenId,
        subscriptionId: group.subscriptionId,
        leaderAddress: group.leaderAddress,
      })),
      ...(query.hasPosition === false ? {} : { remainingSize: { gt: 0 } }),
    },
    include: {
      buyExecution: {
        select: {
          marketTitle: true,
          outcome: true,
          priceObservedAt: true,
          priceSource: true,
        },
      },
    },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
  }) : [];
  const marks = await resolveVirtualMarks(pageGroups.map((group) => group.tokenId));
  const items = pageGroups.map((group) => {
    const matching = lots.filter((lot) =>
      lot.tokenId === group.tokenId &&
      lot.subscriptionId === group.subscriptionId &&
      lot.leaderAddress === group.leaderAddress);
    const valuation = valueVirtualLots(matching, marks);
    const mark = marks.get(group.tokenId);
    const size = group._sum?.remainingSize ?? new Prisma.Decimal(0);
    const averageCost = size.gt(0) ? valuation.costBasisUsd.div(size) : new Prisma.Decimal(0);
    const first = matching[0];
    return {
      id: `${group.subscriptionId}:${group.tokenId}`,
      tokenId: group.tokenId,
      subscriptionId: group.subscriptionId,
      leaderAddress: group.leaderAddress,
      marketId: first?.marketId ?? null,
      marketTitle: first?.buyExecution.marketTitle ?? first?.marketId ?? group.tokenId,
      outcome: first?.buyExecution.outcome ?? '',
      size,
      averageCost,
      costBasisUsd: valuation.costBasisUsd,
      markPrice: mark?.price ?? averageCost,
      marketValueUsd: valuation.positionValueUsd,
      unrealizedPnlUsd: valuation.unrealizedPnlUsd,
      priceAsOf: mark?.asOf ?? first?.updatedAt ?? null,
      priceSource: mark?.source ?? 'UNAVAILABLE',
      priceStatus: mark?.status ?? 'UNAVAILABLE',
      openedAt: first?.openedAt ?? null,
      updatedAt: matching.at(-1)?.updatedAt ?? null,
      ...(query.includeLots ? {
        lots: matching.map(({ buyExecution: _execution, ...lot }) => lot),
      } : {}),
    };
  });
  return {
    items,
    nextCursor: groups.length > query.limit && items.length
      ? encodeCursor(effective, [
          String(items.at(-1)?.[cursorFields[0]] ?? ''),
          String(items.at(-1)?.[cursorFields[1]] ?? ''),
          String(items.at(-1)?.[cursorFields[2]] ?? ''),
        ])
      : null,
    asOf: new Date(),
  };
}

export async function listVirtualExecutions(userId: number, accountId: string, query: VirtualCopyQuery) {
  await requireOwnedVirtualAccount(userId, accountId);
  const sort = ['createdAt', 'updatedAt', 'scheduledAt', 'filledAt'].includes(query.sort)
    ? query.sort
    : 'createdAt';
  // filledAt is nullable and therefore cannot provide a total order without a null sentinel.
  const cursorSort = sort === 'filledAt' ? 'createdAt' : sort;
  const effective = { ...query, sort: cursorSort };
  const keyword = text(query.search);
  const rows = await prisma.virtualCopyExecution.findMany({
    where: {
      accountId,
      userId,
      ...(query.status ? { status: query.status as Prisma.EnumVirtualExecutionStatusFilter['equals'] } : {}),
      ...(query.side ? { side: query.side } : {}),
      ...(query.leader ? { leaderAddress: { contains: query.leader, mode: 'insensitive' } } : {}),
      ...(dateRange(query.from, query.to) ? { createdAt: dateRange(query.from, query.to) } : {}),
      AND: [
        ...(keyword ? [{
          OR: [
            { marketTitle: { contains: keyword, mode: 'insensitive' as const } },
            { marketId: { contains: keyword, mode: 'insensitive' as const } },
            { tokenId: { contains: keyword, mode: 'insensitive' as const } },
            { leaderAddress: { contains: keyword, mode: 'insensitive' as const } },
            { errorMessage: { contains: keyword, mode: 'insensitive' as const } },
          ],
        }] : []),
        ...(dateCursorWhere(effective, cursorSort) ? [dateCursorWhere(effective, cursorSort)!] : []),
      ],
    },
    orderBy: dateOrder(effective, cursorSort) as Prisma.VirtualCopyExecutionOrderByWithRelationInput[],
    take: query.limit + 1,
  });
  return pageResult(rows, effective, (row) => [
    row[cursorSort as 'createdAt' | 'updatedAt' | 'scheduledAt'].toISOString(),
    row.id,
  ]);
}

export async function listVirtualLedger(userId: number, accountId: string, query: VirtualCopyQuery) {
  await requireOwnedVirtualAccount(userId, accountId);
  const sort = query.sort === 'createdAt' ? 'createdAt' : 'occurredAt';
  const effective = { ...query, sort };
  const keyword = text(query.search);
  const rows = await prisma.virtualAccountLedger.findMany({
    where: {
      accountId,
      userId,
      ...(query.status ? { category: query.status } : {}),
      ...(query.side ? { direction: query.side === 'BUY' ? 'DEBIT' : 'CREDIT' } : {}),
      ...(dateRange(query.from, query.to) ? { occurredAt: dateRange(query.from, query.to) } : {}),
      AND: [
        ...(keyword ? [{
          OR: [
            { category: { contains: keyword, mode: 'insensitive' as const } },
            { refType: { contains: keyword, mode: 'insensitive' as const } },
            { refId: { contains: keyword, mode: 'insensitive' as const } },
          ],
        }] : []),
        ...(dateCursorWhere(effective, sort) ? [dateCursorWhere(effective, sort)!] : []),
      ],
    },
    orderBy: dateOrder(effective, sort) as Prisma.VirtualAccountLedgerOrderByWithRelationInput[],
    take: query.limit + 1,
  });
  return pageResult(rows, effective, (row) => [
    row[sort as 'createdAt' | 'occurredAt'].toISOString(),
    row.id,
  ]);
}

export async function listVirtualEquity(userId: number, accountId: string, query: VirtualCopyQuery) {
  await requireOwnedVirtualAccount(userId, accountId);
  const effective = { ...query, sort: 'snapshotAt' };
  const cursor = decodeCursor(effective, 2);
  const op = query.order === 'asc' ? 'gt' : 'lt';
  const rows = await prisma.virtualAccountEquitySnapshot.findMany({
    where: {
      accountId,
      ...(query.status ? { priceStatus: query.status } : {}),
      ...(dateRange(query.from, query.to) ? { snapshotAt: dateRange(query.from, query.to) } : {}),
      ...(cursor ? {
        OR: [
          { snapshotAt: { [op]: new Date(String(cursor.values[0])) } },
          {
            snapshotAt: new Date(String(cursor.values[0])),
            id: { [op]: BigInt(String(cursor.values[1])) },
          },
        ],
      } : {}),
    },
    orderBy: [{ snapshotAt: query.order }, { id: query.order }],
    take: query.limit + 1,
  });
  return pageResult(rows, effective, (row) => [row.snapshotAt.toISOString(), row.id.toString()]);
}

export async function getVirtualPerformance(userId: number, accountId: string, query: VirtualCopyQuery) {
  await requireOwnedVirtualAccount(userId, accountId);
  const range = dateRange(query.from, query.to);
  const [latest, first, executionCounts, closeAggregate] = await Promise.all([
    prisma.virtualAccountEquitySnapshot.findFirst({
      where: { accountId, ...(range ? { snapshotAt: range } : {}) },
      orderBy: [{ snapshotAt: 'desc' }, { id: 'desc' }],
    }),
    prisma.virtualAccountEquitySnapshot.findFirst({
      where: { accountId, ...(range ? { snapshotAt: range } : {}) },
      orderBy: [{ snapshotAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.virtualCopyExecution.groupBy({
      by: ['status'],
      where: {
        accountId,
        userId,
        ...(query.status ? { status: query.status as Prisma.EnumVirtualExecutionStatusFilter['equals'] } : {}),
        ...(query.side ? { side: query.side } : {}),
        ...(query.leader ? { leaderAddress: { contains: query.leader, mode: 'insensitive' } } : {}),
        ...(range ? { createdAt: range } : {}),
      },
      _count: { _all: true },
    }),
    prisma.virtualPositionLotClose.aggregate({
      where: { accountId, userId, ...(range ? { createdAt: range } : {}) },
      _sum: { realizedPnlUsd: true, proceedsUsd: true, costBasisUsd: true },
      _count: { _all: true },
    }),
  ]);
  return {
    periodStart: first?.snapshotAt ?? query.from ?? null,
    periodEnd: latest?.snapshotAt ?? query.to ?? null,
    startingEquityUsd: first?.equityUsd ?? null,
    endingEquityUsd: latest?.equityUsd ?? null,
    totalPnlUsd: latest && first ? latest.equityUsd.sub(first.equityUsd) : new Prisma.Decimal(0),
    totalReturn: latest && first && first.equityUsd.gt(0)
      ? latest.equityUsd.sub(first.equityUsd).div(first.equityUsd)
      : new Prisma.Decimal(0),
    maxDrawdownPercent: latest?.drawdownPercent ?? new Prisma.Decimal(0),
    realizedPnlUsd: closeAggregate._sum.realizedPnlUsd ?? new Prisma.Decimal(0),
    closedCostBasisUsd: closeAggregate._sum.costBasisUsd ?? new Prisma.Decimal(0),
    proceedsUsd: closeAggregate._sum.proceedsUsd ?? new Prisma.Decimal(0),
    closedTradeCount: closeAggregate._count._all,
    executionCounts: Object.fromEntries(
      executionCounts.map((row) => [row.status, row._count._all]),
    ),
    priceAsOf: latest?.priceAsOf ?? null,
    priceStatus: latest?.priceStatus ?? 'UNAVAILABLE',
    priceSource: latest?.priceSource ?? 'UNAVAILABLE',
    asOf: new Date(),
  };
}
