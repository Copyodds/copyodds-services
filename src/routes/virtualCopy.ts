import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';
import { CONFIG } from '../config/env';
import { prisma } from '../db';
import {
  copyLeaderDisplayUpdateData,
  loadCopyLeaderDisplaySnapshot,
} from '../copyTrading/services/copyLeaderDisplaySnapshot';
import { jwtAuth } from '../middlewares/jwtAuth';
import { checkSmartMoneyCopyPoolSubscription } from '../services/smartMoney/smartMoneyCopyPoolSubscribeGate';
import { Code, fail, success } from '../utils/response';
import {
  archiveOwnedVirtualAccount,
  createVirtualAccount,
  getVirtualAccountSummary,
  moneyStrings,
  requireOwnedVirtualAccount,
  upsertVirtualSubscriptionWithQuota,
  VirtualCopyDomainError,
} from '../virtualCopyTrading/virtualAccountService';
import {
  getVirtualPerformance,
  listVirtualAccounts,
  listVirtualEquity,
  listVirtualExecutions,
  listVirtualLedger,
  listVirtualPositions,
  listVirtualSubscriptions,
  type VirtualCopyQuery,
} from '../virtualCopyTrading/virtualCopyQueryService';
import {
  enforceVirtualCopyRateLimit,
  VIRTUAL_COPY_RATE_POLICIES,
} from '../virtualCopyTrading/virtualCopyRateLimit';
import {
  confirmVirtualPositionClose,
  previewVirtualPositionClose,
} from '../virtualCopyTrading/virtualCopyExecutionService';

export const virtualCopyRouter = Router();
virtualCopyRouter.use(jwtAuth);
virtualCopyRouter.use((_req, res, next) => {
  if (!CONFIG.virtualCopyAccountsEnabled) {
    fail(res, Code.FEATURE_DISABLED, 'Virtual copy trading is disabled', 404);
    return;
  }
  next();
});
virtualCopyRouter.use((_req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (body && typeof body === 'object' && (body as { code?: unknown }).code === Code.SUCCESS) {
      const envelope = body as { data?: unknown };
      const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
        ? envelope.data as Record<string, unknown>
        : { value: envelope.data };
      return sendJson(moneyStrings({
        ...body as Record<string, unknown>,
        data: { ...data, asOf: data.asOf ?? new Date() },
      }));
    }
    return sendJson(body);
  }) as typeof res.json;
  next();
});

const amountString = z.union([z.string(), z.number()]).transform(String).refine((value) => {
  try { return new Prisma.Decimal(value).isPositive(); } catch { return false; }
}, 'Invalid positive decimal');
const nonNegativeAmountString = z.union([z.string(), z.number()]).transform(String).refine((value) => {
  try { return new Prisma.Decimal(value).gte(0); } catch { return false; }
}, 'Invalid non-negative decimal');
const optionalAmount = z.union([amountString, z.null()]).optional();
const idSchema = z.string().uuid();
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/).transform((v) => v.toLowerCase());
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
const listQuerySchema = pageSchema.extend({
  search: z.string().trim().max(200).optional(),
  keyword: z.string().trim().max(200).optional(),
  filter: z.string().trim().max(200).optional(),
  status: z.string().trim().max(50).optional(),
  side: z.enum(['BUY', 'SELL']).optional(),
  leader: z.string().trim().max(100).optional(),
  hasPosition: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  sort: z.string().trim().max(50).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  includeLots: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});

function userId(req: Request): number {
  return Number(req.user!.userId);
}

function listQuery(req: Request, defaultSort: string): VirtualCopyQuery {
  const parsed = listQuerySchema.parse(req.query);
  return {
    search: parsed.search ?? parsed.keyword ?? parsed.filter,
    status: parsed.status,
    side: parsed.side,
    leader: parsed.leader,
    hasPosition: parsed.hasPosition,
    from: parsed.from ?? parsed.startDate,
    to: parsed.to ?? parsed.endDate,
    sort: parsed.sort ?? defaultSort,
    order: parsed.order,
    cursor: parsed.cursor,
    limit: parsed.limit,
    includeLots: parsed.includeLots,
  };
}

