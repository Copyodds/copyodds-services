import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseUrl, expectPgError, pool, serializable } from './support';

const db = pool(120);
const userId = 9_000_001;
const accountId = '90000000-0000-4000-8000-000000000001';
const subscriptionId = '90000000-0000-4000-8000-000000000002';
const leaderId = '90000000-0000-4000-8000-000000000003';

async function resetFixture(): Promise<void> {
  await db.query('TRUNCATE "VirtualCopyRateLimitEvent", "VirtualPositionCloseQuote", "VirtualAccountEquitySnapshot", "VirtualAccountLedger", "VirtualPositionLotClose", "VirtualPositionLot", "VirtualCopyExecution", "VirtualCopyReplayCheckpoint", "VirtualCopySubscription", "VirtualCopyAccount" CASCADE');
  await db.query('DELETE FROM "CopyLeader" WHERE "id" = $1', [leaderId]);
  await db.query('DELETE FROM "User" WHERE "id" = $1', [userId]);
  await db.query(
    'INSERT INTO "User" ("id","username","inviteCode","updatedAt") VALUES ($1,$2,$3,NOW())',
    [userId, 'acceptance-user', 'ACCEPT9001'],
  );
  await db.query(
    'INSERT INTO "CopyLeader" ("id","address","updatedAt") VALUES ($1,$2,NOW())',
    [leaderId, '0x9000000000000000000000000000000000000001'],
  );
  await db.query(
    `INSERT INTO "VirtualCopyAccount"
      ("id","userId","name","initialBalanceUsd","cashBalanceUsd","expiresAt","updatedAt")
     VALUES ($1,$2,'acceptance-account',100,100,NOW() + INTERVAL '1 day',NOW())`,
    [accountId, userId],
  );
  await db.query(
    `INSERT INTO "VirtualCopySubscription"
      ("id","accountId","userId","leaderId","updatedAt")
     VALUES ($1,$2,$3,$4,NOW())`,
    [subscriptionId, accountId, userId, leaderId],
  );
}

async function insertExecution(id: string, side: 'BUY' | 'SELL' = 'BUY'): Promise<void> {
  await db.query(
    `INSERT INTO "VirtualCopyExecution"
      ("id","userId","accountId","subscriptionId","leaderId","leaderAddress","tokenId",
       "side","leaderPrice","targetSize","targetNotionalUsd","fillModel","priceSource",
       "configSnapshot","scheduledAt","updatedAt","idempotencyKey")
     VALUES ($1,$2,$3,$4,$5,'0x9000000000000000000000000000000000000001',
       'acceptance-token',$6,0.5,10,5,'ACCEPTANCE','ACCEPTANCE','{}',NOW(),NOW(),$7)`,
    [id, userId, accountId, subscriptionId, leaderId, side, `execution:${id}`],
  );
}

async function testConstraints(): Promise<void> {
  await expectPgError(
    () => db.query(
      `INSERT INTO "VirtualCopyAccount"
       ("id","userId","name","initialBalanceUsd","cashBalanceUsd","expiresAt","updatedAt")
       VALUES ($1,999999999,'bad-fk',1,1,NOW()+INTERVAL '1 day',NOW())`,
      [randomUUID()],
    ),
    ['23503'],
    'account user FK',
  );
  await expectPgError(
    () => db.query(
      `UPDATE "VirtualCopyAccount" SET "cashBalanceUsd"=-0.01 WHERE "id"=$1`,
      [accountId],
    ),
    ['23514'],
    'nonnegative cash check',
  );
  await expectPgError(
    () => db.query(
      `UPDATE "VirtualCopySubscription" SET "maxSlippage"=0.9 WHERE "id"=$1`,
      [subscriptionId],
    ),
    ['23514'],
    'slippage check',
  );
}

async function testTwoWorkerClaim(): Promise<void> {
  const id = randomUUID();
  await insertExecution(id);
  const claim = (token: string) => db.query(
    `UPDATE "VirtualCopyExecution"
     SET "status"='SIMULATING',"claimToken"=$2,"claimedAt"=NOW(),
         "claimExpiresAt"=NOW()+INTERVAL '30 seconds',"updatedAt"=NOW()
     WHERE "id"=$1 AND "status"='QUEUED' RETURNING "claimToken"`,
    [id, token],
  );
  const [a, b] = await Promise.all([claim('worker-a'), claim('worker-b')]);
  assert.equal(a.rowCount + b.rowCount, 1, 'exactly one worker must claim an execution');
}

