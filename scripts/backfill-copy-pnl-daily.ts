/**
 * Backfills the immutable daily copy-PnL ledger from the same sources as
 * loadCopyPnlAggregate: lot closes plus realized copy trades with no matching close.
 *
 * BACKFILL_USER_IDS=1,2  BACKFILL_LIMIT=100  BACKFILL_AFTER_USER_ID=0
 * BACKFILL_USER_BATCH_SIZE=100  BACKFILL_BATCH_SIZE=250
 * DRY_RUN=true  BACKFILL_CUTOFF_AT=2026-08-02T00:00:00.000Z
 *
 * The cutoff is parsed once at startup, making reruns deterministic. Event insertion is
 * concurrency-safe via ON CONFLICT DO NOTHING. Lot rows are locked before their baseline
 * is calculated, and already-recorded revision deltas are subtracted to prevent double count.
 */
import { Prisma } from '../src/generated/prisma/client';
import { prisma } from '../src/db';
import {
  computeCopyPnlBaseline,
  recordCopyPnlEventInTx,
} from '../src/copyTrading/services/copyPnlDailyLedger';

type SourceIdRow = { id: string };

const dryRun = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? '');
const configuredUserLimit = process.env.BACKFILL_LIMIT
  ? Math.min(1_000_000, Math.max(1, Number(process.env.BACKFILL_LIMIT) || 1))
  : null;
const userBatchSize = Math.min(
  1_000,
  Math.max(1, Number(process.env.BACKFILL_USER_BATCH_SIZE ?? 100) || 100)
);
const initialAfterUserId = Math.max(
  0,
  Number(process.env.BACKFILL_AFTER_USER_ID ?? 0) || 0
);
const batchSize = Math.min(
  1_000,
  Math.max(1, Number(process.env.BACKFILL_BATCH_SIZE ?? 250) || 250)
);
const cutoffAt = process.env.BACKFILL_CUTOFF_AT
  ? new Date(process.env.BACKFILL_CUTOFF_AT)
  : new Date();

if (Number.isNaN(cutoffAt.getTime())) {
  throw new Error('BACKFILL_CUTOFF_AT must be a valid ISO timestamp');
}

