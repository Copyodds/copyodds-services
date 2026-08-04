import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pool, percentile } from './support';

const db = pool(40);
const leaderId = '91000000-0000-4000-8000-000000000001';
const tradeId = '91000000-0000-4000-8000-000000000002';
const prefix = 'accept-perf-';

function durationMs(): number {
  const raw = process.argv.find((arg) => arg.startsWith('--duration='))?.split('=')[1] ?? '0';
  const match = /^(\d+)(ms|s|m|h)?$/.exec(raw);
  if (!match) throw new Error(`invalid --duration: ${raw}`);
  const unit = match[2] ?? 'ms';
  return Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit] ?? 1);
}

async function fixture(): Promise<void> {
  await db.query(`DELETE FROM "User" WHERE "username" LIKE '${prefix}%'`);
  await db.query('DELETE FROM "LeaderTrade" WHERE "id"=$1', [tradeId]);
  await db.query('DELETE FROM "CopyLeader" WHERE "id"=$1', [leaderId]);
  await db.query(
    `INSERT INTO "CopyLeader" ("id","address","updatedAt")
     VALUES ($1,'0x9100000000000000000000000000000000000001',NOW())`,
    [leaderId],
  );
  await db.query(
    `INSERT INTO "User" ("username","inviteCode","updatedAt")
     SELECT $1 || n, 'PF' || lpad(n::text,8,'0'), NOW()
     FROM generate_series(1,1000) n`,
    [prefix],
  );
  await db.query(
    `INSERT INTO "VirtualCopyAccount"
     ("id","userId","name","initialBalanceUsd","cashBalanceUsd","expiresAt","updatedAt")
     SELECT gen_random_uuid()::text,u."id",'fanout-account',1000,1000,NOW()+INTERVAL '1 day',NOW()
     FROM "User" u WHERE u."username" LIKE $1`,
    [`${prefix}%`],
  );
  await db.query(
    `INSERT INTO "VirtualCopySubscription"
     ("id","accountId","userId","leaderId","updatedAt")
     SELECT gen_random_uuid()::text,a."id",a."userId",$1,NOW()
     FROM "VirtualCopyAccount" a JOIN "User" u ON u."id"=a."userId"
     WHERE u."username" LIKE $2`,
    [leaderId, `${prefix}%`],
  );
  await db.query(
    `INSERT INTO "LeaderTrade"
     ("id","leaderAddress","txHash","logIndex","side","amount","price","tokenId",
      "maker","taker","leaderId")
     VALUES ($1,'0x9100000000000000000000000000000000000001',
      '0x9100000000000000000000000000000000000000000000000000000000000001',
      910001,'BUY','10000000','0.5','perf-token',
      '0x9100000000000000000000000000000000000002',
      '0x9100000000000000000000000000000000000001',$2)`,
    [tradeId, leaderId],
  );
}

async function fanout1000(): Promise<number> {
  const started = performance.now();
  const inserted = await db.query(
    `INSERT INTO "VirtualCopyExecution"
     ("id","userId","accountId","subscriptionId","leaderTradeId","leaderId","leaderAddress",
      "tokenId","side","leaderPrice","targetSize","targetNotionalUsd","fillModel","priceSource",
      "configSnapshot","scheduledAt","updatedAt","idempotencyKey")
     SELECT gen_random_uuid()::text,s."userId",s."accountId",s."id",$1,s."leaderId",
      '0x9100000000000000000000000000000000000001','perf-token','BUY',0.5,10,5,
      'PERF','PERF','{}',NOW(),NOW(),'perf:'||s."id"
     FROM "VirtualCopySubscription" s
     JOIN "User" u ON u."id"=s."userId"
     WHERE u."username" LIKE $2
     ON CONFLICT DO NOTHING`,
    [tradeId, `${prefix}%`],
  );
  assert.equal(inserted.rowCount, 1000, 'fanout must create 1000 executions');
  return performance.now() - started;
}

