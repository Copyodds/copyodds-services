import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { prisma } from '../db';
import { virtualCopyMetrics } from '../observability/virtualCopyMetrics';
import { D, ZERO } from './virtualCopyMath';

export const VIRTUAL_COPY_SAFETY_CONTROL_KEY = 'virtual-copy-safety';

export type VirtualCopyReconciliationIssue = {
  type: 'CASH_LEDGER_DRIFT' | 'EQUITY_DRIFT' | 'CROSS_ACCOUNT_REFERENCE' | 'INVALID_LOT_SIZE';
  accountId?: string;
  expected?: string;
  actual?: string;
  count?: number;
};

export async function isVirtualCopyBuySafetyPaused(
  db: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const control = await db.systemControl.findUnique({
    where: { key: VIRTUAL_COPY_SAFETY_CONTROL_KEY },
    select: { mode: true },
  });
  return control?.mode === 'PAUSED';
}

export async function reconcileVirtualCopyAccounts(options: {
  accountLimit?: number;
  pauseOnDrift?: boolean;
} = {}): Promise<{ checkedAccounts: number; issues: VirtualCopyReconciliationIssue[] }> {
  const accounts = await prisma.virtualCopyAccount.findMany({
    where: { status: { not: 'ARCHIVED' } },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(options.accountLimit ?? 500, 5_000)),
    select: { id: true, cashBalanceUsd: true },
  });
  const issues: VirtualCopyReconciliationIssue[] = [];
  for (const account of accounts) {
    const [ledgerGroups, latestSnapshot, invalidLots] = await Promise.all([
      prisma.virtualAccountLedger.groupBy({
        by: ['direction'],
        where: { accountId: account.id },
        _sum: { amountUsd: true },
      }),
      prisma.virtualAccountEquitySnapshot.findFirst({
        where: { accountId: account.id },
        orderBy: { snapshotAt: 'desc' },
        select: { cashBalanceUsd: true, positionValueUsd: true, equityUsd: true },
      }),
      prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "VirtualPositionLot"
        WHERE "accountId" = ${account.id}
          AND ("remainingSize" < 0 OR "remainingSize" > "entrySize")
      `),
    ]);
    let expectedCash = ZERO;
    for (const row of ledgerGroups) {
      const amount = row._sum.amountUsd ?? ZERO;
      expectedCash = row.direction === 'CREDIT'
        ? expectedCash.add(amount)
        : expectedCash.sub(amount);
    }
    if (!expectedCash.eq(account.cashBalanceUsd)) {
      issues.push({
        type: 'CASH_LEDGER_DRIFT',
        accountId: account.id,
        expected: expectedCash.toString(),
        actual: account.cashBalanceUsd.toString(),
      });
    }
    if (latestSnapshot) {
      const expectedEquity = latestSnapshot.cashBalanceUsd.add(latestSnapshot.positionValueUsd);
      if (!expectedEquity.eq(latestSnapshot.equityUsd)) {
        issues.push({
          type: 'EQUITY_DRIFT',
          accountId: account.id,
          expected: expectedEquity.toString(),
          actual: latestSnapshot.equityUsd.toString(),
        });
      }
    }
    const invalidLotCount = Number(invalidLots[0]?.count ?? 0);
    if (invalidLotCount > 0) {
      issues.push({ type: 'INVALID_LOT_SIZE', accountId: account.id, count: invalidLotCount });
    }
  }

  const crossAccountRows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS "count"
    FROM "VirtualPositionLotClose" c
    JOIN "VirtualPositionLot" l ON l."id" = c."lotId"
    JOIN "VirtualCopyExecution" e ON e."id" = c."sellExecutionId"
    WHERE c."accountId" <> l."accountId"
       OR c."accountId" <> e."accountId"
       OR c."subscriptionId" <> l."subscriptionId"
  `);
  const crossAccountCount = Number(crossAccountRows[0]?.count ?? 0);
  if (crossAccountCount > 0) {
    issues.push({ type: 'CROSS_ACCOUNT_REFERENCE', count: crossAccountCount });
  }

  if (issues.length > 0 && options.pauseOnDrift !== false) {
    const now = new Date();
    await prisma.systemControl.upsert({
      where: { key: VIRTUAL_COPY_SAFETY_CONTROL_KEY },
      create: {
        key: VIRTUAL_COPY_SAFETY_CONTROL_KEY,
        mode: 'PAUSED',
        reason: 'VIRTUAL_COPY_RECONCILIATION_DRIFT',
        metadata: { detectedAt: now.toISOString(), issues },
      },
      update: {
        mode: 'PAUSED',
        reason: 'VIRTUAL_COPY_RECONCILIATION_DRIFT',
        metadata: { detectedAt: now.toISOString(), issues },
      },
    });
  }
  const issueTypes = [
    'CASH_LEDGER_DRIFT',
    'EQUITY_DRIFT',
    'CROSS_ACCOUNT_REFERENCE',
    'INVALID_LOT_SIZE',
  ] as const;
  for (const type of issueTypes) {
    const matching = issues.filter((issue) => issue.type === type);
    virtualCopyMetrics.reconciliationDrift.labels(type.toLowerCase()).set(
      matching.reduce((sum, issue) => sum + (issue.count ?? 1), 0),
    );
    if (type === 'CASH_LEDGER_DRIFT' || type === 'EQUITY_DRIFT') {
      const maximum = matching.reduce((max, issue) => {
        if (issue.expected == null || issue.actual == null) return max;
        return Math.max(max, D(issue.expected).sub(D(issue.actual)).abs().toNumber());
      }, 0);
      virtualCopyMetrics.reconciliationDriftUsd.labels(type.toLowerCase()).set(maximum);
    }
  }
  return { checkedAccounts: accounts.length, issues };
}