function route(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) {
        fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
          details: error.flatten(),
        });
        return;
      }
      if (error instanceof VirtualCopyDomainError) {
        const code = error.code === 'NOT_FOUND' ? Code.NOT_FOUND
          : error.code === 'CONFLICT' ? Code.STATE_CONFLICT : Code.VALIDATION_FAILED;
        fail(res, code, error.message, error.httpStatus);
        return;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        fail(res, Code.CONFLICT, 'Virtual account or subscription already exists', 409);
        return;
      }
      next(error);
    }
  };
}

virtualCopyRouter.post('/accounts', route(async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(50),
    initialBalanceUsd: amountString.default('100000'),
    effectiveDays: z.coerce.number().int().min(1).max(365).default(30),
    idempotencyKey: z.string().trim().min(8).max(128),
  }).safeParse(req.body);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
    return;
  }
  const initial = new Prisma.Decimal(parsed.data.initialBalanceUsd);
  if (initial.lt(100) || initial.gt(100_000_000)) {
    fail(res, Code.VALIDATION_FAILED, 'Initial balance must be between 100 and 100000000', 400);
    return;
  }
  if (!await enforceVirtualCopyRateLimit(
    req,
    res,
    userId(req),
    VIRTUAL_COPY_RATE_POLICIES.accountCreate,
  )) return;
  const account = await createVirtualAccount({ userId: userId(req), ...parsed.data });
  const summary = await getVirtualAccountSummary(userId(req), account.id);
  success(res, moneyStrings({ account: summary }), 201);
}));

virtualCopyRouter.get('/accounts', route(async (req, res) => {
  success(res, moneyStrings(await listVirtualAccounts(userId(req), listQuery(req, 'createdAt'))));
}));

virtualCopyRouter.get('/accounts/:accountId', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  success(res, moneyStrings(await getVirtualAccountSummary(userId(req), accountId)));
}));

virtualCopyRouter.patch('/accounts/:accountId', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  await requireOwnedVirtualAccount(userId(req), accountId);
  const parsed = z.object({
    name: z.string().trim().min(1).max(50).optional(),
    status: z.enum(['ACTIVE', 'PAUSED']).optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400);
    return;
  }
  const current = await requireOwnedVirtualAccount(userId(req), accountId);
  if (parsed.data.status && current.status !== 'ACTIVE' && current.status !== 'PAUSED') {
    fail(res, Code.STATE_CONFLICT, 'This account status cannot be changed manually', 409);
    return;
  }
  if (parsed.data.status === 'ACTIVE' && current.expiresAt <= new Date()) {
    fail(res, Code.STATE_CONFLICT, 'Expired account cannot be resumed', 409);
    return;
  }
  const account = await prisma.virtualCopyAccount.update({
    where: { id: accountId },
    data: {
      ...parsed.data,
      version: { increment: 1 },
      ...(parsed.data.status === 'PAUSED' ? {} : {}),
    },
  });
  success(res, moneyStrings({ account }));
}));

virtualCopyRouter.post('/accounts/:accountId/archive', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  const account = await archiveOwnedVirtualAccount(userId(req), accountId);
  success(res, moneyStrings({ account }));
}));

