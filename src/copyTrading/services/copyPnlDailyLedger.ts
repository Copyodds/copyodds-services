import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { applyCopyPnlSummaryDeltaInTx } from './copyPnlSummaryLedger';
import { getPnlDayWindowStartUtc } from './pnlDayWindow';

export const COPY_PNL_EVENT_EPS = new Prisma.Decimal('0.000000000001');
type DecimalInput = Prisma.Decimal | string | number;

export type CopyPnlEventInput = {
  eventKey: string;
  userId: number;
  sourceType: string;
  sourceId: string;
  previous: DecimalInput;
  next: DecimalInput;
  attributionAt: Date;
};

export type CopyPnlCurve = {
  timezone: string;
  resetHour: number;
  fromDayStartAt: string;
  toDayStartAt: string;
  points: Array<{
    dayStartAt: string;
    dayLabel: string;
    realizedPnlUsd: string;
  }>;
};

type LedgerTx = Pick<
  Prisma.TransactionClient,
  'userCopyPnlEvent' | 'userCopyPnlDaily' | 'userSettings'
>;

function decimal(value: DecimalInput): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

export function buildCopyPnlRevisionEventKey(
  revisionType: string,
  sourceId: string,
  previous: DecimalInput,
  next: DecimalInput
): string {
  return [
    'copy-pnl',
    revisionType,
    sourceId,
    decimal(previous).toString(),
    decimal(next).toString(),
  ].join(':');
}

export function computeCopyPnlBaseline(
  currentRealizedPnl: DecimalInput,
  recordedRevisionDelta: DecimalInput
): Prisma.Decimal {
  return decimal(currentRealizedPnl).minus(decimal(recordedRevisionDelta));
}

function previousDayStart(dayStartAt: Date, timezone: string, resetHour: number): Date {
  return getPnlDayWindowStartUtc(
    new Date(dayStartAt.getTime() - 12 * 60 * 60 * 1000),
    timezone,
    resetHour
  );
}

export function buildPnlCurveDayStarts(
  days: number,
  now: Date,
  timezone: string,
  resetHour: number
): Date[] {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new RangeError('days must be an integer between 1 and 366');
  }
  const starts = [getPnlDayWindowStartUtc(now, timezone, resetHour)];
  while (starts.length < days) {
    starts.push(previousDayStart(starts[starts.length - 1], timezone, resetHour));
  }
  return starts.reverse();
}

export function formatPnlDayLabel(dayStartAt: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dayStartAt);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Appends one immutable fact and applies its delta exactly once.
 * createMany(skipDuplicates) compiles to ON CONFLICT DO NOTHING on PostgreSQL, so a
 * duplicate event never raises P2002 and never leaves the surrounding transaction aborted.
 */
export async function recordCopyPnlEventInTx(
  tx: LedgerTx,
  input: CopyPnlEventInput,
  options: { updateSummary?: boolean } = {}
): Promise<boolean> {
  const previous = decimal(input.previous);
  const next = decimal(input.next);
  const delta = next.minus(previous);
  if (delta.abs().lt(COPY_PNL_EVENT_EPS)) return false;

  const dayStartAt = getPnlDayWindowStartUtc(
    input.attributionAt,
    CONFIG.copyPnlDayTimezone,
    CONFIG.copyPnlDayResetHour
  );
  const inserted = await tx.userCopyPnlEvent.createMany({
    data: [{
      id: randomUUID(),
      eventKey: input.eventKey,
      userId: input.userId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      previous,
      next,
      delta,
      attributionAt: input.attributionAt,
      dayStartAt,
    }],
    skipDuplicates: true,
  });
  if (inserted.count !== 1) return false;

  await tx.userCopyPnlDaily.upsert({
    where: {
      userId_dayStartAt: {
        userId: input.userId,
        dayStartAt,
      },
    },
    create: {
      userId: input.userId,
      dayStartAt,
      realizedPnlUsd: delta,
    },
    update: {
      realizedPnlUsd: { increment: delta },
    },
  });
  if (options.updateSummary !== false) {
    await applyCopyPnlSummaryDeltaInTx(
      tx,
      input.userId,
      Number(delta.toString()),
      input.attributionAt
    );
  }
  return true;
}

export async function recordCopyPnlEvent(
  input: CopyPnlEventInput,
  options: { updateSummary?: boolean } = {}
): Promise<boolean> {
  return prisma.$transaction((tx) => recordCopyPnlEventInTx(tx, input, options));
}

export async function reconcileCopyPnlDailyTotalForUser(
  userId: number,
  reconciliationKey: string,
  attributionAt: Date = new Date()
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [daily, settings] = await Promise.all([
      tx.userCopyPnlDaily.aggregate({
        where: { userId },
        _sum: { realizedPnlUsd: true },
      }),
      tx.userSettings.findUnique({
        where: { userId },
        select: { copyPnlTotalUsd: true },
      }),
    ]);
    const previous = daily._sum.realizedPnlUsd ?? new Prisma.Decimal(0);
    const next = settings?.copyPnlTotalUsd ?? new Prisma.Decimal(0);
    return recordCopyPnlEventInTx(tx, {
      eventKey: buildCopyPnlRevisionEventKey(
        'reconcile',
        `${reconciliationKey}:${userId}`,
        previous,
        next
      ),
      userId,
      sourceType: 'RECONCILIATION',
      sourceId: reconciliationKey,
      previous,
      next,
      attributionAt,
    }, { updateSummary: false });
  });
}

export async function queryCopyPnlCurveForUser(
  userId: number,
  days: number,
  now: Date = new Date(),
  client: Pick<typeof prisma, 'userCopyPnlDaily'> = prisma
): Promise<CopyPnlCurve> {
  const starts = buildPnlCurveDayStarts(
    days,
    now,
    CONFIG.copyPnlDayTimezone,
    CONFIG.copyPnlDayResetHour
  );
  const from = starts[0];
  const to = starts[starts.length - 1];
  const rows = await client.userCopyPnlDaily.findMany({
    where: {
      userId,
      dayStartAt: { gte: from, lte: to },
    },
    select: { dayStartAt: true, realizedPnlUsd: true },
  });
  const byStart = new Map(
    rows.map((row) => [row.dayStartAt.toISOString(), row.realizedPnlUsd.toString()])
  );
  return {
    timezone: CONFIG.copyPnlDayTimezone,
    resetHour: CONFIG.copyPnlDayResetHour,
    fromDayStartAt: from.toISOString(),
    toDayStartAt: to.toISOString(),
    points: starts.map((dayStartAt) => ({
      dayStartAt: dayStartAt.toISOString(),
      dayLabel: formatPnlDayLabel(dayStartAt, CONFIG.copyPnlDayTimezone),
      realizedPnlUsd: byStart.get(dayStartAt.toISOString()) ?? '0',
    })),
  };
}