async function latencySamples(): Promise<{ dashboardP95: number; listP95: number }> {
  const account = await db.query<{ id: string }>(
    `SELECT a."id" FROM "VirtualCopyAccount" a JOIN "User" u ON u."id"=a."userId"
     WHERE u."username" LIKE $1 LIMIT 1`,
    [`${prefix}%`],
  );
  const dashboard: number[] = [];
  const list: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    let started = performance.now();
    await db.query(
      `SELECT a."cashBalanceUsd",a."realizedPnlUsd",
        COALESCE(SUM(l."remainingSize"*l."entryPrice"),0) AS position_value,
        COUNT(DISTINCT s."id") AS subscriptions
       FROM "VirtualCopyAccount" a
       LEFT JOIN "VirtualPositionLot" l ON l."accountId"=a."id" AND l."remainingSize">0
       LEFT JOIN "VirtualCopySubscription" s ON s."accountId"=a."id" AND s."deletedAt" IS NULL
       WHERE a."id"=$1 GROUP BY a."id"`,
      [account.rows[0]!.id],
    );
    dashboard.push(performance.now() - started);
    started = performance.now();
    await db.query(
      `SELECT e."id",e."status",e."createdAt"
       FROM "VirtualCopyExecution" e
       JOIN "User" u ON u."id"=e."userId"
       WHERE u."username" LIKE $1
       ORDER BY e."createdAt" DESC,e."id" DESC LIMIT 100`,
      [`${prefix}%`],
    );
    list.push(performance.now() - started);
  }
  return { dashboardP95: percentile(dashboard, 0.95), listP95: percentile(list, 0.95) };
}

async function backlogRecovery(): Promise<number> {
  await db.query(
    `UPDATE "VirtualCopyExecution" SET "status"='SIMULATING',"claimToken"='dead-worker',
      "claimExpiresAt"=NOW()-INTERVAL '1 second'
     WHERE "id" IN (
       SELECT e."id" FROM "VirtualCopyExecution" e JOIN "User" u ON u."id"=e."userId"
       WHERE u."username" LIKE $1 LIMIT 1000
     )`,
    [`${prefix}%`],
  );
  const started = performance.now();
  const recovered = await db.query(
    `UPDATE "VirtualCopyExecution" e SET "status"='QUEUED',"claimToken"=NULL,
      "claimExpiresAt"=NULL,"retryCount"="retryCount"+1,
      "errorCode"='virtual_stale_claim_recovered'
     FROM "User" u
     WHERE e."userId"=u."id" AND u."username" LIKE $1
       AND e."status"='SIMULATING' AND e."claimExpiresAt"<NOW()`,
    [`${prefix}%`],
  );
  assert.equal(recovered.rowCount, 1000);
  return performance.now() - started;
}

async function conservation(): Promise<void> {
  const result = await db.query(
    `SELECT a."id" FROM "VirtualCopyAccount" a
     JOIN "User" u ON u."id"=a."userId"
     WHERE u."username" LIKE $1
       AND (a."cashBalanceUsd"<0 OR a."reservedBalanceUsd"<0
         OR EXISTS (
           SELECT 1 FROM "VirtualPositionLot" l WHERE l."accountId"=a."id"
             AND (l."remainingSize"<0 OR l."remainingSize">l."entrySize")
         ))`,
    [`${prefix}%`],
  );
  assert.equal(result.rowCount, 0);
}

async function main(): Promise<void> {
  await fixture();
  const fanoutMs = await fanout1000();
  const latency = await latencySamples();
  const recoveryMs = await backlogRecovery();
  const maxP95 = Number(process.env.ACCEPTANCE_QUERY_P95_MS ?? 250);
  assert.ok(latency.dashboardP95 <= maxP95, `dashboard p95 ${latency.dashboardP95}ms`);
  assert.ok(latency.listP95 <= maxP95, `list p95 ${latency.listP95}ms`);
  await conservation();
  console.log(JSON.stringify({ fanoutMs, recoveryMs, ...latency }));

  const soakFor = durationMs();
  if (soakFor > 0) {
    const deadline = Date.now() + soakFor;
    let cycles = 0;
    while (Date.now() < deadline) {
      await latencySamples();
      await backlogRecovery();
      await conservation();
      cycles += 1;
      console.log(JSON.stringify({ soakCycle: cycles, at: new Date().toISOString() }));
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  console.log('performance-soak: acceptance passed');
}

main()
  .finally(() => db.end())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