const subscriptionBody = z.object({
  accountId: idSchema,
  leaderAddress: addressSchema,
  ruleName: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  copyMode: z.enum(['RATIO', 'FIXED_AMOUNT']).default('RATIO'),
  copyRatio: z.union([amountString, z.null()]).default('1'),
  fixedAmountUsd: optionalAmount,
  minNotionalMode: z.enum(['BUMP_TO_MIN', 'SKIP']).default('BUMP_TO_MIN'),
  minAmountUsd: optionalAmount,
  maxAmountUsd: optionalAmount,
  maxAmountPerMarketUsd: optionalAmount,
  dailyTotalCapUsd: optionalAmount,
  maxSlippage: z.union([nonNegativeAmountString, z.null()]).optional(),
  delayMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
  marketCooldownMinutes: z.coerce.number().int().min(0).max(10_080).nullable().optional(),
  pauseAfterConsecutiveFails: z.coerce.number().int().min(1).max(100).nullable().optional(),
  skipBuyIfOpenPosition: z.boolean().default(true),
  onlyBuy: z.boolean().default(false),
  onlySell: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

virtualCopyRouter.post('/subscriptions', route(async (req, res) => {
  const parsed = subscriptionBody.safeParse(req.body);
  if (!parsed.success || (parsed.success && parsed.data.onlyBuy && parsed.data.onlySell)) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.success ? { onlyBuy: 'onlyBuy and onlySell are mutually exclusive' } : parsed.error.flatten(),
    });
    return;
  }
  if (!await enforceVirtualCopyRateLimit(
    req,
    res,
    userId(req),
    VIRTUAL_COPY_RATE_POLICIES.subscriptionWrite,
  )) return;
  const data = parsed.data;
  const account = await requireOwnedVirtualAccount(userId(req), data.accountId);
  if (account.status !== 'ACTIVE' || account.expiresAt <= new Date()) {
    fail(res, Code.STATE_CONFLICT, 'Account is not active', 409);
    return;
  }
  if (data.enabled) {
    const copyPoolCheck = await checkSmartMoneyCopyPoolSubscription(data.leaderAddress);
    if (!copyPoolCheck.allowed) {
      fail(res, Code.STATE_CONFLICT, '该地址不在聪明钱跟单榜内，暂不支持订阅', 409, {
        reasonCode: copyPoolCheck.warningCode,
        inCopyPool: copyPoolCheck.inCopyPool,
      });
      return;
    }
  }
  // CopyPool membership is the subscription gate. A ranked wallet may not yet
  // have a CopyLeader row, so keep this in sync just like the real-copy flow.
  const displaySnapshot = await loadCopyLeaderDisplaySnapshot(data.leaderAddress);
  const displayUpdate = displaySnapshot
    ? copyLeaderDisplayUpdateData(displaySnapshot)
    : {};
  const leader = await prisma.copyLeader.upsert({
    where: { address: data.leaderAddress },
    create: {
      address: data.leaderAddress,
      enabled: true,
      displayName: displaySnapshot?.displayName ?? null,
      xUsername: displaySnapshot?.xUsername ?? null,
      tier: displaySnapshot?.tier ?? null,
    },
    update: { enabled: true, status: 'ACTIVE', ...displayUpdate },
  });
  if (data.copyMode === 'FIXED_AMOUNT' && data.fixedAmountUsd == null) {
    fail(res, Code.VALIDATION_FAILED, 'fixedAmountUsd is required for FIXED_AMOUNT', 400);
    return;
  }
  if (data.maxSlippage != null && new Prisma.Decimal(data.maxSlippage).gt('0.5')) {
    fail(res, Code.VALIDATION_FAILED, 'maxSlippage must be <= 0.5', 400);
    return;
  }
  if (
    data.minAmountUsd != null &&
    data.maxAmountUsd != null &&
    new Prisma.Decimal(data.minAmountUsd).gt(data.maxAmountUsd)
  ) {
    fail(res, Code.VALIDATION_FAILED, 'minAmountUsd must be no more than maxAmountUsd', 400);
    return;
  }
  if (data.copyMode === 'RATIO' && (data.copyRatio == null || new Prisma.Decimal(data.copyRatio).gt(1))) {
    fail(res, Code.VALIDATION_FAILED, 'copyRatio must be greater than 0 and no more than 1', 400);
    return;
  }
  const { leaderAddress: _address, ...rawValues } = data;
  const values = {
    ...rawValues,
    copyRatio: data.copyMode === 'RATIO' && data.copyRatio != null ? data.copyRatio : '1',
    fixedAmountUsd: data.copyMode === 'FIXED_AMOUNT' ? data.fixedAmountUsd : null,
  };
  const subscription = await upsertVirtualSubscriptionWithQuota({
    userId: userId(req),
    accountId: data.accountId,
    leaderId: leader.id,
    enabled: data.enabled,
    createData: { ...values, userId: userId(req), leaderId: leader.id, status: 'ACTIVE' },
    updateData: { ...values, userId: userId(req), status: 'ACTIVE', deletedAt: null, pausedAt: null },
  });
  success(res, moneyStrings({ subscription }), 201);
}));

