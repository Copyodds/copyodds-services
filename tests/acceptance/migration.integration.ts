import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { databaseUrl, expectPgError } from './support';

const target = new URL(
  process.env.ACCEPTANCE_MIGRATION_DATABASE_URL
  ?? databaseUrl.replace(/\/[^/]+$/, '/polycopy_migration_acceptance'),
);
const databaseName = target.pathname.slice(1);
const adminUrl = new URL(target);
adminUrl.pathname = '/postgres';
const migrationsRoot = resolve(process.cwd(), 'prisma/migrations');
const phaseMigrations = [
  '20260717160000_virtual_copy_accounts_v1',
  '20260717170000_virtual_copy_integrity_replay',
  '20260717180000_remove_legacy_global_virtual_copy',
  '20260717190000_virtual_copy_production_evidence',
] as const;
const copyPnlDailyMigration = '20260802100000_add_user_copy_pnl_daily';

async function sql(directory: string): Promise<string> {
  return readFile(resolve(migrationsRoot, directory, 'migration.sql'), 'utf8');
}

async function recreateDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
    await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }
}

async function applyLegacyBaseline(client: pg.Client): Promise<void> {
  const directories = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name < phaseMigrations[0])
    .sort();
  for (const directory of directories) {
    try {
      await client.query(await sql(directory));
    } catch (error) {
      throw new Error(
        `legacy baseline migration failed at ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

async function seedLegacyFixture(client: pg.Client): Promise<void> {
  await client.query('SET session_replication_role = replica');
  try {
    await client.query(
      `INSERT INTO "copy_trades"
       ("id","userId","leaderTradeId","subscriptionId","status","isVirtual","executionMode","updatedAt")
       VALUES
       ('legacy-virtual-buy',9000001,'legacy-trade-buy','legacy-sub','filled',true,'VIRTUAL',NOW()),
       ('legacy-virtual-sell',9000001,'legacy-trade-sell','legacy-sub','filled',true,'VIRTUAL',NOW()),
       ('legacy-real',9000001,'legacy-trade-real','legacy-sub','filled',false,'REAL',NOW())`,
    );
    await client.query(
      `INSERT INTO "copy_position_lots"
       ("id","userId","subscriptionId","leaderAddress","tokenID","buyCopyTradeRowId",
        "entryPrice","entrySize","remainingSize","entryNotional")
       VALUES
       ('legacy-virtual-lot',9000001,'legacy-sub','0xlegacy','token','legacy-virtual-buy',0.4,10,5,4),
       ('legacy-real-lot',9000001,'legacy-sub','0xlegacy','token','legacy-real',0.4,10,5,4)`,
    );
    await client.query(
      `INSERT INTO "copy_position_lot_closes"
       ("id","userId","subscriptionId","sellCopyTradeRowId","buyCopyTradeRowId","lotId",
        "tokenID","closedSize","entryPrice","exitPrice","costBasisUsd","proceedsUsd","realizedPnlUsd")
       VALUES
       ('legacy-virtual-close',9000001,'legacy-sub','legacy-virtual-sell','legacy-virtual-buy',
        'legacy-virtual-lot','token',5,0.4,0.6,2,3,1)`,
    );
  } finally {
    await client.query('SET session_replication_role = DEFAULT');
  }
}

async function assertPhaseResult(client: pg.Client): Promise<void> {
  const legacy = await client.query<{ id: string }>('SELECT "id" FROM "copy_trades" ORDER BY "id"');
  assert.deepEqual(legacy.rows.map((row) => row.id), ['legacy-real']);
  const lots = await client.query<{ id: string }>('SELECT "id" FROM "copy_position_lots" ORDER BY "id"');
  assert.deepEqual(lots.rows.map((row) => row.id), ['legacy-real-lot']);
  assert.equal(
    Number((await client.query('SELECT COUNT(*) AS n FROM "copy_position_lot_closes"')).rows[0].n),
    0,
  );

  const expectedTables = [
    'VirtualCopyAccount',
    'VirtualCopySubscription',
    'VirtualCopyExecution',
    'VirtualPositionLot',
    'VirtualPositionLotClose',
    'VirtualAccountLedger',
    'VirtualAccountEquitySnapshot',
    'VirtualCopyReplayCheckpoint',
    'VirtualPositionCloseQuote',
    'VirtualCopyRateLimitEvent',
  ];
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name=ANY($1::text[])`,
    [expectedTables],
  );
  assert.equal(tables.rowCount, expectedTables.length, 'all v1 tables must exist');

  const retired = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND (
       (table_name='copy_trades' AND column_name IN ('isVirtual','executionMode'))
       OR (table_name='User' AND column_name='copyTradingVirtualEnabled')
       OR (table_name='UserSettings' AND column_name LIKE 'copyPnlVirtual%')
     )`,
  );
  assert.equal(retired.rowCount, 0, 'legacy global virtual-copy columns must be removed');

  const constraints = await client.query(
    `SELECT conname FROM pg_constraint
     WHERE conname IN (
       'VirtualCopyAccount_balances_nonnegative_ck',
       'VirtualCopyExecution_amounts_nonnegative_ck',
       'VirtualPositionLot_sizes_valid_ck',
       'VirtualCopyExecution_subscription_owner_consistency_fkey'
     )`,
  );
  assert.equal(constraints.rowCount, 4, 'production checks and ownership FK must exist');
}

async function assertCopyPnlDailyMigration(client: pg.Client): Promise<void> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public'
       AND table_name IN ('user_copy_pnl_events', 'user_copy_pnl_daily')`,
  );
  assert.equal(tables.rowCount, 2, 'copy PnL event and daily tables must exist');

  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname='public'
       AND indexname IN (
         'user_copy_pnl_events_eventKey_key',
         'user_copy_pnl_daily_userId_dayStartAt_key'
       )`,
  );
  assert.equal(indexes.rowCount, 2, 'copy PnL idempotency and range indexes must exist');

  const trigger = await client.query(
    `SELECT 1
     FROM pg_trigger
     WHERE tgname='user_copy_pnl_events_immutable'
       AND NOT tgisinternal`,
  );
  assert.equal(trigger.rowCount, 1, 'copy PnL event immutability trigger must exist');
}

async function main(): Promise<void> {
  await recreateDatabase();
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  try {
    await applyLegacyBaseline(client);
    await seedLegacyFixture(client);
    for (const directory of phaseMigrations) await client.query(await sql(directory));
    await assertPhaseResult(client);
    await client.query(await sql(copyPnlDailyMigration));
    await assertCopyPnlDailyMigration(client);

    const before = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "VirtualCopyAccount"',
    );
    const repeated190000 = await sql(phaseMigrations[3]);
    await expectPgError(
      () => client.query(repeated190000),
      ['42701', '42P07'],
      'duplicate 190000 migration',
    );
    const after = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "VirtualCopyAccount"',
    );
    assert.equal(after.rows[0]!.count, before.rows[0]!.count, 'failed repeat must preserve state');
    console.log('migration.integration: legacy 160000->190000 assertions passed');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
