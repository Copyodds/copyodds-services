// backend/server.ts - 后端提供 API 接口
// PM2 / node dist 时由 loadEnv 解析 .env 路径（避免 dotenv 误从 dist/src 找）
import './loadEnv';
import { randomUUID } from 'node:crypto';
import express, { type Request } from 'express';
import pinoHttp from 'pino-http';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { getEvents, getMarkets } from './services/polymarket/markets';
import { awaitEnvOutboundUrlValidation, CONFIG } from './config/env';
import { registerServerCrons } from './jobs/registerServerCrons';
import { walletRouter } from './routes/wallet';
import { authRouter } from './routes/auth';
import { tradeRouter } from './routes/trade';
import { gasPackageRouter } from './routes/gasPackage';
import { shareToXRouter } from './routes/shareToX';
import { ogSmartMoneyRouter, ogAtWalletRouter } from './routes/ogSmartMoney';
import { affiliateTierShopRouter } from './routes/affiliateTierShop';
import { polymarketRouter } from './routes/polymarket';
import { copyTradeRouter } from './routes/copyTrade';
import { virtualCopyRouter } from './routes/virtualCopy';
import { custodyRouter } from './routes/custody';
import { settingsRouter } from './routes/settings';
import { adminDashboardRouter } from './routes/adminDashboard';
import { postCustodyLedgerTopupWebhook } from './routes/custodyWebhook';
import { internalCopyTradeRouter } from './routes/internal/copyTradeLeaderSignal';
import { internalPolymarketRouter } from './routes/internal/polymarketCache';
import { internalCustodyFunderMonitorRouter } from './routes/internal/custodyFunderMonitor';
import { internalSmartMoneyBlockScanRouter } from './routes/internal/smartMoneyBlockScan';
import { internalSmartMoneyScoreRouter } from './routes/internal/smartMoneyScore';
import { internalSmartMoneyIngestRouter } from './routes/internal/smartMoneyIngest';
import { internalSmartMoneyPipelineStatsRouter } from './routes/internal/smartMoneyPipelineStats';
import { internalSmartMoneyTierConfigRouter } from './routes/internal/smartMoneyTierConfig';
import { internalSmartMoneyAnalyzeRouter } from './routes/internal/smartMoneyAnalyze';
import { internalVirtualCopyAdminRouter } from './routes/internal/virtualCopyAdminCommand';
import { virtualCopyObservabilityRouter } from './observability/virtualCopyMetricsRouter';
import { refreshSmartMoneyTierConfigCache } from './services/smartMoney/smartMoneyTierConfig';
import { errorHandler } from './middlewares/errorHandler';
import { internalSecretAuth } from './middlewares/internalSecretAuth';
import { success, fail, Code } from './utils/response';
import { pgPool, prisma } from './db';
import { logger } from './utils/logger';
import {
  getRobotControlNatsConnection,
  isRobotControlNatsEnabled,
} from './copyTrading/events/natsRobotControlClient';
import {
  startSmartMoneyAnalyzeQueue,
  stopSmartMoneyAnalyzeQueue,
} from './services/smartMoney/smartMoneyAnalyzeQueue';

const app = express();
let serverReady = false;
let shuttingDown = false;
let httpServer: ReturnType<typeof app.listen> | null = null;
let cronController: ReturnType<typeof registerServerCrons> | null = null;

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim();
  }
}

function isOriginAllowed(origin: string): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!CONFIG.corsAllowedOrigins.length) {
    return !isProduction();
  }
  return CONFIG.corsAllowedOrigins.some((allowedOriginRaw) => {
    const allowedOrigin = allowedOriginRaw.trim();
    if (!allowedOrigin) {
      return false;
    }
    if (allowedOrigin === normalizedOrigin) {
      return true;
    }
    const wildcardIndex = allowedOrigin.indexOf('*.');
    if (wildcardIndex === -1) {
      return false;
    }
    const prefix = allowedOrigin.slice(0, wildcardIndex);
    const suffix = allowedOrigin.slice(wildcardIndex + 1);
    return (
      normalizedOrigin.startsWith(prefix) &&
      normalizedOrigin.endsWith(suffix) &&
      normalizedOrigin.length > prefix.length + suffix.length
    );
  });
}

app.set('trust proxy', CONFIG.trustProxy);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use((req, res, next) => {
  const origin = req.header('origin');
  if (!origin) {
    next();
    return;
  }
  if (isOriginAllowed(origin)) {
    next();
    return;
  }
  fail(res, Code.FORBIDDEN, 'Origin not allowed', 403);
});