async function listSubscriptions(req: Request, res: Response, forcedAccountId?: string) {
  const parsedAccountId = idSchema.safeParse(forcedAccountId ?? req.query.accountId);
  if (!parsedAccountId.success) {
    fail(res, Code.VALIDATION_FAILED, 'accountId is required', 400);
    return;
  }
  const result = await listVirtualSubscriptions(
    userId(req),
    parsedAccountId.data,
    listQuery(req, 'createdAt'),
  );
  success(res, moneyStrings(result));
}

virtualCopyRouter.get('/subscriptions', route((req, res) => listSubscriptions(req, res)));
virtualCopyRouter.get('/accounts/:accountId/subscriptions', route((req, res) =>
  listSubscriptions(req, res, idSchema.parse(req.params.accountId))));

async function requireOwnedSubscription(req: Request, id: string) {
  const subscription = await prisma.virtualCopySubscription.findFirst({
    where: { id, userId: userId(req) },
    include: { account: true, leader: true },
  });
  if (!subscription || subscription.account.userId !== userId(req)) {
    throw new VirtualCopyDomainError('Virtual subscription not found', 404, 'NOT_FOUND');
  }
  return subscription;
}

virtualCopyRouter.patch('/subscriptions/:id', route(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const current = await requireOwnedSubscription(req, id);
  if (current.deletedAt || current.status === 'CANCELLED' || current.status === 'EXPIRED') {
    fail(res, Code.STATE_CONFLICT, 'Inactive subscription cannot be edited', 409);
    return;
  }
  const parsed = subscriptionBody
    .omit({ accountId: true, leaderAddress: true, enabled: true })
    .partial()
    .safeParse(req.body);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
    return;
  }
  const effectiveOnlyBuy = parsed.data.onlyBuy ?? current.onlyBuy;
  const effectiveOnlySell = parsed.data.onlySell ?? current.onlySell;
  if (effectiveOnlyBuy && effectiveOnlySell) {
    fail(res, Code.VALIDATION_FAILED, 'onlyBuy and onlySell are mutually exclusive', 400);
    return;
  }
  const effectiveMode = parsed.data.copyMode ?? current.copyMode;
  const effectiveRatio = parsed.data.copyRatio ?? current.copyRatio;
  const effectiveFixedAmount =
    parsed.data.fixedAmountUsd === undefined ? current.fixedAmountUsd : parsed.data.fixedAmountUsd;
  const effectiveMinAmount =
    parsed.data.minAmountUsd === undefined ? current.minAmountUsd : parsed.data.minAmountUsd;
  const effectiveMaxAmount =
    parsed.data.maxAmountUsd === undefined ? current.maxAmountUsd : parsed.data.maxAmountUsd;
  const effectiveMaxSlippage =
    parsed.data.maxSlippage === undefined ? current.maxSlippage : parsed.data.maxSlippage;
  if (effectiveMode === 'RATIO' && new Prisma.Decimal(effectiveRatio).gt(1)) {
    fail(res, Code.VALIDATION_FAILED, 'copyRatio must be no more than 1', 400);
    return;
  }
  if (effectiveMode === 'FIXED_AMOUNT' && effectiveFixedAmount == null) {
    fail(res, Code.VALIDATION_FAILED, 'fixedAmountUsd is required for FIXED_AMOUNT', 400);
    return;
  }
  if (effectiveMaxSlippage != null && new Prisma.Decimal(effectiveMaxSlippage).gt('0.5')) {
    fail(res, Code.VALIDATION_FAILED, 'maxSlippage must be <= 0.5', 400);
    return;
  }
  if (
    effectiveMinAmount != null &&
    effectiveMaxAmount != null &&
    new Prisma.Decimal(effectiveMinAmount).gt(effectiveMaxAmount)
  ) {
    fail(res, Code.VALIDATION_FAILED, 'minAmountUsd must be no more than maxAmountUsd', 400);
    return;
  }
  const { copyRatio, ...patch } = parsed.data;
  const subscription = await prisma.virtualCopySubscription.update({
    where: { id },
    data: {
      ...patch,
      ...(copyRatio != null ? { copyRatio } : {}),
      ...(parsed.data.copyMode === 'FIXED_AMOUNT' ? { copyRatio: '1' } : {}),
      ...(parsed.data.copyMode === 'RATIO' ? { fixedAmountUsd: null } : {}),
    },
  });
  success(res, moneyStrings({ subscription }));
}));

