import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Prisma, type PrismaClient } from '../generated/prisma/client';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://copy-pnl-route:copy-pnl-route@127.0.0.1:1/test';
process.env.JWT_SECRET = 'copy-pnl-route-secret';
process.env.CUSTODY_TREASURY_ADDRESS = '0x0000000000000000000000000000000000000001';
process.env.COPY_INTERNAL_SECRET = 'copy-pnl-internal-secret';
process.env.COPY_PNL_DAY_TIMEZONE = 'Asia/Shanghai';
process.env.COPY_PNL_DAY_RESET_HOUR = '8';

async function main(): Promise<void> {
  await import('../loadEnv');
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://copy-pnl-route:copy-pnl-route@127.0.0.1:1/test';
  process.env.JWT_SECRET = 'copy-pnl-route-secret';
  process.env.CUSTODY_TREASURY_ADDRESS = '0x0000000000000000000000000000000000000001';
  process.env.COPY_INTERNAL_SECRET = 'copy-pnl-internal-secret';
  process.env.COPY_PNL_DAY_TIMEZONE = 'Asia/Shanghai';
  process.env.COPY_PNL_DAY_RESET_HOUR = '8';
  const { replacePrismaForIntegrationTest } = await import('../db');
  replacePrismaForIntegrationTest({
    userSession: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'copy-pnl-session'
          ? { id: where.id, userId: 7, expiresAt: new Date(Date.now() + 60_000) }
          : null,
    },
    userCopyPnlDaily: {
      findMany: async () => [{
        dayStartAt: new Date('2026-08-01T00:00:00.000Z'),
        realizedPnlUsd: new Prisma.Decimal('4.125'),
      }],
    },
    userDailyActivity: {
      upsert: async () => ({}),
    },
  } as unknown as PrismaClient);

  const { copyTradeRouter } = await import('./copyTrade');
  const app = express();
  app.use('/api/copy-trade', copyTradeRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const token = jwt.sign(
    { userId: 7, username: 'curve-test', jti: 'copy-pnl-session' },
    process.env.JWT_SECRET!,
    { expiresIn: '5m' }
  );
  const request = (path: string, authenticated = true) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: authenticated ? { authorization: `Bearer ${token}` } : {},
    });

  try {
    assert.equal((await request('/api/copy-trade/pnl-curve?days=2', false)).status, 401);
    assert.equal((await request('/api/copy-trade/pnl-curve?days=0')).status, 400);

    const response = await request('/api/copy-trade/pnl-curve?days=2');
    assert.equal(response.status, 200);
    const body = await response.json() as {
      code: number;
      data: {
        timezone: string;
        resetHour: number;
        points: Array<{ realizedPnlUsd: string }>;
      };
    };
    assert.equal(body.code, 0);
    assert.equal(body.data.timezone, 'Asia/Shanghai');
    assert.equal(body.data.resetHour, 8);
    assert.equal(body.data.points.length, 2);
    assert(body.data.points.some((point) => point.realizedPnlUsd === '4.125'));
    console.log('copyTradePnlCurve.routes.test.ts: ok');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main();