async function testHundredBuyBalanceCompetition(): Promise<void> {
  await db.query('UPDATE "VirtualCopyAccount" SET "cashBalanceUsd"=100 WHERE "id"=$1', [accountId]);
  const wins = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const result = await serializable(db, async (client) => {
      const locked = await client.query<{ cash: string }>(
        'SELECT "cashBalanceUsd"::text AS cash FROM "VirtualCopyAccount" WHERE "id"=$1 FOR UPDATE',
        [accountId],
      );
      if (Number(locked.rows[0]!.cash) < 3) return false;
      await client.query(
        'UPDATE "VirtualCopyAccount" SET "cashBalanceUsd"="cashBalanceUsd"-3,"version"="version"+1 WHERE "id"=$1',
        [accountId],
      );
      await client.query(
        `INSERT INTO "VirtualAccountLedger"
         ("id","userId","accountId","direction","category","amountUsd","balanceAfterUsd",
          "idempotencyKey","metadata")
         SELECT $1,$2,$3,'DEBIT','BUY_FILL',3,"cashBalanceUsd",$4,$5::jsonb
         FROM "VirtualCopyAccount" WHERE "id"=$3`,
        [randomUUID(), userId, accountId, `buy-race:${index}`, JSON.stringify({ index })],
      );
      return true;
    });
    return result.value;
  }));
  assert.equal(wins.filter(Boolean).length, 33);
  const balance = await db.query<{ cash: string }>(
    'SELECT "cashBalanceUsd"::text AS cash FROM "VirtualCopyAccount" WHERE "id"=$1',
    [accountId],
  );
  assert.equal(balance.rows[0]!.cash, '1.000000000000000000');
}

async function testConcurrentCloseAndIdempotency(): Promise<void> {
  const buyId = randomUUID();
  await insertExecution(buyId);
  await db.query(
    `UPDATE "VirtualCopyExecution" SET "status"='FILLED',"simulatedFillSize"=100,
      "simulatedAvgPrice"=0.4,"simulatedNotionalUsd"=40,"filledAt"=NOW() WHERE "id"=$1`,
    [buyId],
  );
  const lotId = randomUUID();
  await db.query(
    `INSERT INTO "VirtualPositionLot"
     ("id","userId","accountId","subscriptionId","leaderId","leaderAddress","tokenId",
      "buyExecutionId","entryPrice","entrySize","remainingSize","entryNotionalUsd","openedAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'0x9000000000000000000000000000000000000001',
      'acceptance-token',$6,0.4,100,100,40,NOW(),NOW())`,
    [lotId, userId, accountId, subscriptionId, leaderId, buyId],
  );
  const requests = [
    { reason: 'LEADER_SELL', size: 60 },
    { reason: 'MANUAL_CLOSE', size: 60 },
    { reason: 'MARKET_RESOLUTION', size: 100 },
  ];
  const closed = await Promise.all(requests.map(async ({ reason, size }) => {
    const sellId = randomUUID();
    await insertExecution(sellId, 'SELL');
    const outcome = await serializable(db, async (client) => {
      const row = await client.query<{ remaining: string }>(
        'SELECT "remainingSize"::text AS remaining FROM "VirtualPositionLot" WHERE "id"=$1 FOR UPDATE',
        [lotId],
      );
      const amount = Math.min(size, Number(row.rows[0]!.remaining));
      if (amount <= 0) return 0;
      await client.query(
        `UPDATE "VirtualPositionLot" SET "remainingSize"="remainingSize"-$2,
          "status"=CASE WHEN "remainingSize"-$2=0 THEN 'CLOSED' ELSE "status" END,
          "updatedAt"=NOW() WHERE "id"=$1`,
        [lotId, amount],
      );
      await client.query(
        `INSERT INTO "VirtualPositionLotClose"
         ("id","userId","accountId","subscriptionId","lotId","buyExecutionId","sellExecutionId",
          "tokenId","closedSize","entryPrice","exitPrice","costBasisUsd","proceedsUsd",
          "realizedPnlUsd","closeReason")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'acceptance-token',$8,0.4,0.6,$8*0.4,$8*0.6,$8*0.2,$9)`,
        [randomUUID(), userId, accountId, subscriptionId, lotId, buyId, sellId, amount, reason],
      );
      await client.query(
        `INSERT INTO "VirtualAccountLedger"
         ("id","userId","accountId","direction","category","amountUsd","balanceAfterUsd","refId","idempotencyKey")
         VALUES ($1,$2,$3,'CREDIT',$4,$5,0,$6,$7) ON CONFLICT ("idempotencyKey") DO NOTHING`,
        [randomUUID(), userId, accountId, reason, amount * 0.6, sellId, `close:${sellId}`],
      );
      return amount;
    });
    return outcome.value;
  }));
  assert.equal(closed.reduce((sum, value) => sum + value, 0), 100);
  const remaining = await db.query<{ remaining: string }>(
    'SELECT "remainingSize"::text AS remaining FROM "VirtualPositionLot" WHERE "id"=$1',
    [lotId],
  );
  assert.equal(remaining.rows[0]!.remaining, '0.000000000000000000');
  const before = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM "VirtualAccountLedger" WHERE "idempotencyKey" LIKE \'close:%\'',
  );
  const existing = await db.query<{ refId: string }>(
    'SELECT "refId" FROM "VirtualAccountLedger" WHERE "idempotencyKey" LIKE \'close:%\' LIMIT 1',
  );
  await db.query(
    `INSERT INTO "VirtualAccountLedger"
     ("id","userId","accountId","direction","category","amountUsd","balanceAfterUsd","refId","idempotencyKey")
     VALUES ($1,$2,$3,'CREDIT','DUPLICATE',1,0,$4,$5) ON CONFLICT ("idempotencyKey") DO NOTHING`,
    [randomUUID(), userId, accountId, existing.rows[0]!.refId, `close:${existing.rows[0]!.refId}`],
  );
  const after = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM "VirtualAccountLedger" WHERE "idempotencyKey" LIKE \'close:%\'',
  );
  assert.equal(after.rows[0]!.count, before.rows[0]!.count, 'ledger replay must be idempotent');
}

