import assert from 'node:assert/strict';
import { Prisma } from '../../generated/prisma/client';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://copy-pnl-test:copy-pnl-test@127.0.0.1:1/test';
process.env.COPY_PNL_DAY_TIMEZONE = 'Asia/Shanghai';
process.env.COPY_PNL_DAY_RESET_HOUR = '8';

async function main(): Promise<void> {
  await import('../../loadEnv');
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://copy-pnl-test:copy-pnl-test@127.0.0.1:1/test';
  process.env.COPY_PNL_DAY_TIMEZONE = 'Asia/Shanghai';
  process.env.COPY_PNL_DAY_RESET_HOUR = '8';
  process.env.CUSTODY_TREASURY_ADDRESS = '0x0000000000000000000000000000000000000001';
  process.env.JWT_SECRET = 'copy-pnl-test-secret';
  const {
    buildCopyPnlRevisionEventKey,
    buildPnlCurveDayStarts,
    computeCopyPnlBaseline,
    queryCopyPnlCurveForUser,
    recordCopyPnlEventInTx,
  } = await import('./copyPnlDailyLedger');

  const firstRevisionKey = buildCopyPnlRevisionEventKey(
    'redeem',
    'tx:close',
    '-2.25',
    '1.75'
  );
  assert.equal(
    firstRevisionKey,
    buildCopyPnlRevisionEventKey('redeem', 'tx:close', '-2.2500', '1.750')
  );
  assert.notEqual(
    firstRevisionKey,
    buildCopyPnlRevisionEventKey('redeem', 'tx:close', '1.75', '2.5')
  );
  assert.equal(computeCopyPnlBaseline('10', '20').toString(), '-10');

  const eventKeys = new Set<string>();
  const daily = new Map<string, Prisma.Decimal>();
  let settings: {
    copyPnlTotalUsd: Prisma.Decimal;
    copyPnlTodayUsd: Prisma.Decimal;
    copyPnlWindowStartAt: Date;
  } | null = null;
  const tx = {
    userCopyPnlEvent: {
      createMany: async ({ data }: { data: Array<{ eventKey: string }> }) => {
        const key = data[0].eventKey;
        if (eventKeys.has(key)) return { count: 0 };
        eventKeys.add(key);
        return { count: 1 };
      },
    },
    userCopyPnlDaily: {
      upsert: async (args: {
        where: { userId_dayStartAt: { dayStartAt: Date } };
        create: { realizedPnlUsd: Prisma.Decimal };
        update: { realizedPnlUsd: { increment: Prisma.Decimal } };
      }) => {
        const key = args.where.userId_dayStartAt.dayStartAt.toISOString();
        const previous = daily.get(key);
        daily.set(
          key,
          previous
            ? previous.plus(args.update.realizedPnlUsd.increment)
            : args.create.realizedPnlUsd
        );
        return {};
      },
    },
    userSettings: {
      findUnique: async () => settings,
      create: async ({ data }: { data: typeof settings }) => {
        settings = data;
        return data;
      },
      update: async ({ data }: {
        data: {
          copyPnlTotalUsd: Prisma.Decimal;
          copyPnlTodayUsd: Prisma.Decimal;
          copyPnlWindowStartAt: Date;
        };
      }) => {
        settings = data;
        return data;
      },
    },
  } as unknown as Prisma.TransactionClient;

  const firstAt = new Date('2026-08-01T01:00:00.000Z'); // 09:00 CST
  assert.equal(await recordCopyPnlEventInTx(tx, {
    eventKey: 'close:1',
    userId: 1,
    sourceType: 'COPY_LOT_CLOSE',
    sourceId: '1',
    previous: '0',
    next: '12.5',
    attributionAt: firstAt,
  }, { updateSummary: false }), true);
  assert.equal(await recordCopyPnlEventInTx(tx, {
    eventKey: 'close:1',
    userId: 1,
    sourceType: 'COPY_LOT_CLOSE',
    sourceId: '1',
    previous: '0',
    next: '12.5',
    attributionAt: firstAt,
  }, { updateSummary: false }), false);

  await recordCopyPnlEventInTx(tx, {
    eventKey: 'close:2',
    userId: 1,
    sourceType: 'COPY_LOT_CLOSE',
    sourceId: '2',
    previous: '0',
    next: '-2.25',
    attributionAt: firstAt,
  }, { updateSummary: false });
  await recordCopyPnlEventInTx(tx, {
    eventKey: 'redeem:tx:2',
    userId: 1,
    sourceType: 'REDEEM_REVISION',
    sourceId: 'tx:2',
    previous: '-2.25',
    next: '1.75',
    attributionAt: firstAt,
  }, { updateSummary: false });
  await recordCopyPnlEventInTx(tx, {
    eventKey: 'close:3',
    userId: 1,
    sourceType: 'COPY_LOT_CLOSE',
    sourceId: '3',
    previous: '0',
    next: '3',
    attributionAt: new Date('2026-08-02T01:00:00.000Z'),
  }, { updateSummary: false });

  assert.equal(daily.get('2026-08-01T00:00:00.000Z')?.toString(), '14.25');
  assert.equal(daily.get('2026-08-02T00:00:00.000Z')?.toString(), '3');
  assert.equal(eventKeys.size, 4);

  await recordCopyPnlEventInTx(tx, {
    eventKey: 'close:summary',
    userId: 1,
    sourceType: 'COPY_LOT_CLOSE',
    sourceId: 'summary',
    previous: '0',
    next: '2.5',
    attributionAt: new Date(),
  });
  assert.equal(settings?.copyPnlTotalUsd.toString(), '2.5');

  const curve = await queryCopyPnlCurveForUser(
    1,
    3,
    new Date('2026-08-02T02:00:00.000Z'),
    {
      userCopyPnlDaily: {
        findMany: async () => [{
          dayStartAt: new Date('2026-08-01T00:00:00.000Z'),
          realizedPnlUsd: new Prisma.Decimal('14.25'),
        }],
      },
    } as never
  );
  assert.deepEqual(curve.points.map((point) => point.dayLabel), [
    '2026-07-31',
    '2026-08-01',
    '2026-08-02',
  ]);
  assert.deepEqual(curve.points.map((point) => point.realizedPnlUsd), ['0', '14.25', '0']);

  const dstStarts = buildPnlCurveDayStarts(
    3,
    new Date('2026-03-09T15:00:00.000Z'),
    'America/New_York',
    8
  );
  assert.equal(dstStarts.length, 3);
  assert.equal(dstStarts[1].getTime() - dstStarts[0].getTime(), 23 * 60 * 60 * 1000);

  assert.throws(
    () => buildPnlCurveDayStarts(367, new Date(), 'UTC', 0),
    /between 1 and 366/
  );
  console.log('copyPnlDailyLedger.test.ts: ok');
}

void main();
