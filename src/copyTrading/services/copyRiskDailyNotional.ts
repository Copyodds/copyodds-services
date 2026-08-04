import { CopyTradeStatus } from '../../generated/prisma/client';
import { prisma } from '../../db';

const COUNTED_STATUSES: CopyTradeStatus[] = [CopyTradeStatus.filled, CopyTradeStatus.submitted];

export function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseNotionalFromStrings(
  intendedNotional: string | null,
  intendedPrice: string | null,
  intendedSize: string | null
): number {
  if (intendedNotional?.trim()) {
    const n = parseFloat(intendedNotional);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const p = intendedPrice?.trim() ? parseFloat(intendedPrice) : NaN;
  const s = intendedSize?.trim() ? parseFloat(intendedSize) : NaN;
  if (Number.isFinite(p) && Number.isFinite(s) && p > 0 && s > 0) {
    return p * s;
  }
  return 0;
}

type NotionalRow = {
  intendedNotional: string | null;
  intendedPrice: string | null;
  intendedSize: string | null;
};

function sumNotionalRows(rows: NotionalRow[]): number {
  let total = 0;
  for (const row of rows) {
    total += parseNotionalFromStrings(
      row.intendedNotional,
      row.intendedPrice,
      row.intendedSize
    );
  }
  return total;
}

export async function sumUserDailyNotionalUsd(userId: number, dayStart: Date): Promise<number> {
  const rows = await prisma.copyTradeRow.findMany({
    where: {
      userId,
      status: { in: COUNTED_STATUSES },
      createdAt: { gte: dayStart },
    },
    select: {
      intendedNotional: true,
      intendedPrice: true,
      intendedSize: true,
    },
  });
  return sumNotionalRows(rows);
}

export async function sumSubscriptionDailyNotionalUsd(
  userId: number,
  subscriptionId: string,
  dayStart: Date
): Promise<number> {
  const rows = await prisma.copyTradeRow.findMany({
    where: {
      userId,
      subscriptionId,
      status: { in: COUNTED_STATUSES },
      createdAt: { gte: dayStart },
    },
    select: {
      intendedNotional: true,
      intendedPrice: true,
      intendedSize: true,
    },
  });
  return sumNotionalRows(rows);
}

export async function sumMarketDailyNotionalUsd(
  userId: number,
  subscriptionId: string,
  marketId: string,
  dayStart: Date
): Promise<number> {
  const rows = await prisma.copyTradeRow.findMany({
    where: {
      userId,
      subscriptionId,
      status: { in: COUNTED_STATUSES },
      createdAt: { gte: dayStart },
      leaderTrade: { marketId },
    },
    select: {
      intendedNotional: true,
      intendedPrice: true,
      intendedSize: true,
    },
  });
  return sumNotionalRows(rows);
}