for (const action of ['pause', 'resume'] as const) {
  virtualCopyRouter.post(`/subscriptions/:id/${action}`, route(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const current = await requireOwnedSubscription(req, id);
    if (action === 'resume' && (current.account.status !== 'ACTIVE' || current.account.expiresAt <= new Date())) {
      fail(res, Code.STATE_CONFLICT, 'Account is not active', 409);
      return;
    }
    if (action === 'resume') {
      const copyPoolCheck = await checkSmartMoneyCopyPoolSubscription(current.leader.address);
      if (!copyPoolCheck.allowed) {
        fail(res, Code.STATE_CONFLICT, '该地址不在聪明钱跟单榜内，暂不支持订阅', 409, {
          reasonCode: copyPoolCheck.warningCode,
          inCopyPool: copyPoolCheck.inCopyPool,
        });
        return;
      }
    }
    const subscription = await prisma.virtualCopySubscription.update({
      where: { id },
      data: action === 'pause'
        ? { enabled: false, status: 'PAUSED', pausedAt: new Date(), pauseReason: 'USER' }
        : { enabled: true, status: 'ACTIVE', pausedAt: null, pauseReason: null },
    });
    success(res, moneyStrings({ subscription }));
  }));
}

virtualCopyRouter.delete('/subscriptions/:id', route(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await requireOwnedSubscription(req, id);
  const subscription = await prisma.virtualCopySubscription.update({
    where: { id },
    data: { enabled: false, status: 'CANCELLED', deletedAt: new Date() },
  });
  success(res, moneyStrings({ subscription }));
}));

virtualCopyRouter.get('/accounts/:accountId/dashboard', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  const summary = await getVirtualAccountSummary(userId(req), accountId);
  const query = listQuery(req, 'createdAt');
  const executionPage = await listVirtualExecutions(userId(req), accountId, {
    ...query,
    limit: Math.min(query.limit, 20),
  });
  const executionCountToday = await prisma.virtualCopyExecution.count({
    where: {
      accountId,
      userId: userId(req),
      createdAt: { gte: query.from ?? new Date(new Date().setUTCHours(0, 0, 0, 0)) },
      ...(query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.side ? { side: query.side } : {}),
      ...(query.leader ? {
        leaderAddress: { contains: query.leader, mode: 'insensitive' },
      } : {}),
    },
  });
  success(res, moneyStrings({
    accountSummary: summary,
    riskSummary: { openLots: summary.openLots, cashBalanceUsd: summary.cashBalanceUsd },
    subscriptionSummary: { active: summary.activeSubscriptionCount },
    latestExecutions: executionPage.items,
    nextCursor: executionPage.nextCursor,
    executionCountToday,
    priceHealth: { status: summary.priceStatus, priceAsOf: summary.priceAsOf },
    asOf: new Date(),
  }));
}));

virtualCopyRouter.get('/accounts/:accountId/positions', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  success(res, moneyStrings(
    await listVirtualPositions(userId(req), accountId, listQuery(req, 'tokenId')),
  ));
}));

virtualCopyRouter.get(
  '/accounts/:accountId/subscriptions/:subscriptionId/positions',
  route(async (req, res) => {
    const accountId = idSchema.parse(req.params.accountId);
    const subscriptionId = idSchema.parse(req.params.subscriptionId);
    const subscription = await requireOwnedSubscription(req, subscriptionId);
    if (subscription.accountId !== accountId) {
      throw new VirtualCopyDomainError('Virtual subscription not found', 404, 'NOT_FOUND');
    }
    success(res, moneyStrings(
      await listVirtualPositions(
        userId(req),
        accountId,
        listQuery(req, 'tokenId'),
        subscriptionId,
      ),
    ));
  }),
);

virtualCopyRouter.post('/accounts/:accountId/positions/:tokenId/close-preview', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  const parsed = z.object({
    size: amountString.optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
  }).strict().safeParse(req.body ?? {});
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
    return;
  }
  if (!await enforceVirtualCopyRateLimit(
    req,
    res,
    userId(req),
    VIRTUAL_COPY_RATE_POLICIES.close,
  )) return;
  const quote = await previewVirtualPositionClose({
    userId: userId(req),
    accountId,
    tokenId: Array.isArray(req.params.tokenId) ? req.params.tokenId[0] : req.params.tokenId,
    size: parsed.data.size,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  success(res, moneyStrings({ quote }));
}));