async function loadUserIds(): Promise<number[]> {
  const explicit = (process.env.BACKFILL_USER_IDS ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (explicit.length) {
    return [...new Set(explicit)].slice(0, configuredUserLimit ?? explicit.length);
  }

  const userIds: number[] = [];
  let afterUserId = initialAfterUserId;
  while (configuredUserLimit == null || userIds.length < configuredUserLimit) {
    const remaining = configuredUserLimit == null
      ? userBatchSize
      : Math.min(userBatchSize, configuredUserLimit - userIds.length);
    const rows = await prisma.$queryRaw<Array<{ userId: number }>>`
      SELECT source."userId"
      FROM (
        SELECT lc."userId"
        FROM copy_position_lot_closes lc
        WHERE lc."createdAt" <= ${cutoffAt}
        UNION
        SELECT ct."userId"
        FROM copy_trades ct
        WHERE ct."realizedPnlUsd" IS NOT NULL
          AND ct."realizedPnlAt" <= ${cutoffAt}
          AND NOT EXISTS (
            SELECT 1 FROM copy_position_lot_closes lc
            WHERE lc."userId" = ct."userId"
              AND (
                lc."sellCopyTradeRowId" = ct.id
                OR lc."sellCopyTradeRowId" = ('legacy:' || ct.id)
              )
          )
      ) source
      WHERE source."userId" > ${afterUserId}
      ORDER BY source."userId"
      LIMIT ${remaining}
    `;
    if (!rows.length) break;
    userIds.push(...rows.map((row) => row.userId));
    afterUserId = rows[rows.length - 1].userId;
    if (rows.length < remaining) break;
  }
  return userIds;
}

async function loadLotBatch(userId: number, afterId: string): Promise<SourceIdRow[]> {
  return prisma.$queryRaw<SourceIdRow[]>`
    SELECT lc.id
    FROM copy_position_lot_closes lc
    WHERE lc."userId" = ${userId}
      AND lc."createdAt" <= ${cutoffAt}
      AND lc.id > ${afterId}
    ORDER BY lc.id
    LIMIT ${batchSize}
  `;
}

async function loadOrphanBatch(userId: number, afterId: string): Promise<SourceIdRow[]> {
  return prisma.$queryRaw<SourceIdRow[]>`
    SELECT ct.id
    FROM copy_trades ct
    WHERE ct."userId" = ${userId}
      AND ct."realizedPnlUsd" IS NOT NULL
      AND ct."realizedPnlAt" <= ${cutoffAt}
      AND ct.id > ${afterId}
      AND NOT EXISTS (
        SELECT 1 FROM copy_position_lot_closes lc
        WHERE lc."userId" = ct."userId"
          AND (
            lc."sellCopyTradeRowId" = ct.id
            OR lc."sellCopyTradeRowId" = ('legacy:' || ct.id)
          )
      )
    ORDER BY ct.id
    LIMIT ${batchSize}
  `;
}

async function backfillLots(userId: number): Promise<{ scanned: number; inserted: number }> {
  let afterId = '';
  let scanned = 0;
  let inserted = 0;
  while (true) {
    const rows = await loadLotBatch(userId, afterId);
    if (!rows.length) break;
    scanned += rows.length;
    if (!dryRun) {
      inserted += await prisma.$transaction(async (tx) => {
        let count = 0;
        for (const source of rows) {
          const locked = await tx.$queryRaw<Array<{
            id: string;
            currentPnl: string;
            attributionAt: Date;
          }>>`
            SELECT lc.id,
                   (lc."proceedsUsd" - lc."costBasisUsd")::text AS "currentPnl",
                   lc."createdAt" AS "attributionAt"
            FROM copy_position_lot_closes lc
            WHERE lc.id = ${source.id}
              AND lc."userId" = ${userId}
              AND lc."createdAt" <= ${cutoffAt}
            FOR UPDATE
          `;
          const row = locked[0];
          if (!row) continue;
          const revisions = await tx.userCopyPnlEvent.aggregate({
            where: {
              userId,
              sourceId: row.id,
              sourceType: { in: ['EXPIRED_REVISION', 'REDEEM_REVISION'] },
            },
            _sum: { delta: true },
          });
          const baseline = computeCopyPnlBaseline(
            row.currentPnl,
            revisions._sum.delta ?? new Prisma.Decimal(0)
          );
          if (await recordCopyPnlEventInTx(tx, {
            eventKey: `copy-pnl:close:${row.id}`,
            userId,
            sourceType: 'COPY_LOT_CLOSE',
            sourceId: row.id,
            previous: 0,
            next: baseline,
            attributionAt: row.attributionAt,
          }, { updateSummary: false })) {
            count += 1;
          }
        }
        return count;
      });
    }
    afterId = rows[rows.length - 1].id;
  }
  return { scanned, inserted };
}

async function backfillOrphans(userId: number): Promise<{ scanned: number; inserted: number }> {
  let afterId = '';
  let scanned = 0;
  let inserted = 0;
  while (true) {
    const rows = await loadOrphanBatch(userId, afterId);
    if (!rows.length) break;
    scanned += rows.length;
    if (!dryRun) {
      inserted += await prisma.$transaction(async (tx) => {
        let count = 0;
        for (const source of rows) {
          const locked = await tx.$queryRaw<Array<{
            id: string;
            currentPnl: string;
            attributionAt: Date;
          }>>`
            SELECT ct.id,
                   ct."realizedPnlUsd"::text AS "currentPnl",
                   ct."realizedPnlAt" AS "attributionAt"
            FROM copy_trades ct
            WHERE ct.id = ${source.id}
              AND ct."userId" = ${userId}
              AND ct."realizedPnlUsd" IS NOT NULL
              AND ct."realizedPnlAt" <= ${cutoffAt}
              AND NOT EXISTS (
                SELECT 1 FROM copy_position_lot_closes lc
                WHERE lc."userId" = ct."userId"
                  AND (
                    lc."sellCopyTradeRowId" = ct.id
                    OR lc."sellCopyTradeRowId" = ('legacy:' || ct.id)
                  )
              )
            FOR UPDATE
          `;
          const row = locked[0];
          if (!row) continue;
          if (await recordCopyPnlEventInTx(tx, {
            eventKey: `copy-pnl:orphan-trade:${row.id}`,
            userId,
            sourceType: 'ORPHAN_COPY_TRADE',
            sourceId: row.id,
            previous: 0,
            next: row.currentPnl,
            attributionAt: row.attributionAt,
          }, { updateSummary: false })) {
            count += 1;
          }
        }
        return count;
      });
    }
    afterId = rows[rows.length - 1].id;
  }
  return { scanned, inserted };
}

async function warnOnDrift(userId: number): Promise<void> {
  const [daily, settings] = await Promise.all([
    prisma.userCopyPnlDaily.aggregate({
      where: { userId },
      _sum: { realizedPnlUsd: true },
    }),
    prisma.userSettings.findUnique({
      where: { userId },
      select: { copyPnlTotalUsd: true },
    }),
  ]);
  const dailyTotal = daily._sum.realizedPnlUsd ?? new Prisma.Decimal(0);
  const summaryTotal = settings?.copyPnlTotalUsd ?? new Prisma.Decimal(0);
  const drift = dailyTotal.minus(summaryTotal).abs();
  if (drift.gt('0.01')) {
    console.warn('[backfill-copy-pnl-daily] daily/summary drift', {
      userId,
      dailyTotal: dailyTotal.toString(),
      summaryTotal: summaryTotal.toString(),
      drift: drift.toString(),
    });
  }
}

async function main(): Promise<void> {
  const userIds = await loadUserIds();
  console.log('[backfill-copy-pnl-daily] start', {
    users: userIds.length,
    afterUserId: initialAfterUserId,
    configuredUserLimit,
    batchSize,
    dryRun,
    cutoffAt: cutoffAt.toISOString(),
  });
  for (const userId of userIds) {
    const lots = await backfillLots(userId);
    const orphans = await backfillOrphans(userId);
    console.log('[backfill-copy-pnl-daily] user complete', { userId, lots, orphans });
    if (!dryRun) await warnOnDrift(userId);
  }
}

main()
  .catch((error) => {
    console.error('[backfill-copy-pnl-daily] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