// 显式 CORS：跨域 POST JSON 会先发 OPTIONS；仅反代 /api 时也要带齐头，避免浏览器误报 CORS
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, isOriginAllowed(origin));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-KEY',
      'X-Internal-Secret',
      'X-Admin-Key',
      'X-Admin-Bootstrap-Key',
      'X-Custody-Payment-Secret',
      'X-Custody-Credit-Secret',
    ],
    maxAge: 86400,
  }),
);
app.use(express.json());
app.use(cookieParser());

app.use((req, res, next) => {
  const incomingRequestId = req.header('x-request-id');
  const requestId =
    typeof incomingRequestId === 'string' && incomingRequestId.trim()
      ? incomingRequestId.trim()
      : randomUUID();
  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

/** /api 访问日志（JSON）：含 reqId、method、url、statusCode、responseTime、ip 等 */
app.use(
  pinoHttp({
    logger,
    genReqId: (req, _res) => {
      const id = (req as Request).requestId;
      return typeof id === 'string' && id.trim() ? id : randomUUID();
    },
    customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'error' : 'info'),
    autoLogging: {
      ignore: (req) => {
        const path = (req as Request).originalUrl ?? req.url ?? '';
        return !path.startsWith('/api');
      },
    },
  }),
);

const healthPayload = { status: 'ok' as const };
app.get('/health', (_req, res) => {
  success(res, healthPayload);
});
// 仅把 /api 反代到 Node 时，用此地址探活（/health 可能打到前端）
app.get('/api/health', (_req, res) => {
  success(res, healthPayload);
});

async function handleReadyCheck(_req: express.Request, res: express.Response): Promise<void> {
  const checks: Record<string, 'ok' | 'error' | 'not_ready' | 'skipped'> = {
    server: serverReady && !shuttingDown ? 'ok' : 'not_ready',
    database: 'error',
    nats: 'skipped',
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }

  if (isRobotControlNatsEnabled()) {
    try {
      const nc = await getRobotControlNatsConnection();
      checks.nats = nc.isClosed() ? 'error' : 'ok';
    } catch {
      checks.nats = 'error';
    }
  }

  const ready =
    checks.server === 'ok' &&
    checks.database === 'ok' &&
    (checks.nats === 'ok' || checks.nats === 'skipped');
  const requestId = typeof res.locals?.requestId === 'string' ? res.locals.requestId : undefined;
  res.status(ready ? 200 : 503).json({
    code: ready ? Code.SUCCESS : Code.DEPENDENCY_UNAVAILABLE,
    data: {
      status: ready ? 'ready' : 'not_ready',
      checks,
      message: ready ? 'Service ready' : 'Service not ready',
    },
    ...(requestId ? { requestId } : {}),
  });
}

app.get('/health/ready', handleReadyCheck);
app.get('/api/health/ready', handleReadyCheck);

// 认证相关：注册、登录、当前用户（无需 API Key）
app.use('/api/auth', authRouter);
// 管理后台主 API 在 polymarket-admin-api（Go）；Dashboard 聚合接口也可由本服务提供（/api/admin/dashboard*，AdminSession 鉴权）。
app.use('/api/admin', adminDashboardRouter);

// 服务间跟单信号（消息服等）：X-Internal-Secret + COPY_INTERNAL_SECRET，不使用用户 JWT / 终端 API Key
app.use('/api/internal/copy-trade', internalSecretAuth, internalCopyTradeRouter);
app.use('/api/internal/smart-money', internalSecretAuth, internalSmartMoneyBlockScanRouter);
app.use('/api/internal/smart-money', internalSecretAuth, internalSmartMoneyScoreRouter);
app.use('/api/internal/smart-money', internalSecretAuth, internalSmartMoneyIngestRouter);
app.use('/api/internal/smart-money', internalSecretAuth, internalSmartMoneyPipelineStatsRouter);
app.use('/api/internal/smart-money', internalSecretAuth, internalSmartMoneyTierConfigRouter);
app.use('/api/internal/smart-money', internalSecretAuth, internalSmartMoneyAnalyzeRouter);
app.use('/api/internal/polymarket', internalSecretAuth, internalPolymarketRouter);
app.use('/api/internal/custody', internalSecretAuth, internalCustodyFunderMonitorRouter);
app.use(
  '/api/internal/virtual-copy/observability',
  internalSecretAuth,
  virtualCopyObservabilityRouter,
);
// 敏感模拟盘命令要求同时通过服务间 secret 与 AdminSession 鉴权。
app.use('/api/internal/admin/virtual-copy', internalSecretAuth, internalVirtualCopyAdminRouter);

/** 支付网关回调：无用户 JWT，仅用共享密钥（见 CUSTODY_PAYMENT_WEBHOOK_SECRET） */
app.post('/api/webhooks/custody-ledger-topup', postCustodyLedgerTopupWebhook);

// 用户写接口统一依赖 JWT/session；公开读接口仅依赖 CORS，不把浏览器可见 API key 作为主边界。
app.use('/api/wallet', walletRouter);
app.use('/api/custody', custodyRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/trade', tradeRouter);
app.use('/api/gas-packages', gasPackageRouter);
app.use('/api/share-to-x', shareToXRouter);
app.use('/api/og', ogSmartMoneyRouter);
app.use(ogAtWalletRouter);
app.use('/api/affiliate-tier-products', affiliateTierShopRouter);
app.use('/api/polymarket', polymarketRouter);
app.use('/api/copy-trade', copyTradeRouter);
app.use('/api/virtual-copy', virtualCopyRouter);

app.get('/api/markets', async (req, res, next) => {
  try {
    const closed = req.query.closed === 'false' ? false : undefined;
    const active = req.query.active === 'true' ? true : undefined;
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === 'string' && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : undefined;
    const list = await getMarkets({ closed, active, limit });
    success(res, { markets: list });
  } catch (err) {
    next(err);
  }
});

/** Gamma 事件列表（含子市场 clobTokenIds），供前端选 token 下单 */
app.get('/api/events', async (req, res, next) => {
  try {
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === 'string' && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : 120;
    const offsetRaw = req.query.offset;
    const offset =
      typeof offsetRaw === 'string' && /^\d+$/.test(offsetRaw) ? parseInt(offsetRaw, 10) : 0;
    const closed =
      req.query.closed === 'true' ? true : req.query.closed === 'false' ? false : false;
    const list = await getEvents({ limit, offset, closed });
    success(res, { events: list });
  } catch (err) {
    next(err);
  }
});

app.use(errorHandler);

// Express 会把 listen 回调用 once 同时绑到 error 与 listening；端口被占用时先触发 error，
// 仍会调用该回调但并未监听成功，进程会立刻因无活动句柄而退出。这里分开处理 listening / error。
void (async () => {
  await awaitEnvOutboundUrlValidation();

  httpServer = app.listen(CONFIG.port);
  cronController = registerServerCrons(httpServer);

  httpServer.on('listening', () => {
    serverReady = true;
    void startSmartMoneyAnalyzeQueue().catch((error) => {
      logger.error({ error, context: 'smart-money-analyze-queue' }, 'analyze queue startup failed');
    });
    void refreshSmartMoneyTierConfigCache(true).catch((error) => {
      logger.warn({ error, context: 'smart-money-tier-config' }, 'tier config preload failed');
    });
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        { err, port: CONFIG.port, context: 'listen' },
        `Port ${CONFIG.port} is already in use. Stop the other process or set PORT in .env to a free port.`,
      );
    } else {
      logger.error({ err, context: 'listen' }, 'Failed to listen');
    }
    process.exit(1);
  });
})().catch((err) => {
  logger.error({ err, context: 'startup' }, 'Server startup failed');
  process.exit(1);
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  serverReady = false;
  logger.warn({ signal, context: 'shutdown' }, 'shutdown started');
  cronController?.stop();
  stopSmartMoneyAnalyzeQueue();

  const forceExitTimer = setTimeout(() => {
    logger.error({ context: 'shutdown' }, 'shutdown timed out, forcing exit');
    process.exit(1);
  }, 30_000);
  forceExitTimer.unref();

  if (!httpServer) {
    await prisma.$disconnect();
    await pgPool.end().catch(() => undefined);
    clearTimeout(forceExitTimer);
    process.exit(0);
    return;
  }

  httpServer.close(async (closeError) => {
    if (closeError) {
      logger.error({ err: closeError, context: 'shutdown' }, 'http close failed');
    }

    await prisma.$disconnect();
    await pgPool.end().catch(() => undefined);
    clearTimeout(forceExitTimer);
    process.exit(closeError ? 1 : 0);
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});