virtualCopyRouter.post('/accounts/:accountId/positions/:tokenId/close', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  const parsed = z.object({
    quoteId: idSchema,
    idempotencyKey: z.string().trim().min(8).max(128),
  }).strict().safeParse(req.body ?? {});
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, { details: parsed.error.flatten() });
    return;
  }
  if (!await enforceVirtualCopyRateLimit(
    req,
    res,
    userId(req),
    VIRTUAL_COPY_RATE_POLICIES.close,
  )) return;
  const result = await confirmVirtualPositionClose({
    userId: userId(req),
    accountId,
    tokenId: Array.isArray(req.params.tokenId) ? req.params.tokenId[0] : req.params.tokenId,
    quoteId: parsed.data.quoteId,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  success(res, result, 202);
}));

virtualCopyRouter.get('/accounts/:accountId/executions', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  const page = await listVirtualExecutions(userId(req), accountId, listQuery(req, 'createdAt'));
  const items = page.items.map((row) => ({
    id: row.id,
    subscriptionId: row.subscriptionId,
    leaderAddress: row.leaderAddress,
    marketTitle: row.marketTitle ?? row.marketId ?? row.tokenId,
    outcome: row.outcome ?? '',
    side: row.side,
    leaderPrice: row.leaderPrice,
    targetSize: row.targetSize,
    filledSize: row.simulatedFillSize,
    averagePrice: row.simulatedAvgPrice,
    notionalUsd: row.simulatedNotionalUsd,
    slippageBps: row.slippageBps,
    feeUsd: row.simulatedFeeUsd,
    fillModel: row.fillModel,
    priceSource: row.priceSource,
    status: row.status,
    reason: row.errorMessage,
    executedAt: row.filledAt,
    createdAt: row.createdAt,
  }));
  success(res, moneyStrings({ ...page, items }));
}));

virtualCopyRouter.get('/executions/:executionId', route(async (req, res) => {
  const execution = await prisma.virtualCopyExecution.findFirst({
    where: { id: idSchema.parse(req.params.executionId), userId: userId(req), account: { userId: userId(req) } },
  });
  if (!execution) throw new VirtualCopyDomainError('Virtual execution not found', 404, 'NOT_FOUND');
  success(res, moneyStrings({ execution }));
}));

virtualCopyRouter.get('/accounts/:accountId/ledger', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  const page = await listVirtualLedger(userId(req), accountId, listQuery(req, 'occurredAt'));
  const items = page.items.map((row) => ({
    id: row.id,
    type: row.category,
    direction: row.direction,
    amountUsd: row.direction === 'DEBIT' ? row.amountUsd.negated() : row.amountUsd,
    balanceAfterUsd: row.balanceAfterUsd,
    description: row.refType && row.refId ? `${row.refType} ${row.refId}` : null,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  }));
  success(res, moneyStrings({ ...page, items }));
}));

virtualCopyRouter.get('/accounts/:accountId/equity-curve', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  const page = await listVirtualEquity(userId(req), accountId, listQuery(req, 'snapshotAt'));
  const items = page.items.map((row) => ({
    id: row.id,
    ts: row.snapshotAt,
    equityUsd: row.equityUsd,
    cashBalanceUsd: row.cashBalanceUsd,
    positionValueUsd: row.positionValueUsd,
    realizedPnlUsd: row.realizedPnlUsd,
    unrealizedPnlUsd: row.unrealizedPnlUsd,
    totalPnlUsd: row.totalPnlUsd,
    totalReturn: row.totalReturn,
    drawdownPercent: row.drawdownPercent,
  }));
  success(res, moneyStrings({
    asOf: page.asOf,
    items,
    points: items,
    nextCursor: page.nextCursor,
  }));
}));

virtualCopyRouter.get('/accounts/:accountId/performance', route(async (req, res) => {
  const accountId = idSchema.parse(req.params.accountId);
  success(res, moneyStrings(
    await getVirtualPerformance(userId(req), accountId, listQuery(req, 'snapshotAt')),
  ));
}));