async function testSerializableRetryAndCrashRecovery(): Promise<void> {
  await db.query('UPDATE "VirtualCopyAccount" SET "version"=0 WHERE "id"=$1', [accountId]);
  const a = await db.connect();
  const b = await db.connect();
  try {
    await Promise.all([
      a.query('BEGIN ISOLATION LEVEL SERIALIZABLE'),
      b.query('BEGIN ISOLATION LEVEL SERIALIZABLE'),
    ]);
    await Promise.all([
      a.query('SELECT "version" FROM "VirtualCopyAccount" WHERE "id"=$1', [accountId]),
      b.query('SELECT "version" FROM "VirtualCopyAccount" WHERE "id"=$1', [accountId]),
    ]);
    await a.query('UPDATE "VirtualCopyAccount" SET "version"="version"+1 WHERE "id"=$1', [accountId]);
    await a.query('COMMIT');
    await expectPgError(
      async () => {
        await b.query('UPDATE "VirtualCopyAccount" SET "version"="version"+1 WHERE "id"=$1', [accountId]);
        await b.query('COMMIT');
      },
      ['40001'],
      'serializable conflict',
    );
    await b.query('ROLLBACK').catch(() => undefined);
  } finally {
    a.release();
    b.release();
  }
  const retried = await serializable(db, async (client) => {
    await client.query(
      'UPDATE "VirtualCopyAccount" SET "version"="version"+1 WHERE "id"=$1',
      [accountId],
    );
    return true;
  });
  assert.equal(retried.value, true);

  const executionId = randomUUID();
  await insertExecution(executionId);
  const crashedWorker = await db.connect();
  await crashedWorker.query(
    `UPDATE "VirtualCopyExecution" SET "status"='SIMULATING',"claimToken"='crashed',
      "claimExpiresAt"=NOW()-INTERVAL '1 second' WHERE "id"=$1`,
    [executionId],
  );
  crashedWorker.release(true);
  const recovered = await db.query(
    `UPDATE "VirtualCopyExecution" SET "status"='QUEUED',"claimToken"=NULL,
      "claimExpiresAt"=NULL,"retryCount"="retryCount"+1,
      "errorCode"='virtual_stale_claim_recovered'
     WHERE "id"=$1 AND "status"='SIMULATING' AND "claimExpiresAt"<NOW()
     RETURNING "retryCount"`,
    [executionId],
  );
  assert.equal(recovered.rowCount, 1, 'expired lease must recover after worker crash');
}

async function assertConservation(): Promise<void> {
  const invalid = await db.query(
    `SELECT a."id"
     FROM "VirtualCopyAccount" a
     WHERE a."cashBalanceUsd" < 0 OR a."reservedBalanceUsd" < 0
        OR EXISTS (
          SELECT 1 FROM "VirtualPositionLot" l
          WHERE l."accountId"=a."id"
            AND (l."remainingSize"<0 OR l."remainingSize">l."entrySize")
        )`,
  );
  assert.equal(invalid.rowCount, 0, 'cash and lot conservation invariants');
}

async function main(): Promise<void> {
  console.log(`PostgreSQL acceptance target: ${new URL(databaseUrl).host}`);
  await resetFixture();
  await testConstraints();
  await testTwoWorkerClaim();
  await testHundredBuyBalanceCompetition();
  await testConcurrentCloseAndIdempotency();
  await testSerializableRetryAndCrashRecovery();
  await assertConservation();
  console.log('postgres.integration: all assertions passed');
}

main()
  .finally(() => db.end())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
