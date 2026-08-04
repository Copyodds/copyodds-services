import { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { logger } from '../../utils/logger';
import { getPnlDayWindowStartUtc } from './pnlDayWindow';

const EPS = 1e-12;
const LEDGER_DRIFT_EPS = 0.01;

export type CopyPnlSummaryResult = {
  totalRealizedPnlUsd: string;
  todayRealizedPnlUsd: string;
  todayWindowStartAt: string;
  todayWindowTimezone: string;
};

type TxLike = {
  userSettings: {
    findUnique: typeof prisma.userSettings.findUnique;
    create: typeof prisma.userSettings.create;
    update: typeof prisma.userSettings.update;
  };
};

function dec(value: number | string): Prisma.Decimal {
  return new Prisma.Decimal(typeof value === 'number' ? value.toFixed(8) : value);
}

function pnlWindowMatches(stored: Date, expected: Date): boolean {
  return Math.abs(stored.getTime() - expected.getTime()) < 1000;
}

export async function applyCopyPnlSummaryDeltaInTx(
  tx: TxLike,
  userId: number,
  deltaUsd: number,
  attributionAt: Date = new Date()
): Promise<void> {
  if (!Number.isFinite(deltaUsd) || Math.abs(deltaUsd) < EPS) return;
  const windowStart = getPnlDayWindowStartUtc(
    attributionAt,
    CONFIG.copyPnlDayTimezone,
    CONFIG.copyPnlDayResetHour
  );
  const delta = dec(deltaUsd);
  const countsTowardToday = attributionAt.getTime() >= windowStart.getTime();
  const existing = await tx.userSettings.findUnique({
    where: { userId },
    select: {
      copyPnlTotalUsd: true,
      copyPnlTodayUsd: true,
      copyPnlWindowStartAt: true,
    },
  });

  if (!existing) {
    await tx.userSettings.create({
      data: {
        userId,
        copyPnlTotalUsd: delta,
        copyPnlTodayUsd: countsTowardToday ? delta : new Prisma.Decimal(0),
        copyPnlWindowStartAt: windowStart,
        copyPnlComputedAt: attributionAt,
      },
    });
    return;
  }

  const total = (existing.copyPnlTotalUsd ?? new Prisma.Decimal(0)).plus(delta);
  const windowCurrent =
    existing.copyPnlWindowStartAt != null &&
    pnlWindowMatches(existing.copyPnlWindowStartAt, windowStart);
  const previousToday = windowCurrent
    ? existing.copyPnlTodayUsd ?? new Prisma.Decimal(0)
    : new Prisma.Decimal(0);
  const today = countsTowardToday ? previousToday.plus(delta) : previousToday;
  await tx.userSettings.update({
    where: { userId },
    data: {
      copyPnlTotalUsd: total,
      copyPnlTodayUsd: today,
      copyPnlWindowStartAt: windowStart,
      copyPnlComputedAt: attributionAt,
    },
  });
}

export async function applyCopyPnlSummaryDeltaFromCloseRevisionInTx(
  tx: TxLike,
  userId: number,
  previousRealizedUsd: number,
  nextRealizedUsd: number,
  attributionAt: Date = new Date()
): Promise<void> {
  await applyCopyPnlSummaryDeltaInTx(
    tx,
    userId,
    nextRealizedUsd - previousRealizedUsd,
    attributionAt
  );
}

export async function applyCopyPnlSummaryDelta(
  userId: number,
  deltaUsd: number,
  attributionAt: Date = new Date()
): Promise<void> {
  await prisma.$transaction((tx) =>
    applyCopyPnlSummaryDeltaInTx(tx, userId, deltaUsd, attributionAt)
  );
}

export async function readCopyPnlSummaryForUser(
  userId: number,
  now: Date = new Date()
): Promise<CopyPnlSummaryResult> {
  const todayWindowStart = getPnlDayWindowStartUtc(
    now,
    CONFIG.copyPnlDayTimezone,
    CONFIG.copyPnlDayResetHour
  );
  let row = await prisma.userSettings.findUnique({
    where: { userId },
    select: {
      copyPnlTotalUsd: true,
      copyPnlTodayUsd: true,
      copyPnlWindowStartAt: true,
    },
  });
  if (
    row?.copyPnlWindowStartAt &&
    !pnlWindowMatches(row.copyPnlWindowStartAt, todayWindowStart)
  ) {
    row = await prisma.userSettings.update({
      where: { userId },
      data: {
        copyPnlTodayUsd: new Prisma.Decimal(0),
        copyPnlWindowStartAt: todayWindowStart,
        copyPnlComputedAt: now,
      },
      select: {
        copyPnlTotalUsd: true,
        copyPnlTodayUsd: true,
        copyPnlWindowStartAt: true,
      },
    });
  }
  return {
    totalRealizedPnlUsd: (row?.copyPnlTotalUsd ?? new Prisma.Decimal(0)).toString(),
    todayRealizedPnlUsd: (row?.copyPnlTodayUsd ?? new Prisma.Decimal(0)).toString(),
    todayWindowStartAt: todayWindowStart.toISOString(),
    todayWindowTimezone: CONFIG.copyPnlDayTimezone,
  };
}

type PnlAggregate = { totalNum: number; todayNum: number };

/**
 * Keep realizedPnlUsd aligned with proceeds − cost. List UI recomputes this;
 * summary used to SUM the column and could drift when repairs only rewrote proceeds.
 */
async function healLotCloseRealizedPnlDriftForUser(userId: number): Promise<number> {
  const updated = await prisma.$executeRaw`
    UPDATE copy_position_lot_closes
    SET "realizedPnlUsd" = "proceedsUsd" - "costBasisUsd"
    WHERE "userId" = ${userId}
      AND ABS("realizedPnlUsd" - ("proceedsUsd" - "costBasisUsd")) > 0.0001
  `;
  return typeof updated === 'number' ? updated : Number(updated);
}

async function loadCopyPnlAggregate(userId: number, todayWindowStart: Date): Promise<PnlAggregate> {
  type AggRow = { total: string | null; today: string | null };
  // List PnL = proceeds − cost; do not trust realizedPnlUsd column alone.
  const [lotRows, orphanRows] = await Promise.all([
    prisma.$queryRaw<AggRow[]>`
      SELECT
        COALESCE(SUM(lc."proceedsUsd" - lc."costBasisUsd"), 0)::text AS total,
        COALESCE(
          SUM(lc."proceedsUsd" - lc."costBasisUsd") FILTER (WHERE lc."createdAt" >= ${todayWindowStart}),
          0
        )::text AS today
      FROM copy_position_lot_closes lc
      WHERE lc."userId" = ${userId}
    `,
    prisma.$queryRaw<AggRow[]>`
      SELECT
        COALESCE(SUM(ct."realizedPnlUsd"), 0)::text AS total,
        COALESCE(SUM(ct."realizedPnlUsd") FILTER (
          WHERE ct."realizedPnlAt" >= ${todayWindowStart}
        ), 0)::text AS today
      FROM copy_trades ct
      WHERE ct."userId" = ${userId}
        AND ct."realizedPnlUsd" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM copy_position_lot_closes lc
          WHERE lc."userId" = ct."userId"
            AND (
              lc."sellCopyTradeRowId" = ct.id
              OR lc."sellCopyTradeRowId" = ('legacy:' || ct.id)
            )
        )
    `,
  ]);
  return {
    totalNum: Number(lotRows[0]?.total ?? 0) + Number(orphanRows[0]?.total ?? 0),
    todayNum: Number(lotRows[0]?.today ?? 0) + Number(orphanRows[0]?.today ?? 0),
  };
}

export async function loadRealizedPnlBySubscriptionIdForUser(
  userId: number
): Promise<Map<string, string>> {
  type AggRow = { subscriptionId: string; total: string | null };
  const [lotRows, orphanRows] = await Promise.all([
    prisma.$queryRaw<AggRow[]>`
      SELECT
        lc."subscriptionId" AS "subscriptionId",
        COALESCE(SUM(lc."proceedsUsd" - lc."costBasisUsd"), 0)::text AS total
      FROM copy_position_lot_closes lc
      WHERE lc."userId" = ${userId}
      GROUP BY lc."subscriptionId"
    `,
    prisma.$queryRaw<AggRow[]>`
      SELECT ct."subscriptionId" AS "subscriptionId",
             COALESCE(SUM(ct."realizedPnlUsd"), 0)::text AS total
      FROM copy_trades ct
      WHERE ct."userId" = ${userId}
        AND ct."realizedPnlUsd" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM copy_position_lot_closes lc
          WHERE lc."userId" = ct."userId"
            AND (
              lc."sellCopyTradeRowId" = ct.id
              OR lc."sellCopyTradeRowId" = ('legacy:' || ct.id)
            )
        )
      GROUP BY ct."subscriptionId"
    `,
  ]);
  const totals = new Map<string, number>();
  for (const row of [...lotRows, ...orphanRows]) {
    const value = Number(row.total ?? 0);
    if (row.subscriptionId && Number.isFinite(value)) {
      totals.set(row.subscriptionId, (totals.get(row.subscriptionId) ?? 0) + value);
    }
  }
  return new Map(
    [...totals].map(([id, value]) => [id, dec(value).toString()])
  );
}

export async function ensureCopyPnlSummaryLedgerSyncedForUser(userId: number): Promise<boolean> {
  const now = new Date();
  const todayWindowStart = getPnlDayWindowStartUtc(
    now,
    CONFIG.copyPnlDayTimezone,
    CONFIG.copyPnlDayResetHour
  );
  const healed = await healLotCloseRealizedPnlDriftForUser(userId);
  if (healed > 0) {
    logger.info({ userId, healed }, 'healed lot-close realizedPnlUsd drift vs proceeds-cost');
  }
  const [aggregate, row] = await Promise.all([
    loadCopyPnlAggregate(userId, todayWindowStart),
    prisma.userSettings.findUnique({
      where: { userId },
      select: {
        copyPnlTotalUsd: true,
        copyPnlTodayUsd: true,
        copyPnlWindowStartAt: true,
      },
    }),
  ]);
  const totalDrift =
    Math.abs(Number(row?.copyPnlTotalUsd?.toString() ?? 0) - aggregate.totalNum) >
    LEDGER_DRIFT_EPS;
  const windowRolled =
    row?.copyPnlWindowStartAt != null &&
    !pnlWindowMatches(row.copyPnlWindowStartAt, todayWindowStart);
  const todayDrift =
    row?.copyPnlWindowStartAt != null &&
    pnlWindowMatches(row.copyPnlWindowStartAt, todayWindowStart) &&
    Math.abs(Number(row.copyPnlTodayUsd?.toString() ?? 0) - aggregate.todayNum) >
      LEDGER_DRIFT_EPS;
  if (!healed && !totalDrift && !windowRolled && !todayDrift) return false;
  await rebuildCopyPnlSummaryFromAggregatesForUser(userId);
  logger.info({ userId }, 'rebuilt real copy pnl summary after ledger drift');
  return true;
}

export async function rebuildCopyPnlSummaryFromAggregatesForUser(userId: number): Promise<void> {
  const now = new Date();
  const todayWindowStart = getPnlDayWindowStartUtc(
    now,
    CONFIG.copyPnlDayTimezone,
    CONFIG.copyPnlDayResetHour
  );
  const aggregate = await loadCopyPnlAggregate(userId, todayWindowStart);
  await prisma.userSettings.upsert({
    where: { userId },
    create: {
      userId,
      copyPnlTotalUsd: dec(aggregate.totalNum),
      copyPnlTodayUsd: dec(aggregate.todayNum),
      copyPnlWindowStartAt: todayWindowStart,
      copyPnlComputedAt: now,
    },
    update: {
      copyPnlTotalUsd: dec(aggregate.totalNum),
      copyPnlTodayUsd: dec(aggregate.todayNum),
      copyPnlWindowStartAt: todayWindowStart,
      copyPnlComputedAt: now,
    },
  });
}
