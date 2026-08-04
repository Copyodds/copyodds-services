// 先于 Prisma 加载 .env（与 server 共用 loadEnv）
import './loadEnv';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from './generated/prisma/client';

const rawUrl = process.env.DATABASE_URL;
const connectionString =
  typeof rawUrl === 'string' ? rawUrl.trim() : '';

if (!connectionString) {
  throw new Error(
    '[db] DATABASE_URL is missing or empty. Add it to .env in the process cwd (e.g. deploy/deploy/.env). ' +
      'If using PM2, set cwd to that folder or use env_file / ecosystem.config.js.',
  );
}

/**
 * 并发 smart-money 抓取会并行打 DB；单连接 adapter 会触发 pg 并发 query 警告并卡死。
 *
 * 注意：该池是「每进程」的。backend / smart-money-worker / copy-worker 各自实例化，
 * 上限会按进程数叠加压向同一台 Postgres。小内存主机（2C2G）建议在 .env 显式设
 * DATABASE_POOL_MAX（如 backend 8 / worker 6），总和留出安全余量。
 */
const POOL_MAX = Math.max(4, Number(process.env.DATABASE_POOL_MAX ?? 10));

export const pgPool = new pg.Pool({
  connectionString,
  max: POOL_MAX,
});

/** 连接池水位；waiting > 0 表示查询正在排队等空闲连接 */
export function getPgPoolStats(): {
  max: number;
  total: number;
  idle: number;
  waiting: number;
} {
  return {
    max: POOL_MAX,
    total: pgPool.totalCount,
    idle: pgPool.idleCount,
    waiting: pgPool.waitingCount,
  };
}

const adapter = new PrismaPg(pgPool);

export let prisma = new PrismaClient({
  adapter,
  // Global defaults for every $transaction call. Under peak load (candidate
  // sync + light/deep batches sharing one pool) acquiring a connection can
  // queue well past Prisma's 2s default maxWait, which surfaced as
  // "Unable to start a transaction in the given time" across the pipeline.
  // Per-call options still override these.
  transactionOptions: {
    maxWait: 15_000,
    timeout: 60_000,
  },
});

/**
 * Allows isolated integration tests to swap in an in-memory PostgreSQL adapter.
 * Production code cannot call this hook.
 */
export function replacePrismaForIntegrationTest(client: PrismaClient): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Prisma replacement is only allowed when NODE_ENV=test');
  }
  prisma = client;
}
