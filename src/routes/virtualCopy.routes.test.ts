import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Prisma, type PrismaClient } from '../generated/prisma/client';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://virtual-route-test:virtual-route-test@127.0.0.1:1/test';
process.env.CUSTODY_TREASURY_ADDRESS = '0x0000000000000000000000000000000000000001';
process.env.JWT_SECRET = 'virtual-copy-route-test-secret';
process.env.COPY_INTERNAL_SECRET = 'virtual-copy-internal-test-secret';
process.env.VIRTUAL_COPY_ACCOUNTS_ENABLED = 'true';
process.env.VIRTUAL_COPY_ACTIVE_ACCOUNT_QUOTA = '1';

type JsonResponse = { status: number; body: Record<string, unknown>; headers: Headers };

async function main() {
  const { replacePrismaForIntegrationTest } = await import('../db');
  const { CONFIG } = await import('../config/env');
  const { SlidingWindowRateLimiter } = await import('../virtualCopyTrading/virtualCopyRateLimit');
  let capturedAccountWhere: unknown;
  let closeQuote: Record<string, unknown> | null = null;
  const now = new Date('2026-07-17T08:00:00.000Z');
  const accountRows = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']
    .map((id, index) => ({
      id,
      userId: 1,
      name: `route-account-${index}`,
      currency: 'USD',
      initialBalanceUsd: new Prisma.Decimal('1000'),
      cashBalanceUsd: new Prisma.Decimal('1000'),
      reservedBalanceUsd: new Prisma.Decimal(0),
      realizedPnlUsd: new Prisma.Decimal(0),
      status: 'ACTIVE',
      startedAt: new Date(now.getTime() - index * 1_000),
      expiresAt: new Date(now.getTime() + 86_400_000),
      expiredAt: null,
      settledAt: null,
      archivedAt: null,
      version: 0,
      createdAt: new Date(now.getTime() - index * 1_000),
      updatedAt: now,
      _count: { lots: 0, subscriptions: 0 },
      equitySnapshots: [],
    }));
  let adminAccount = { ...accountRows[0] };
  const auditRows: Array<Record<string, unknown>> = [];

  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{
      id: adminAccount.id,
      userId: adminAccount.userId,
      status: adminAccount.status,
      version: adminAccount.version,
      expiresAt: adminAccount.expiresAt,
      archivedAt: adminAccount.archivedAt,
    }],
    virtualAccountLedger: { findUnique: async () => null },
    virtualCopyAccount: {
      count: async () => 1,
      findUniqueOrThrow: async () => adminAccount,
      update: async ({ data }: { data: { status: string } }) => {
        adminAccount = {
          ...adminAccount,
          status: data.status,
          version: adminAccount.version + 1,
        };
        return adminAccount;
      },
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditRows.push(data);
        return data;
      },
    },
  };
  const mockPrisma = {
    userSession: {
      findUnique: async ({ where }: { where: { id: string } }) => where.id === 'session-1'
        ? { id: where.id, userId: 1, expiresAt: new Date(Date.now() + 60_000) }
        : null,
    },
    adminSession: {
      findFirst: async () => ({
        id: 'admin-session',
        adminUser: { id: 'admin-user-1', status: 'ACTIVE' },
      }),
      update: async () => ({}),
    },
    auditEvent: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        auditRows.find((row) =>
          row.requestId === where.requestId &&
          row.action === where.action &&
          row.targetType === where.targetType &&
          row.targetId === where.targetId) ?? null,
    },
    virtualCopyAccount: {
      findMany: async (args: { where: unknown }) => {
        capturedAccountWhere = args.where;
        return accountRows;
      },
      findFirst: async ({ where }: { where: { id: string; userId: number } }) =>
        where.id === accountRows[0].id && where.userId === 1 ? accountRows[0] : null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === adminAccount.id ? adminAccount : null,
    },
    virtualAccountLedger: { findUnique: async () => null },
    virtualPositionLot: {
      groupBy: async () => [],
      findMany: async () => [{
        id: 'close-lot-1',
        remainingSize: new Prisma.Decimal('5'),
        entryPrice: new Prisma.Decimal('0.4'),
        entryFeeUsd: new Prisma.Decimal('0.01'),
        openedAt: now,
      }],
    },
    virtualPositionCloseQuote: {
      findUnique: async () => closeQuote,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        closeQuote = {
          id: '30000000-0000-4000-8000-000000000003',
          status: 'ACTIVE',
          consumedAt: null,
          createdAt: now,
          ...data,
        };
        return closeQuote;
      },
    },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  replacePrismaForIntegrationTest(mockPrisma as unknown as PrismaClient);
  const { setVirtualCopyMarketDataAdaptersForTests } = await import(
    '../virtualCopyTrading/virtualCopyMarketData'
  );
  setVirtualCopyMarketDataAdaptersForTests({
    orderBookReader: {
      async read(tokenId) {
        return {
          tokenId,
          bids: [{ price: new Prisma.Decimal('0.6'), size: new Prisma.Decimal('100') }],
          asks: [{ price: new Prisma.Decimal('0.61'), size: new Prisma.Decimal('100') }],
          source: 'POLYMARKET_CLOB_PUBLIC_BOOK',
          observedAt: now,
        };
      },
    },
    markPriceResolver: {
      async resolve(tokenId) {
        return {
          tokenId,
          price: new Prisma.Decimal('0.6'),
          source: 'POLYMARKET_CLOB_MIDPOINT',
          asOf: now,
          stalenessMs: 0,
          status: 'FRESH',
        };
      },
    },
  });

  const { virtualCopyRouter } = await import('./virtualCopy');
  const { internalVirtualCopyAdminRouter } = await import('./internal/virtualCopyAdminCommand');
  const { internalSecretAuth } = await import('../middlewares/internalSecretAuth');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.requestId = req.header('x-request-id') ?? 'route-test-request';
    next();
  });
  app.use('/api/virtual-copy', virtualCopyRouter);
  app.use(
    '/api/internal/admin/virtual-copy',
    internalSecretAuth,
    internalVirtualCopyAdminRouter,
  );
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = jwt.sign(
    { userId: 1, username: 'route-test', jti: 'session-1' },
    process.env.JWT_SECRET!,
    { expiresIn: '5m' },
  );

  async function request(path: string, init: RequestInit = {}): Promise<JsonResponse> {
    const response = await fetch(`${baseUrl}${path}`, init);
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
      headers: response.headers,
    };
  }

  try {
    const unauthorized = await request('/api/virtual-copy/accounts');
    assert.equal(unauthorized.status, 401);

    CONFIG.virtualCopyAccountsEnabled = false;
    const disabled = await request('/api/virtual-copy/accounts', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(disabled.status, 404);
    assert.equal(disabled.body.code, 40421);
    CONFIG.virtualCopyAccountsEnabled = true;

    const firstPage = await request(
      '/api/virtual-copy/accounts?search=route&filter=ignored&status=ACTIVE' +
      '&leader=0x1111&hasPosition=false&from=2026-07-01&to=2026-07-31' +
      '&sort=createdAt&order=desc&limit=1',
      {
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'account-page-request',
        },
      },
    );
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.code, 0);
    assert.equal(firstPage.body.requestId, 'account-page-request');
    const firstData = firstPage.body.data as {
      items: unknown[];
      nextCursor: string | null;
      asOf: string;
    };
    assert.equal(firstData.items.length, 1);
    assert.ok(firstData.nextCursor);
    assert.ok(firstData.asOf);
    assert.match(JSON.stringify(capturedAccountWhere), /route/);
    assert.match(JSON.stringify(capturedAccountWhere), /subscriptions/);
    assert.match(JSON.stringify(capturedAccountWhere), /none/);

    const secondPage = await request(
      `/api/virtual-copy/accounts?search=route&sort=createdAt&order=desc&limit=1&cursor=${encodeURIComponent(firstData.nextCursor!)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(secondPage.status, 200);
    assert.match(JSON.stringify(capturedAccountWhere), /lt/);

    const ownership = await request(
      '/api/virtual-copy/accounts/20000000-0000-4000-8000-000000000002/positions',
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(ownership.status, 404);

    const closeValidation = await request(
      `/api/virtual-copy/accounts/${accountRows[0].id}/positions/token-yes/close-preview`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
    assert.equal(closeValidation.status, 400);

    const closeQuoteResponse = await request(
      `/api/virtual-copy/accounts/${accountRows[0].id}/positions/token-yes/close-preview`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          size: '2',
          idempotencyKey: 'close-preview-request-0001',
        }),
      },
    );
    assert.equal(closeQuoteResponse.status, 200);
    assert.equal(
      ((closeQuoteResponse.body.data as { quote: { estimatedFillSize: string } }).quote)
        .estimatedFillSize,
      '2',
    );

    const quota = await request('/api/virtual-copy/accounts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'quota-account',
        initialBalanceUsd: '1000',
        effectiveDays: 30,
        idempotencyKey: 'quota-request-0001',
      }),
    });
    assert.equal(quota.status, 409);
    assert.match(JSON.stringify(quota.body), /quota exceeded/i);

    const adminMissingSecret = await request(
      `/api/internal/admin/virtual-copy/accounts/${accountRows[0].id}/pause`,
      { method: 'POST' },
    );
    assert.equal(adminMissingSecret.status, 401);
    const adminMissingSession = await request(
      `/api/internal/admin/virtual-copy/accounts/${accountRows[0].id}/pause`,
      {
        method: 'POST',
        headers: { 'x-internal-secret': process.env.COPY_INTERNAL_SECRET! },
      },
    );
    assert.equal(adminMissingSession.status, 401);

    const adminHeaders = {
      'x-internal-secret': process.env.COPY_INTERNAL_SECRET!,
      authorization: 'Bearer admin-session.admin-secret',
      'content-type': 'application/json',
    };
    const adminPause = await request(
      `/api/internal/admin/virtual-copy/accounts/${accountRows[0].id}/pause`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          reason: 'route test pause',
          requestId: 'admin-pause-request-0001',
        }),
      },
    );
    assert.equal(adminPause.status, 200);
    assert.equal(adminAccount.status, 'PAUSED');
    assert.equal(auditRows.length, 1);
    assert.match(JSON.stringify(auditRows[0]?.metadata), /before/);
    assert.match(JSON.stringify(auditRows[0]?.metadata), /after/);
    const repeatedPause = await request(
      `/api/internal/admin/virtual-copy/accounts/${accountRows[0].id}/pause`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          reason: 'route test pause',
          requestId: 'admin-pause-request-0001',
        }),
      },
    );
    assert.equal(repeatedPause.status, 200);
    assert.equal(auditRows.length, 1);

    let clock = 1_000;
    const limiter = new SlidingWindowRateLimiter(() => clock);
    assert.equal(limiter.consume('user:1', 2, 1_000).allowed, true);
    assert.equal(limiter.consume('user:1', 2, 1_000).allowed, true);
    const limited = limiter.consume('user:1', 2, 1_000);
    assert.equal(limited.allowed, false);
    assert.equal(limited.retryAfterMs, 1_000);
    clock += 1_001;
    assert.equal(limiter.consume('user:1', 2, 1_000).allowed, true);

    console.log('virtualCopy.routes.test.ts: all assertions passed');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
