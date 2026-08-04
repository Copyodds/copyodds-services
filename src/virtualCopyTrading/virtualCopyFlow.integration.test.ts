import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { DataType, newDb } from 'pg-mem';
import pg from 'pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://virtual-copy-test:virtual-copy-test@127.0.0.1:1/test';
process.env.CUSTODY_TREASURY_ADDRESS = '0x0000000000000000000000000000000000000001';

const memory = newDb({
  autoCreateForeignKeyIndices: true,
  noAstCoverageCheck: true,
});
memory.public.registerFunction({
  name: 'current_database',
  returns: DataType.text,
  implementation: () => 'virtual_copy_test',
});
memory.public.registerFunction({
  name: 'version',
  returns: DataType.text,
  implementation: () => 'PostgreSQL 16.0 (pg-mem)',
});
memory.public.registerFunction({
  name: 'pg_advisory_xact_lock',
  args: [DataType.integer, DataType.integer],
  returns: DataType.integer,
  implementation: () => 1,
});

memory.public.none(`
  CREATE TYPE "CopyMode" AS ENUM ('RATIO', 'FIXED_AMOUNT', 'SMART');
  CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED');
  CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');
  CREATE TYPE "TradingSystemMode" AS ENUM ('NORMAL', 'TRACK_ONLY', 'PAUSED');
  CREATE TABLE "User" ("id" INTEGER PRIMARY KEY);
  CREATE TABLE "CopyLeader" ("id" TEXT PRIMARY KEY, "address" TEXT NOT NULL UNIQUE);
  CREATE TABLE "LeaderTrade" (
    "id" TEXT PRIMARY KEY,
    "leaderAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "sourceFillCount" INTEGER NOT NULL DEFAULT 1,
    "signalSource" TEXT NOT NULL DEFAULT 'order_filled',
    "side" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "marketId" TEXT,
    "marketTitle" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT,
    "maker" TEXT NOT NULL,
    "taker" TEXT NOT NULL,
    "makerAssetId" TEXT NOT NULL DEFAULT '',
    "takerAssetId" TEXT NOT NULL DEFAULT '',
    "blockNumber" INTEGER,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaderId" TEXT
  );
  CREATE TABLE "SystemControl" (
    "key" TEXT PRIMARY KEY,
    "mode" "TradingSystemMode" NOT NULL DEFAULT 'NORMAL',
    "reason" TEXT,
    "metadata" JSONB,
    "restoreAt" TIMESTAMP(3),
    "updatedByAdminUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260717160000_virtual_copy_accounts_v1/migration.sql'),
  'utf8',
);
const schemaWithoutForeignKeys = migration.split('ALTER TABLE "VirtualCopyAccount"')[0]!;
memory.public.none(schemaWithoutForeignKeys);
memory.public.none(`
  CREATE TABLE "VirtualCopyReplayCheckpoint" (
    "key" TEXT PRIMARY KEY,
    "lastCreatedAt" TIMESTAMP(3) NOT NULL,
    "lastTradeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
  );
`);
const productionEvidenceMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260717190000_virtual_copy_production_evidence/migration.sql',
  ),
  'utf8',
);
memory.public.none(productionEvidenceMigration.split('-- Product names')[0]!);

const memoryPg = memory.adapters.createPg();
const memoryPool = new memoryPg.Pool();
Object.setPrototypeOf(Object.getPrototypeOf(memoryPool), pg.Pool.prototype);

type QueryResult = {
  rows: Array<Record<string, unknown> | unknown[]>;
  fields?: Array<{ name: string; dataTypeID?: number }>;
};
type QueryTarget = {
  query: (...args: unknown[]) => Promise<QueryResult>;
};

function addArrayRowMode(target: QueryTarget): void {
  const originalQuery = target.query.bind(target);
  target.query = async (config: unknown, ...rest: unknown[]) => {
    if (
      config == null ||
      typeof config !== 'object' ||
      !('rowMode' in config) ||
      config.rowMode !== 'array'
    ) {
      return originalQuery(config, ...rest);
    }
    const { rowMode: _rowMode, types: _types, ...plainConfig } = config;
    const text = 'text' in plainConfig ? String(plainConfig.text) : '';
    if (/^SET TRANSACTION ISOLATION LEVEL /i.test(text.trim())) {
      return { rows: [], rowCount: 0, fields: [] } as QueryResult;
    }
    const compatibleConfig = {
      ...plainConfig,
      ...(text ? { text: text.replace(/\s+FOR UPDATE\s*$/i, '') } : {}),
    };
    const result = await originalQuery(compatibleConfig, ...rest);
    const firstObjectRow = result.rows.find(
      (row): row is Record<string, unknown> => !Array.isArray(row),
    );
    const reportedFields = (result.fields ?? []).filter(
      (field) => typeof field.name === 'string' && field.name.length > 0,
    );
    const numericField = /(Usd|Price|Size|Notional|Pnl|Return|Percent|Ratio|Slippage|Fee|drawdown)/i;
    const oidFor = (name: string, value: unknown): number => {
      if (typeof value === 'boolean') return 16;
      if (typeof value === 'bigint') return 20;
      if (value instanceof Date) return 1114;
      if (value != null && typeof value === 'object') return 3802;
      if (numericField.test(name)) return 1700;
      if (typeof value === 'number') return 23;
      return 25;
    };
    const fields =
      reportedFields.length > 0
        ? reportedFields
        : Object.keys(firstObjectRow ?? {}).map((name) => ({
            name,
            dataTypeID: oidFor(name, firstObjectRow?.[name]),
          }));
    result.rows = result.rows.map((row) =>
      Array.isArray(row)
        ? row
        : fields.map((field) => {
            const value = row[field.name];
            return field.dataTypeID === 3802 && value != null ? JSON.stringify(value) : value;
          }),
    );
    Object.defineProperty(result, 'fields', {
      configurable: true,
      enumerable: true,
      value: fields,
    });
    return result;
  };
}

addArrayRowMode(memoryPool as unknown as QueryTarget);
const originalConnect = memoryPool.connect.bind(memoryPool);
memoryPool.connect = (async () => {
  const client = await originalConnect();
  addArrayRowMode(client as unknown as QueryTarget);
  return client;
}) as typeof memoryPool.connect;

const adapter = new PrismaPg(
  memoryPool as unknown as ConstructorParameters<typeof PrismaPg>[0],
);
const testPrisma = new PrismaClient({ adapter });

async function createLeaderTrade(input: {
  id: string;
  side: 'BUY' | 'SELL';
  amount: string;
  price: string;
  createdAt?: Date;
}) {
  return testPrisma.leaderTrade.create({
    data: {
      id: input.id,
      leaderAddress: '0x1111111111111111111111111111111111111111',
      txHash: `0x${input.id.padEnd(64, '0').slice(0, 64)}`,
      logIndex: Number(input.id.replace(/\D/g, '')) || 1,
      side: input.side,
      amount: input.amount,
      price: input.price,
      marketId: 'market-1',
      marketTitle: 'Will the integration test pass?',
      tokenId: 'token-yes',
      outcome: 'Yes',
      maker: '0x2222222222222222222222222222222222222222',
      taker: '0x1111111111111111111111111111111111111111',
      createdAt: input.createdAt,
      leaderId: 'leader-1',
    },
  });
}

async function main() {
  const { replacePrismaForIntegrationTest, pgPool } = await import('../db');
  replacePrismaForIntegrationTest(testPrisma);
  const { setVirtualCopyMarketDataAdaptersForTests } = await import('./virtualCopyMarketData');
  let askLevels = [
    { price: new Prisma.Decimal('0.51'), size: new Prisma.Decimal('60') },
    { price: new Prisma.Decimal('0.52'), size: new Prisma.Decimal('1000') },
  ];
  setVirtualCopyMarketDataAdaptersForTests({
    orderBookReader: {
      async read(tokenId) {
        return {
          tokenId,
          bids: [
            { price: new Prisma.Decimal('0.59'), size: new Prisma.Decimal('1000') },
          ],
          asks: askLevels,
          source: 'POLYMARKET_CLOB_PUBLIC_BOOK',
          observedAt: new Date(),
        };
      },
    },
    markPriceResolver: {
      async resolve(tokenId) {
        return {
          tokenId,
          price: new Prisma.Decimal('0.60'),
          source: 'POLYMARKET_CLOB_MIDPOINT',
          asOf: new Date(),
          stalenessMs: 0,
          status: 'FRESH',
        };
      },
    },
  });
  const {
    closeVirtualPositionManually,
    confirmVirtualPositionClose,
    dispatchVirtualCopyExecutions,
    previewVirtualPositionClose,
    replayPendingVirtualCopyExecutions,
  } = await import('./virtualCopyExecutionService');
  const { processVirtualAccountLifecycle } = await import('./virtualCopyLifecycle');
  const { processVirtualMarketSettlements } = await import('./virtualCopySettlement');
  const { setVirtualCopySettlementAdapterForTests } = await import(
    './virtualCopySettlementAdapter'
  );
  const { createVirtualAccount } = await import('./virtualAccountService');

  memory.public.none(`
    INSERT INTO "User" ("id") VALUES (1);
    INSERT INTO "CopyLeader" ("id", "address")
    VALUES ('leader-1', '0x1111111111111111111111111111111111111111');
  `);

  const accountInput = {
    userId: 1,
    name: '本地流程测试',
    initialBalanceUsd: '1000',
    effectiveDays: 1,
    idempotencyKey: 'local-flow-account-1',
  };
  const account = await createVirtualAccount(accountInput);
  assert.equal(
    (await createVirtualAccount(accountInput)).id,
    account.id,
    'account creation must be idempotent',
  );
  const subscription = await testPrisma.virtualCopySubscription.create({
    data: {
      userId: 1,
      accountId: account.id,
      leaderId: 'leader-1',
      copyMode: 'RATIO',
      copyRatio: '1',
      maxSlippage: '0.05',
      dailyTotalCapUsd: '500',
      maxAmountPerMarketUsd: '500',
      enabled: true,
      status: 'ACTIVE',
    },
  });

  const buy = await createLeaderTrade({
    id: 'trade-buy-1',
    side: 'BUY',
    amount: '100000000',
    price: '0.5',
  });
  assert.deepEqual(
    await replayPendingVirtualCopyExecutions(),
    { scanned: 1, created: 1, lastCreatedAt: buy.createdAt },
  );
  assert.equal(
    await dispatchVirtualCopyExecutions(buy.id),
    0,
    'leader trade replay must remain idempotent',
  );
  assert.deepEqual(
    await replayPendingVirtualCopyExecutions(),
    { scanned: 0, created: 0, lastCreatedAt: null },
    'durable replay checkpoint must advance past the processed signal',
  );

  const buyExecution = await testPrisma.virtualCopyExecution.findFirstOrThrow({
    where: { leaderTradeId: buy.id, subscriptionId: subscription.id },
  });
  assert.equal(
    buyExecution.status,
    'FILLED',
    `BUY execution failed: ${buyExecution.errorCode ?? ''} ${buyExecution.errorMessage ?? ''}`,
  );
  const boughtLot = await testPrisma.virtualPositionLot.findUniqueOrThrow({
    where: { buyExecutionId: buyExecution.id },
  });
  assert.equal(boughtLot.remainingSize.toString(), '100');
  assert.ok(boughtLot.entryPrice.gt('0.5'), 'BUY should apply adverse slippage');

  const afterBuy = await testPrisma.virtualCopyAccount.findUniqueOrThrow({
    where: { id: account.id },
  });
  assert.ok(afterBuy.cashBalanceUsd.lt('950'));

  const sell = await createLeaderTrade({
    id: 'trade-sell-2',
    side: 'SELL',
    amount: '40000000',
    price: '0.6',
  });
  assert.equal(await dispatchVirtualCopyExecutions(sell.id), 1);

  const afterSellLot = await testPrisma.virtualPositionLot.findUniqueOrThrow({
    where: { id: boughtLot.id },
  });
  assert.equal(afterSellLot.remainingSize.toString(), '60');
  const closeRows = await testPrisma.virtualPositionLotClose.findMany({
    where: { accountId: account.id },
  });
  assert.equal(closeRows.length, 1);
  assert.ok(closeRows[0]!.realizedPnlUsd.gt(0));

  await createLeaderTrade({
    id: 'trade-mark-3',
    side: 'BUY',
    amount: '1000000',
    price: '0.65',
    createdAt: new Date(),
  });
  const manualQuote = await previewVirtualPositionClose({
    userId: 1,
    accountId: account.id,
    tokenId: 'token-yes',
    size: '30',
    idempotencyKey: 'manual-close-preview-1',
  });
  assert.equal(manualQuote.estimatedFillSize.toString(), '30');
  const manualClose = await confirmVirtualPositionClose({
    userId: 1,
    accountId: account.id,
    tokenId: 'token-yes',
    quoteId: manualQuote.id,
    idempotencyKey: 'manual-close-confirm-1',
  });
  assert.equal(manualClose.executionIds.length, 1);
  assert.equal(manualClose.requestedSize, '30');
  assert.deepEqual(
    await confirmVirtualPositionClose({
      userId: 1,
      accountId: account.id,
      tokenId: 'token-yes',
      quoteId: manualQuote.id,
      idempotencyKey: 'manual-close-confirm-1',
    }),
    manualClose,
    'manual close confirmation must be idempotent',
  );
  assert.equal(
    (await testPrisma.virtualPositionLot.findUniqueOrThrow({ where: { id: boughtLot.id } }))
      .remainingSize.toString(),
    '30',
  );
  const manualExecution = await testPrisma.virtualCopyExecution.findUniqueOrThrow({
    where: { id: manualClose.executionIds[0] },
  });
  assert.equal(manualExecution.executionSource, 'MANUAL_CLOSE');
  assert.equal(manualExecution.priceSource, 'POLYMARKET_CLOB_PUBLIC_BOOK');
  assert.ok(
    (await testPrisma.virtualPositionLotClose.findMany({
      where: { sellExecutionId: manualExecution.id },
    })).every((row) => row.closeReason === 'MANUAL_CLOSE'),
  );
  await closeVirtualPositionManually({
    userId: 1,
    accountId: account.id,
    tokenId: 'token-yes',
  });
  assert.equal(
    await testPrisma.virtualPositionLot.count({
      where: { accountId: account.id, remainingSize: { gt: 0 } },
    }),
    0,
  );

  await testPrisma.virtualCopySubscription.update({
    where: { id: subscription.id },
    data: { maxAmountUsd: '50' },
  });
  const cashBeforeCappedBuy = (
    await testPrisma.virtualCopyAccount.findUniqueOrThrow({ where: { id: account.id } })
  ).cashBalanceUsd;
  const cappedBuy = await createLeaderTrade({
    id: 'trade-buy-cap-4',
    side: 'BUY',
    amount: '100000000',
    price: '0.5',
  });
  assert.equal(await dispatchVirtualCopyExecutions(cappedBuy.id), 1);
  const cappedExecution = await testPrisma.virtualCopyExecution.findFirstOrThrow({
    where: { leaderTradeId: cappedBuy.id, subscriptionId: subscription.id },
  });
  assert.equal(cappedExecution.status, 'SKIPPED');
  assert.equal(cappedExecution.errorCode, 'virtual_max_amount');
  assert.ok(
    (await testPrisma.virtualCopyAccount.findUniqueOrThrow({ where: { id: account.id } }))
      .cashBalanceUsd.eq(cashBeforeCappedBuy),
  );

  await testPrisma.virtualCopySubscription.update({
    where: { id: subscription.id },
    data: { maxAmountUsd: null },
  });
  askLevels = [{ price: new Prisma.Decimal('0.51'), size: new Prisma.Decimal('5') }];
  const partialBuy = await createLeaderTrade({
    id: 'trade-buy-partial-5',
    side: 'BUY',
    amount: '20000000',
    price: '0.5',
  });
  assert.equal(await dispatchVirtualCopyExecutions(partialBuy.id), 1);
  const partialExecution = await testPrisma.virtualCopyExecution.findFirstOrThrow({
    where: { leaderTradeId: partialBuy.id, subscriptionId: subscription.id },
  });
  assert.equal(partialExecution.status, 'PARTIALLY_FILLED');
  assert.equal(partialExecution.simulatedFillSize?.toString(), '5');
  askLevels = [
    { price: new Prisma.Decimal('0.51'), size: new Prisma.Decimal('60') },
    { price: new Prisma.Decimal('0.52'), size: new Prisma.Decimal('1000') },
  ];
  await closeVirtualPositionManually({
    userId: 1,
    accountId: account.id,
    tokenId: 'token-yes',
  });

  const finalAccount = await testPrisma.virtualCopyAccount.findUniqueOrThrow({
    where: { id: account.id },
  });
  assert.ok(finalAccount.cashBalanceUsd.gt(account.initialBalanceUsd));
  assert.ok(finalAccount.realizedPnlUsd.gt(0));
  assert.equal(
    await testPrisma.virtualAccountLedger.count({ where: { accountId: account.id } }),
    7,
  );

  await testPrisma.virtualCopyAccount.update({
    where: { id: account.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.deepEqual(await processVirtualAccountLifecycle(), { expired: 1, settled: 1 });
  assert.equal(
    (await testPrisma.virtualCopyAccount.findUniqueOrThrow({ where: { id: account.id } })).status,
    'SETTLED',
  );

  const settlementAccount = await createVirtualAccount({
    userId: 1,
    name: '链上结算测试',
    initialBalanceUsd: '100',
    effectiveDays: 1,
    idempotencyKey: 'settlement-account-1',
  });
  const settlementSubscription = await testPrisma.virtualCopySubscription.create({
    data: {
      userId: 1,
      accountId: settlementAccount.id,
      leaderId: 'leader-1',
      copyMode: 'RATIO',
      copyRatio: '1',
      enabled: true,
      status: 'ACTIVE',
    },
  });
  const createSettlementLot = async (params: {
    executionId: string;
    tokenId: string;
    size: string;
    entryPrice: string;
  }) => {
    await testPrisma.virtualCopyExecution.create({
      data: {
        id: params.executionId,
        userId: 1,
        accountId: settlementAccount.id,
        subscriptionId: settlementSubscription.id,
        leaderTradeId: null,
        leaderId: 'leader-1',
        leaderAddress: '0x1111111111111111111111111111111111111111',
        marketId: `market-${params.tokenId}`,
        tokenId: params.tokenId,
        side: 'BUY',
        status: 'FILLED',
        leaderPrice: params.entryPrice,
        targetSize: params.size,
        targetNotionalUsd: new Prisma.Decimal(params.size).mul(params.entryPrice),
        simulatedFillSize: params.size,
        simulatedAvgPrice: params.entryPrice,
        simulatedNotionalUsd: new Prisma.Decimal(params.size).mul(params.entryPrice),
        simulatedFeeUsd: '0',
        fillModel: 'TEST',
        priceSource: 'TEST',
        configSnapshot: {},
        scheduledAt: new Date(),
        filledAt: new Date(),
      },
    });
    await testPrisma.virtualPositionLot.create({
      data: {
        userId: 1,
        accountId: settlementAccount.id,
        subscriptionId: settlementSubscription.id,
        leaderId: 'leader-1',
        leaderAddress: '0x1111111111111111111111111111111111111111',
        marketId: `market-${params.tokenId}`,
        tokenId: params.tokenId,
        buyExecutionId: params.executionId,
        entryPrice: params.entryPrice,
        entrySize: params.size,
        remainingSize: params.size,
        entryNotionalUsd: new Prisma.Decimal(params.size).mul(params.entryPrice),
        entryFeeUsd: '0',
        openedAt: new Date(),
      },
    });
  };
  await createSettlementLot({
    executionId: 'settlement-buy-win',
    tokenId: 'token-win',
    size: '50',
    entryPrice: '0.6',
  });
  await createSettlementLot({
    executionId: 'settlement-buy-lose',
    tokenId: 'token-lose',
    size: '50',
    entryPrice: '1',
  });
  await createSettlementLot({
    executionId: 'settlement-buy-fraction',
    tokenId: 'token-fraction',
    size: '20',
    entryPrice: '0.4',
  });
  await testPrisma.virtualCopyAccount.update({
    where: { id: settlementAccount.id },
    data: {
      cashBalanceUsd: '12',
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  setVirtualCopySettlementAdapterForTests({
    async resolve(tokenId) {
      const win = tokenId === 'token-win';
      const lose = tokenId === 'token-lose';
      const fraction = tokenId === 'token-fraction';
      if (!win && !lose && !fraction) return null;
      const conditionId = `0x${(win ? '1' : lose ? '2' : '3').repeat(64)}` as `0x${string}`;
      return {
        tokenId,
        payoutNumerator: win ? 1n : fraction ? 1n : 0n,
        payoutDenominator: fraction ? 2n : 1n,
        evidence: {
          conditionId,
          outcomeIndex: win ? 0 : 1,
          denominator: fraction ? '2' : '1',
          numerator: win || fraction ? '1' : '0',
          blockNumber: '777',
          observedAt: new Date().toISOString(),
          source: 'POLYGON_CTF',
        },
      };
    },
  });
  assert.deepEqual(
    await processVirtualAccountLifecycle(new Date(), { settleMarkets: true }),
    { expired: 1, settled: 1 },
  );
  const settlementExecutions = await testPrisma.virtualCopyExecution.findMany({
    where: {
      accountId: settlementAccount.id,
      executionSource: 'MARKET_SETTLEMENT',
    },
    orderBy: { tokenId: 'asc' },
  });
  assert.equal(settlementExecutions.length, 3);
  assert.ok(settlementExecutions.every((row) => row.status === 'SETTLED'));
  assert.equal(
    settlementExecutions.find((row) => row.tokenId === 'token-win')?.simulatedAvgPrice?.toString(),
    '1',
  );
  assert.equal(
    settlementExecutions.find((row) => row.tokenId === 'token-lose')?.simulatedAvgPrice?.toString(),
    '0',
  );
  assert.equal(
    settlementExecutions.find((row) => row.tokenId === 'token-fraction')
      ?.simulatedAvgPrice?.toString(),
    '0.5',
  );
  const settlementCloses = await testPrisma.virtualPositionLotClose.findMany({
    where: { accountId: settlementAccount.id },
  });
  assert.equal(settlementCloses.length, 3);
  assert.ok(settlementCloses.every((row) => row.closeReason === 'MARKET_RESOLUTION'));
  assert.ok(settlementCloses.every((row) => {
    const evidence = row.settlementEvidence as Record<string, unknown>;
    return evidence.source === 'POLYGON_CTF' && evidence.blockNumber === '777';
  }));
  assert.equal(
    (await testPrisma.virtualCopyAccount.findUniqueOrThrow({
      where: { id: settlementAccount.id },
    })).cashBalanceUsd.toString(),
    '72',
  );
  assert.deepEqual(
    await processVirtualMarketSettlements(),
    { candidates: 0, settled: 0 },
    'market settlement must be idempotent after lifecycle completion',
  );
  assert.equal(
    await testPrisma.virtualAccountLedger.count({
      where: { accountId: settlementAccount.id, category: 'MARKET_SETTLEMENT' },
    }),
    3,
  );

  console.log('virtual copy integration flow passed');
  await testPrisma.$disconnect();
  await memoryPool.end();
  await pgPool.end();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
