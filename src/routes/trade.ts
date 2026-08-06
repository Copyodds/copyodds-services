import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Code, success, fail } from '../utils/response';
import { jwtAuth } from '../middlewares/jwtAuth';
import { requireUserTradePermission } from '../middlewares/requireUserTradePermission';
import { apiKeyAuth } from '../middlewares/apiKeyAuth';
import {
  createAndPostOrder,
  cancelOrder,
  getOpenOrders,
  getTrades,
  createAndPostOrderForUser,
  getOpenOrdersForUser,
  getTradesForUser,
  cancelOrderForUser,
  getClobOrderFillSummary,
} from '../services/polymarket/polymarketClob';
import {
  fetchDataApiPositions,
  fetchDataApiPositionsForWalletPair,
  type DataApiPosition,
} from '../services/polymarket/polymarketData';
import {
  isActiveValuedApiPosition,
  partitionUserDisplayPositions,
} from '../services/polymarket/positionVisibility';
import {
  buildUserPositionsSummary,
  countPendingSettlementPositions,
  enrichDisplayPositionWithSettlementLite,
} from '../services/polymarket/unifiedUserPositions';
import { getExecutionWalletForUser } from '../services/polymarket/automationSession';
import { redeemIfLoggedOrSkip } from '../services/polymarket/polymarketRedeem';
import {
  markUserPositionScanActiveBestEffort,
} from '../services/polymarket/positionScanState';
import { isTradingGuardError } from '../services/trading/tradingGuard';
import { CONFIG } from '../config/env';
import { prisma } from '../db';
import { Prisma } from '../generated/prisma/client';
import { createAppError, createConflictError, isAppError } from '../utils/appError';
import { logApiRouteMetrics, startApiRouteMetrics } from '../utils/apiRouteMetrics';
import {
  consumeOpenCopyLotsForManualSell,
  buildClosedLotDisplayFallbackForPositions,
  getOpenCopyLotsByTokenForUser,
  loadOpenCopyLotTokenKeysForUser,
  countOpenCopyLotsForUser,
  COPY_LOT_DUST_SHARES,
  getOpenCopyLotSizeForUserToken,
  type OpenCopyLotDto,
} from '../copyTrading/services/copyPositionLots';
import { autoSettleExpiredWorthlessPositions } from '../copyTrading/services/copyExpiredWorthlessSettlement';
import { syncCopyTradingCollateralFundingState } from '../copyTrading/services/copyFundingMonitor';
import {
  recordResolvedRedeemExecutionIfMissing,
  reconcileUnsettledOpenCopyLotsForUser,
} from '../copyTrading/services/copyRedeemSettlement';
import {
  assertSufficientGasForManualRedeem,
  deductGasForManualRedeem,
  resolveManualRedeemNotionalUsd,
} from '../services/gas/gas';
import { computeOrderGasCost } from '../config/gas';

const router = Router();
const TRADING_PREREQUISITES_HINT =
  'Complete prerequisites: open custodial wallet (POST /api/custody/open), fund it on-chain, then authorize Polymarket.';
const POSITIONS_PREFLIGHT_SETTLE_CACHE_MS = 60_000;
/** Min Polymarket position size (shares) to fetch; avoids multi-MB dust payloads. */
const POSITIONS_DISPLAY_SIZE_THRESHOLD = 1;
const POSITIONS_DATA_API_LIMIT = 100;
const POSITIONS_LIST_DEFAULT_LIMIT = 20;
const POSITIONS_LIST_MAX_LIMIT = 50;
const POSITIONS_DUST_DEFAULT_LIMIT = 20;
const POSITIONS_DUST_MAX_LIMIT = 50;

function parsePositiveIntQuery(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositionsListQuery(req: Request): {
  limit: number;
  offset: number;
  dustLimit: number;
  dustOffset: number;
} {
  const limit = Math.min(
    POSITIONS_LIST_MAX_LIMIT,
    Math.max(1, parsePositiveIntQuery(req.query.limit, POSITIONS_LIST_DEFAULT_LIMIT))
  );
  const offset = Math.max(0, parsePositiveIntQuery(req.query.offset, 0));
  const dustLimit = Math.min(
    POSITIONS_DUST_MAX_LIMIT,
    Math.max(1, parsePositiveIntQuery(req.query.dustLimit, POSITIONS_DUST_DEFAULT_LIMIT))
  );
  const dustOffset = Math.max(0, parsePositiveIntQuery(req.query.dustOffset, 0));
  return { limit, offset, dustLimit, dustOffset };
}

async function fetchUserPositionsRawFromPolymarket(params: {
  custodial: string;
  deposit: string;
  queryAddress?: string;
}): Promise<DataApiPosition[]> {
  const options = {
    sizeThreshold: POSITIONS_DISPLAY_SIZE_THRESHOLD,
    limit: POSITIONS_DATA_API_LIMIT,
  };
  const custodial = params.custodial.trim();
  const deposit = params.deposit.trim();
  const query = params.queryAddress?.trim();
  if (query) {
    const qLower = query.toLowerCase();
    if (
      qLower === custodial.toLowerCase() ||
      (deposit && qLower === deposit.toLowerCase())
    ) {
      return fetchDataApiPositions(query, options);
    }
  }
  return fetchDataApiPositionsForWalletPair({ custodial, deposit }, options);
}
const positionsPreflightSettleAtByUser = new Map<number, number>();
const positionsPreflightSettleInFlightByUser = new Set<number>();

function isTradingPrerequisiteMessage(message: string): boolean {
  return (
    message.includes('custodial') ||
    message.includes('Custodial') ||
    message.includes('Signed address') ||
    message.includes('Wallet')
  );
}

function scheduleUserPositionsPreflightSettle(userId: number, positions: DataApiPosition[]): void {
  const now = Date.now();
  const last = positionsPreflightSettleAtByUser.get(userId) ?? 0;
  if (
    now - last < POSITIONS_PREFLIGHT_SETTLE_CACHE_MS ||
    positionsPreflightSettleInFlightByUser.has(userId)
  ) {
    return;
  }
  positionsPreflightSettleAtByUser.set(userId, now);
  positionsPreflightSettleInFlightByUser.add(userId);
  void autoSettleExpiredWorthlessPositions(userId, positions)
    .catch((e) => {
      console.warn('[trade] auto-settle expired worthless failed', {
        userId,
        error: e instanceof Error ? e.message : String(e),
      });
    })
    .finally(() => {
      positionsPreflightSettleInFlightByUser.delete(userId);
    });
}

function toTradingRouteError(error: unknown) {
  if (isAppError(error)) {
    return error;
  }

  if (isTradingGuardError(error)) {
    return createAppError({
      code: Code.TRADING_BLOCKED,
      httpStatus: 403,
      message: error.message,
      details: {
        reasonCode: error.decision.reasonCode,
        thresholdSnapshot: error.decision.thresholdSnapshot ?? undefined,
      },
    });
  }

  /**
   * Polymarket CLOB client errors.
   * The @polymarket/clob-client-v2 throws ApiError with shape:
   * { name: 'ApiError', status: number, data?: { error?: string, status?: number } }
   *
   * If we don't map these to an exposed AppError, the global errorHandler will
   * mask them as 500 "Internal server error", making debugging and UX painful.
   */
  const apiErr = error as any;
  const apiStatus: unknown = apiErr?.status;
  const apiName: unknown = apiErr?.name;
  const apiData: any = apiErr?.data;
  if (apiName === 'ApiError' && typeof apiStatus === 'number') {
    const upstreamMessage =
      (typeof apiData?.error === 'string' && apiData.error.trim()) ||
      (error instanceof Error ? error.message : String(error));

    // Treat 4xx as user/actionable (bad request). Treat 5xx as dependency error.
    const isClient = apiStatus >= 400 && apiStatus < 500;
    const details: Record<string, unknown> = {
      upstream: 'polymarket-clob',
      upstreamStatus: apiStatus,
    };
    if (/deposit wallet flow/i.test(upstreamMessage)) {
      details.hint =
        '托管用户请先完成 POST /api/custody/open 或 /api/custody/authorize-polymarket（会自动推导并写入 deposit wallet 作为 funder）。若仍失败可手动 PUT /api/polymarket/wallet/funder。文档：https://docs.polymarket.com/developers/CLOB/introduction#signature-types';
    }
    if (
      /not enough balance \/ allowance/i.test(upstreamMessage) &&
      /balance:\s*0/i.test(upstreamMessage)
    ) {
      details.hint =
        'BUY：买单需要 Polymarket 保证金地址上有可用的 USDC（Polygon）。请向该地址充值 USDC；服务端会自动完成入账与 CLOB 侧准备。若链上仍有 USDC 但交易所仍报余额/授权为 0，多为同步延迟或签名钱包与 funder 不一致。SELL：需要 outcome 条件代币。';
    }
    if (
      /not enough balance \/ allowance/i.test(upstreamMessage) &&
      /sum of active orders:/i.test(upstreamMessage) &&
      /balance:\s*(\d+)/i.test(upstreamMessage)
    ) {
      const balanceMatch = upstreamMessage.match(/balance:\s*(\d+)/i);
      const activeMatch = upstreamMessage.match(/sum of active orders:\s*(\d+)/i);
      let lockedByOpenSells = false;
      if (balanceMatch && activeMatch) {
        try {
          lockedByOpenSells = BigInt(activeMatch[1]) > 0n && BigInt(balanceMatch[1]) <= BigInt(activeMatch[1]);
        } catch {
          lockedByOpenSells = false;
        }
      }
      if (lockedByOpenSells) {
        details.hint =
          'SELL：该 outcome 份额已被未成交卖单占用（balance 与 sum of active orders 相等）。请稍后重试平仓；服务端会自动撤销同 token 的旧卖单后再下单。若仍失败，可在交易页查看并手动撤单。';
      }
    }
    if (/orderbook .* does not exist|invalid token id/i.test(upstreamMessage)) {
      details.reasonCode = 'CLOB_ORDERBOOK_NOT_FOUND';
      details.hint =
        'This market token is not tradable on Polymarket CLOB right now. The event may be closed or waiting for settlement; refresh positions and redeem once it becomes redeemable.';
      return createAppError({
        code: Code.CLOB_REJECTED,
        httpStatus: 400,
        message:
          'This position cannot be closed through CLOB now. The event may be closed; wait for settlement, then redeem the position.',
        expose: true,
        details,
      });
    }
    return createAppError({
      code: isClient ? Code.CLOB_REJECTED : Code.DEPENDENCY_UNAVAILABLE,
      httpStatus: isClient ? 400 : 502,
      message: upstreamMessage,
      expose: true,
      details,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isTradingPrerequisiteMessage(message)) {
    return createConflictError('Trading wallet prerequisites not completed', {
      hint: TRADING_PREREQUISITES_HINT,
    });
  }

  /** Polymarket Data API（持仓）失败或超时 */
  if (message.startsWith('Data API positions')) {
    return createAppError({
      code: Code.DEPENDENCY_UNAVAILABLE,
      httpStatus: 502,
      message,
      expose: true,
    });
  }

  return null;
}

/** 平台钱包 CLOB 接口：默认关闭，需 ENABLE_PLATFORM_TRADE_ROUTES=true */
function platformTradeGuard(_req: Request, res: Response, next: NextFunction) {
  if (!CONFIG.enablePlatformTradeRoutes) {
    fail(res, Code.FEATURE_DISABLED, 'Not found', 404);
    return;
  }
  next();
}

const redeemBodySchema = z.object({
  conditionId: z.string().min(1),
  outcomeIndex: z.number().int().min(0),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
});

const tickSizeSchema = z.enum(['0.1', '0.01', '0.001', '0.0001']);
const postOrderBodySchema = z.object({
  /** 推荐：与站内 USDC 一致的 Polymarket deposit（polymarketFunderAddress）。兼容传托管 CUSTODIAL 执行地址（多钱包时）。服务端据此选签名钱包；CLOB 抵押仍用该钱包行的 funder。 */
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  tokenID: z.string().min(1, 'tokenID is required'),
  price: z.number().min(0).max(1),
  size: z.number().positive(),
  side: z.enum(['BUY', 'SELL']),
  tickSize: tickSizeSchema.optional(),
  negRisk: z.boolean().optional(),
  orderType: z.enum(['GTC', 'GTD']).optional(),
});

async function recordManualCloseExecution(params: {
  userId: number;
  order: z.infer<typeof postOrderBodySchema>;
  result: { orderID?: unknown };
}): Promise<void> {
  if (params.order.side !== 'SELL') return;

  const fill = getClobOrderFillSummary(params.result, 'SELL');
  if (!fill.filled) return;

  const fillSize = fill.size && fill.size > 0 ? fill.size : params.order.size;
  // 市价卖单请求价常为 0.01 地板价，不能当成交价/名义回退
  const requestPriceLooksLikeFloor =
    params.order.price <= 0.01 + 1e-6;
  const fillNotional =
    fill.notional && fill.notional > 0
      ? fill.notional
      : !requestPriceLooksLikeFloor
        ? params.order.price * fillSize
        : null;
  if (!(fillSize > 0) || fillNotional == null || !(fillNotional > 0)) {
    console.warn('[trade] skip manual close lot settle: missing real sell fill notional', {
      userId: params.userId,
      tokenID: params.order.tokenID,
      orderID: params.result.orderID,
      fillSize,
      fillNotional: fill.notional ?? null,
      orderPrice: params.order.price,
    });
    return;
  }
  const fillPrice =
    fill.avgPrice && fill.avgPrice > 0 ? fill.avgPrice : fillNotional / fillSize;
  if (!(fillPrice > 0) || fillPrice <= 0.01 + 1e-6) {
    console.warn('[trade] skip manual close lot settle: sell fill price looks like market floor', {
      userId: params.userId,
      tokenID: params.order.tokenID,
      orderID: params.result.orderID,
      fillPrice,
    });
    return;
  }

  const price = new Prisma.Decimal(fillPrice);
  const size = new Prisma.Decimal(fillSize);
  const execution = await prisma.copyExecution.create({
    data: {
      followerUserId: params.userId,
      leaderAddress: 'manual_close',
      tokenID: params.order.tokenID,
      side: 'SELL',
      price,
      size,
      ratioApplied: null,
      notional: new Prisma.Decimal(fillNotional),
      polymarketOrderId: params.result.orderID != null ? String(params.result.orderID) : null,
      status: 'filled',
      error: null,
    },
  });
  await consumeOpenCopyLotsForManualSell({
    prismaClient: prisma as any,
    userId: params.userId,
    legacyExecutionId: execution.id,
    tokenID: params.order.tokenID,
    exitPrice: fillPrice,
    size: fillSize,
  });
  try {
    const ctx = await getExecutionWalletForUser(params.userId, params.order.address);
    const deposit = (ctx.polymarketFunderAddress ?? '').trim();
    const positions = await fetchDataApiPositionsForWalletPair(
      { custodial: ctx.address, deposit },
      { sizeThreshold: 0, limit: 500 }
    );
    const targetToken = params.order.tokenID.trim().toLowerCase();
    const apiPosition =
      positions.find((p) => p.asset.trim().toLowerCase() === targetToken) ?? null;
    const accountPositionSize = Number(apiPosition?.size ?? 0);
    if (!(accountPositionSize > COPY_LOT_DUST_SHARES)) {
      const residualLotSize = await getOpenCopyLotSizeForUserToken({
        prismaClient: prisma as any,
        userId: params.userId,
        tokenID: params.order.tokenID,
      });
      if (residualLotSize > EPS) {
        await consumeOpenCopyLotsForManualSell({
          prismaClient: prisma as any,
          userId: params.userId,
          legacyExecutionId: execution.id,
          tokenID: params.order.tokenID,
          exitPrice: fillPrice,
          size: residualLotSize,
          allowAdditionalClose: true,
        });
      }
    }
  } catch (e) {
    console.warn('[trade] failed to reconcile residual lots after manual close', {
      userId: params.userId,
      tokenID: params.order.tokenID,
      orderID: params.result.orderID,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  await syncCopyTradingCollateralFundingState({ userId: params.userId });
}

function positionCurrentValueUsd(p: DataApiPosition): number {
  const price = Number(p.curPrice ?? 0);
  const value = Number(p.currentValue ?? price * p.size);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

const EPS = 1e-9;

function openPositionCostBasisByTokenFromLots(
  openLotsByToken: Map<string, OpenCopyLotDto[]>
): Map<string, { entryAvgPrice: string; openSize: string; costBasisUsd: string }> {
  const out = new Map<string, { entryAvgPrice: string; openSize: string; costBasisUsd: string }>();
  for (const [token, lots] of openLotsByToken) {
    let openSize = 0;
    let costBasis = 0;
    for (const lot of lots) {
      const remainingSize = Number(lot.remainingSize);
      const entryPrice = Number(lot.entryPrice);
      if (!(remainingSize > EPS)) continue;
      openSize += remainingSize;
      costBasis += remainingSize * entryPrice;
    }
    if (!(openSize > EPS)) continue;
    out.set(token, {
      entryAvgPrice: (costBasis / openSize).toFixed(8),
      openSize: openSize.toFixed(8),
      costBasisUsd: costBasis.toFixed(8),
    });
  }
  return out;
}

function mergeCostBasisMaps(
  primary: Map<string, { entryAvgPrice: string; openSize: string; costBasisUsd: string }>,
  fallback: Map<string, { entryAvgPrice: string; openSize: string; costBasisUsd: string }>
): Map<string, { entryAvgPrice: string; openSize: string; costBasisUsd: string }> {
  const out = new Map(primary);
  for (const [key, value] of fallback) {
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

function resolveCopyLotsForPosition(
  tokenKey: string,
  openLotsByToken: Map<string, OpenCopyLotDto[]>,
  fallbackLotsByToken: Map<string, OpenCopyLotDto[]>
): OpenCopyLotDto[] {
  const open = openLotsByToken.get(tokenKey) ?? [];
  if (open.length > 0) return open;
  return fallbackLotsByToken.get(tokenKey) ?? [];
}

function enrichPositionPnl<T extends DataApiPosition>(
  p: T,
  openPositionDetailsByToken: Map<string, {
    entryAvgPrice: string;
    openSize: string;
    costBasisUsd: string;
  }>
): T & {
  currentValueUsd: string;
  entryAvgPrice: string | null;
  costBasisUsd: string | null;
  unrealizedPnlUsd: string | null;
  unrealizedPnlPercent: string | null;
} {
  const detail = openPositionDetailsByToken.get(p.asset.trim().toLowerCase());
  const currentValue = positionCurrentValueUsd(p);
  const costBasis = detail ? Number(detail.costBasisUsd) : NaN;
  const pnl = Number.isFinite(costBasis) ? currentValue - costBasis : null;
  return {
    ...p,
    currentValueUsd: currentValue.toFixed(8),
    entryAvgPrice: detail?.entryAvgPrice ?? null,
    costBasisUsd: detail?.costBasisUsd ?? null,
    unrealizedPnlUsd: pnl != null ? pnl.toFixed(8) : null,
    unrealizedPnlPercent:
      pnl != null && Number.isFinite(costBasis) && costBasis > 0
        ? ((pnl / costBasis) * 100).toFixed(8)
        : null,
  };
}

/**
 * POST /api/trade/orders
 * Create and submit a limit order. tokenID should come from market's clobTokenIds (e.g. from GET /api/markets).
 */
router.post('/orders', apiKeyAuth, platformTradeGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = postOrderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const result = await createAndPostOrder(parsed.data);
    if (result?.success === false) {
      const msg = result?.errorMsg ?? 'Order failed';
      fail(res, Code.BAD_REQUEST, msg, 400, { orderID: result?.orderID });
      return;
    }
    success(res, {
      orderID: result?.orderID,
      status: result?.status,
      success: result?.success,
      transactionsHashes: result?.transactionsHashes,
      takingAmount: result?.takingAmount,
      makingAmount: result?.makingAmount,
    });
  } catch (err) {
    const appError = toTradingRouteError(err);
    if (appError) {
      next(appError);
      return;
    }
    next(err);
  }
});

/**
 * POST /api/trade/user/orders
 * Create and submit a limit order using the current user's active trading wallet.
 * Requires Authorization: Bearer <token> (in addition to x-api-key at app level).
 */
router.post('/user/orders', jwtAuth, requireUserTradePermission, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = postOrderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await createAndPostOrderForUser(req.user.userId, parsed.data, parsed.data.address, {
      source: 'USER_ORDER',
    });
    if (result?.success === false) {
      const msg = result?.errorMsg ?? 'Order failed';
      fail(res, Code.BAD_REQUEST, msg, 400, { orderID: result?.orderID });
      return;
    }
    const fillSummary = getClobOrderFillSummary(result, parsed.data.side);
    const filledSize =
      fillSummary.size != null && fillSummary.size > 0 ? fillSummary.size : parsed.data.size;
    const isPartialSell =
      parsed.data.side === 'SELL' &&
      fillSummary.filled &&
      filledSize + 1e-6 < parsed.data.size;
    try {
      await recordManualCloseExecution({
        userId: req.user.userId,
        order: parsed.data,
        result,
      });
    } catch (e) {
      console.warn('[trade] failed to record manual close execution', {
        userId: req.user.userId,
        tokenID: parsed.data.tokenID,
        orderID: result?.orderID,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    void markUserPositionScanActiveBestEffort({
      userId: req.user.userId,
      hasOpenPosition: true,
      source: 'user_order',
    });
    success(res, {
      addressUsed: parsed.data.address,
      orderID: result?.orderID,
      status: result?.status,
      success: result?.success,
      transactionsHashes: result?.transactionsHashes,
      takingAmount: result?.takingAmount,
      makingAmount: result?.makingAmount,
      partialFill: isPartialSell || undefined,
      filledSize: isPartialSell ? filledSize : undefined,
      requestedSize: isPartialSell ? parsed.data.size : undefined,
    });
  } catch (err) {
    const appError = toTradingRouteError(err);
    if (appError) {
      next(appError);
      return;
    }
    next(err);
  }
});

/**
 * GET /api/trade/user/positions/copy-lots?tokenID=
 * Lot-level detail for one position token (same shape as positions[].copyLots).
 */
router.get('/user/positions/copy-lots', jwtAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const tokenID = typeof req.query.tokenID === 'string' ? req.query.tokenID.trim() : '';
    if (!tokenID) {
      fail(res, Code.VALIDATION_FAILED, 'tokenID is required', 400);
      return;
    }
    const tokenKey = tokenID.toLowerCase();
    const markPriceByToken = new Map<string, number>();
    const markPriceRaw =
      typeof req.query.markPrice === 'string' ? Number(req.query.markPrice) : Number.NaN;
    if (Number.isFinite(markPriceRaw) && markPriceRaw > 0) {
      markPriceByToken.set(tokenKey, markPriceRaw);
    }
    const lotsByToken = await getOpenCopyLotsByTokenForUser({
      prismaClient: prisma as any,
      userId: req.user.userId,
      markPriceByToken,
      tokenIds: [tokenID],
    });
    let copyLots = lotsByToken.get(tokenKey) ?? [];
    if (!copyLots.length) {
      const ledgerFallback = await buildClosedLotDisplayFallbackForPositions({
        prismaClient: prisma as any,
        userId: req.user.userId,
        positions: [{ asset: tokenID, size: 1, curPrice: markPriceByToken.get(tokenKey) ?? 0 }],
        openLotsByToken: new Map(),
        markPriceByToken,
      });
      copyLots = ledgerFallback.lotsByToken.get(tokenKey) ?? [];
    }
    success(res, { tokenID, copyLots });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/trade/user/positions
 * Polymarket Data API 持仓，按 redeemable 分为「可链上 redeem」与「活跃需 CLOB 平仓」。
 */
router.get('/user/positions', jwtAuth, async (req: Request, res: Response, next: NextFunction) => {
  const metrics = startApiRouteMetrics();
  const stepMs: Record<string, number> = {};
  const markStep = (name: string, startedAt: number) => {
    stepMs[name] = Date.now() - startedAt;
  };
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    let t = Date.now();
    const qAddress = parseOptionalBoundAddressQuery(req);
    const listQuery = parsePositionsListQuery(req);
    const ctx = await getExecutionWalletForUser(req.user.userId, qAddress);
    markStep('wallet', t);

    const deposit = (ctx.polymarketFunderAddress ?? '').trim();
    t = Date.now();
    const raw = await fetchUserPositionsRawFromPolymarket({
      custodial: ctx.address,
      deposit,
      queryAddress: qAddress,
    });
    markStep('dataApi', t);
    const hasOpenPosition = raw.some((p) => Number(p.size ?? 0) > 0);
    const hasRedeemablePosition = raw.some((p) => p.redeemable === true && p.size > 0);
    void markUserPositionScanActiveBestEffort({
      userId: req.user.userId,
      hasOpenPosition,
      nextScanAt: hasRedeemablePosition ? new Date() : undefined,
      source: 'positions_get',
    });
    scheduleUserPositionsPreflightSettle(req.user.userId, raw);
    t = Date.now();
    const partitioned = await partitionUserDisplayPositions(req.user.userId, raw);
    markStep('staleHide', t);
    const openLotTokenKeys = await loadOpenCopyLotTokenKeysForUser({
      prismaClient: prisma as any,
      userId: req.user.userId,
    });
    const totalOpenLotCount = await countOpenCopyLotsForUser({
      prismaClient: prisma as any,
      userId: req.user.userId,
    });
    const enrichedDisplay = partitioned.displayRaw.map((p) =>
      enrichDisplayPositionWithSettlementLite(p, partitioned, openLotTokenKeys)
    );
    const pendingSettlementCount = countPendingSettlementPositions({
      raw,
      partitioned,
      openLotTokenKeys,
    });
    const total = enrichedDisplay.length;
    const pageSlice = enrichedDisplay.slice(
      listQuery.offset,
      listQuery.offset + listQuery.limit
    );
    const pageTokenIds = pageSlice.map((p) => p.asset.trim().toLowerCase()).filter(Boolean);
    const markPriceByToken = new Map(
      raw.map((p) => [p.asset.trim().toLowerCase(), Number(p.curPrice ?? 0)])
    );
    let openLotsByToken = new Map<string, OpenCopyLotDto[]>();
    let ledgerFallback: Awaited<ReturnType<typeof buildClosedLotDisplayFallbackForPositions>> = {
      costByToken: new Map(),
      lotsByToken: new Map(),
    };
    t = Date.now();
    if (pageTokenIds.length) {
      try {
        openLotsByToken = await getOpenCopyLotsByTokenForUser({
          prismaClient: prisma as any,
          userId: req.user.userId,
          markPriceByToken,
          tokenIds: pageTokenIds,
        });
      } catch (e) {
        console.warn('[trade] load open copy lots failed', {
          userId: req.user.userId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      try {
        ledgerFallback = await buildClosedLotDisplayFallbackForPositions({
          prismaClient: prisma as any,
          userId: req.user.userId,
          positions: pageSlice,
          openLotsByToken,
          markPriceByToken,
        });
      } catch (e) {
        console.warn('[trade] build closed lot display fallback failed', {
          userId: req.user.userId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    markStep('openLots', t);
    const positionCostBasisByToken = mergeCostBasisMaps(
      openPositionCostBasisByTokenFromLots(openLotsByToken),
      ledgerFallback.costByToken
    );
    const hiddenDustAssets = partitioned.hiddenDustAssets;
    const hiddenDustTotal = partitioned.hiddenDustPositionsRaw.length;
    const hiddenDustForResponse = partitioned.hiddenDustPositionsRaw.slice(
      listQuery.dustOffset,
      listQuery.dustOffset + listQuery.dustLimit
    );
    const hiddenDustPositions = hiddenDustForResponse.map((p) => ({
      ...enrichPositionPnl(p, positionCostBasisByToken),
      hiddenReason: 'dust_no_liquidity' as const,
    }));
    const addressUsed =
      deposit && deposit.toLowerCase() !== ctx.address.trim().toLowerCase() ? deposit : ctx.address;
    const mapPositionRow = (p: (typeof enrichedDisplay)[number]) => {
      const tokenKey = p.asset.trim().toLowerCase();
      const openLots = openLotsByToken.get(tokenKey) ?? [];
      const fallbackLots = ledgerFallback.lotsByToken.get(tokenKey) ?? [];
      const copyLots = openLots.length > 0 ? openLots : fallbackLots;
      const openLotCount = copyLots.length;
      return {
        ...enrichPositionPnl(p, positionCostBasisByToken),
        category: p.category,
        settlementStatus: p.settlementStatus,
        settlementHint: p.settlementHint,
        suggestedAction: p.suggestedAction,
        canClose: p.canClose,
        canRedeem: p.canRedeem,
        ...(openLotCount > 0 ? { openLotCount, copyLots } : {}),
      };
    };
    const positions = pageSlice.map(mapPositionRow);
    const summary = buildUserPositionsSummary({
      displayPositions: enrichedDisplay,
      pendingSettlementCount,
      totalOpenLotCount,
    });
    logApiRouteMetrics('/api/trade/user/positions', req.user.userId, metrics.startedAt, metrics.heapAtStart, {
      resultCount: positions.length,
      pendingSettlementCount,
      rawPositionCount: raw.length,
      hiddenDustCount: hiddenDustAssets.size,
      total,
      stepMs,
    });
    success(res, {
      addressUsed,
      positions,
      pendingSettlement: [],
      summary,
      custodialAddress: ctx.address,
      depositAddress: deposit || null,
      hiddenDustCount: hiddenDustAssets.size,
      hiddenDustTotal,
      hiddenDustPositions,
      total,
      limit: listQuery.limit,
      offset: listQuery.offset,
      hasMore: listQuery.offset + positions.length < total,
      hiddenDustLimit: listQuery.dustLimit,
      hiddenDustOffset: listQuery.dustOffset,
      hiddenDustHasMore: listQuery.dustOffset + hiddenDustPositions.length < hiddenDustTotal,
    });
  } catch (err) {
    logApiRouteMetrics('/api/trade/user/positions', req.user?.userId, metrics.startedAt, metrics.heapAtStart, {
      error: err instanceof Error ? err.message : String(err),
    });
    const appError = toTradingRouteError(err);
    if (appError) {
      next(appError);
      return;
    }
    next(err);
  }
});

/**
 * POST /api/trade/user/redeem
 * 手动触发单笔 CTF redeem（已结束可赎回仓位）；成功写入幂等日志。
 */
router.post('/user/redeem', jwtAuth, requireUserTradePermission, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = redeemBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    let redeemPosition: DataApiPosition | null = null;
    let redeemDepositAddress: string | null = null;
    try {
      const ctx = await getExecutionWalletForUser(req.user.userId, parsed.data.address);
      const deposit = (ctx.polymarketFunderAddress ?? '').trim();
      redeemDepositAddress =
        deposit && deposit.toLowerCase() !== ctx.address.trim().toLowerCase()
          ? deposit
          : ctx.address;
      const positions = await fetchDataApiPositionsForWalletPair(
        { custodial: ctx.address, deposit },
        { sizeThreshold: 0, limit: 500 }
      );
      const conditionId = parsed.data.conditionId.toLowerCase();
      redeemPosition =
        positions.find(
          (p) =>
            p.conditionId.toLowerCase() === conditionId &&
            (p.outcomeIndex ?? 0) === parsed.data.outcomeIndex &&
            p.redeemable === true &&
            p.size > 0
        ) ?? null;
    } catch (e) {
      console.warn('[trade] failed to snapshot redeem position before redeem', {
        userId: req.user.userId,
        conditionId: parsed.data.conditionId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    const redeemNotionalUsd = resolveManualRedeemNotionalUsd(redeemPosition);
    if (redeemNotionalUsd > 0) {
      await assertSufficientGasForManualRedeem(req.user.userId, redeemNotionalUsd);
    }
    const result = await redeemIfLoggedOrSkip(
      req.user.userId,
      {
        conditionId: parsed.data.conditionId,
        outcomeIndex: parsed.data.outcomeIndex,
        negativeRisk: redeemPosition?.negativeRisk === true,
        size: redeemPosition?.size,
        assetTokenId: redeemPosition?.asset,
      },
      parsed.data.address
    );
    const tryRecordRedeemSettlement = async () => {
      try {
        if (redeemPosition) {
          await recordResolvedRedeemExecutionIfMissing({
            userId: req.user!.userId,
            position: redeemPosition,
            txHash: result.txHash ?? null,
            depositAddress: redeemDepositAddress,
            redeemSource: 'manual',
          });
          return;
        }
        const ctx = await getExecutionWalletForUser(req.user!.userId, parsed.data.address);
        const deposit = (ctx.polymarketFunderAddress ?? '').trim();
        const positions = await fetchDataApiPositionsForWalletPair(
          { custodial: ctx.address, deposit },
          { sizeThreshold: 0, limit: 500 }
        );
        await reconcileUnsettledOpenCopyLotsForUser(
          req.user!.userId,
          positions,
          redeemDepositAddress
        );
      } catch (e) {
        console.warn('[trade] failed to record manual redeem execution', {
          userId: req.user!.userId,
          conditionId: parsed.data.conditionId,
          txHash: result.txHash,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };
    if (result.skipped) {
      if (result.reason === 'already_redeemed') {
        // Data API 仍显示有价值可兑仓：本地日志可能是误记，不得落账本成功。
        if (isActiveValuedApiPosition(redeemPosition) && redeemPosition?.redeemable === true) {
          throw createConflictError(
            '链上仍有可赎回赢面仓位，但本地已有赎回记录；未记为成功，请联系支持核对后重试。',
            {
              reasonCode: 'POLYMARKET_REDEEM_LOG_STALE_WHILE_VALUED',
              conditionId: parsed.data.conditionId,
              outcomeIndex: parsed.data.outcomeIndex,
              txHash: result.txHash,
            }
          );
        }
        await tryRecordRedeemSettlement();
      }
      success(res, { skipped: true, reason: result.reason ?? 'skipped' });
      return;
    }
    if (result.txHash && redeemNotionalUsd > 0) {
      try {
        await deductGasForManualRedeem({
          userId: req.user.userId,
          notionalUsd: redeemNotionalUsd,
          txHash: result.txHash,
        });
      } catch (err) {
        const gasCost = computeOrderGasCost(redeemNotionalUsd);
        console.error('[redeem-gas] manual redeem gas deduct failed after chain success', {
          userId: req.user.userId,
          conditionId: parsed.data.conditionId,
          txHash: result.txHash,
          gasCost: gasCost.toString(),
          err,
        });
      }
    }
    await tryRecordRedeemSettlement();
    success(res, { skipped: false, txHash: result.txHash });
  } catch (err) {
    const appError = toTradingRouteError(err);
    if (appError) {
      next(appError);
      return;
    }
    next(err);
  }
});

function parseOptionalBoundAddressQuery(req: Request): string | undefined {
  const raw = req.query.address;
  if (typeof raw !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(raw)) return undefined;
  return raw;
}

const userOrdersQuerySchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  market: z.string().min(1).optional(),
  asset_id: z.string().min(1).optional(),
});

const userTradesQuerySchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  market: z.string().min(1).optional(),
  asset_id: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
});

/**
 * GET /api/trade/user/orders
 * List open orders for the current user's active trading wallet.
 */
router.get('/user/orders', jwtAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const market = typeof req.query.market === 'string' ? req.query.market : undefined;
    const asset_id = typeof req.query.asset_id === 'string' ? req.query.asset_id : undefined;
    const address = parseOptionalBoundAddressQuery(req);
    const params =
      market || asset_id ? { ...(market && { market }), ...(asset_id && { asset_id }) } : undefined;
    const orders = await getOpenOrdersForUser(req.user.userId, params, address);
    success(res, { orders: orders ?? [] });
  } catch (err) {
    const appError = toTradingRouteError(err);
    if (appError) {
      next(appError);
      return;
    }
    next(err);
  }
});

router.post('/user/orders/query', jwtAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = userOrdersQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { market, asset_id, address } = parsed.data;
    const params =
      market || asset_id ? { ...(market && { market }), ...(asset_id && { asset_id }) } : undefined;
    const orders = await getOpenOrdersForUser(req.user.userId, params, address);
    success(res, { orders: orders ?? [] });
  } catch (err) {
    const appError = toTradingRouteError(err);
    if (appError) {
      next(appError);
      return;
    }
    next(err);
  }
});

/**
 * GET /api/trade/user/trades
 * Trade history for the current user's active trading wallet.
 */
router.get('/user/trades', jwtAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const market = typeof req.query.market === 'string' ? req.query.market : undefined;
    const asset_id = typeof req.query.asset_id === 'string' ? req.query.asset_id : undefined;
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    const address = parseOptionalBoundAddressQuery(req);
    const params =
      market || asset_id || before || after
        ? { ...(market && { market }), ...(asset_id && { asset_id }), ...(before && { before }), ...(after && { after }) }
        : undefined;
    const trades = await getTradesForUser(req.user.userId, params, address);
    success(res, { trades: trades ?? [] });
  } catch (err) {
    const appError = toTradingRouteError(err);
    if (appError) {
      next(appError);
      return;
    }
    next(err);
  }
});

router.post('/user/trades/query', jwtAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = userTradesQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { market, asset_id, before, after, address } = parsed.data;
    const params =
      market || asset_id || before || after
        ? { ...(market && { market }), ...(asset_id && { asset_id }), ...(before && { before }), ...(after && { after }) }
        : undefined;
    const trades = await getTradesForUser(req.user.userId, params, address);
    success(res, { trades: trades ?? [] });
  } catch (err) {
    const appError = toTradingRouteError(err);
    if (appError) {
      next(appError);
      return;
    }
    next(err);
  }
});

/**
 * DELETE /api/trade/user/orders/:orderId
 * Cancel an open order for the current user's active trading wallet.
 */
router.delete('/user/orders/:orderId', jwtAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const raw = req.params.orderId;
    const orderId = Array.isArray(raw) ? raw[0] : raw;
    if (!orderId) {
      fail(res, Code.VALIDATION_FAILED, 'orderId is required', 400);
      return;
    }
    const address = parseOptionalBoundAddressQuery(req);
    const result = await cancelOrderForUser(orderId, req.user.userId, address);
    success(res, {
      canceled: result?.canceled ?? [],
      not_canceled: result?.not_canceled ?? {},
    });
  } catch (err) {
    const appError = toTradingRouteError(err);
    if (appError) {
      next(appError);
      return;
    }
    next(err);
  }
});

/**
 * DELETE /api/trade/orders/:orderId
 * Cancel an open order by ID.
 */
router.delete('/orders/:orderId', apiKeyAuth, platformTradeGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = req.params.orderId;
    const orderId = Array.isArray(raw) ? raw[0] : raw;
    if (!orderId) {
      fail(res, Code.VALIDATION_FAILED, 'orderId is required', 400);
      return;
    }
    const result = await cancelOrder(orderId);
    success(res, {
      canceled: result?.canceled ?? [],
      not_canceled: result?.not_canceled ?? {},
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/trade/orders
 * List open orders. Query: market (condition ID), asset_id (token ID).
 */
router.get('/orders', apiKeyAuth, platformTradeGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const market = typeof req.query.market === 'string' ? req.query.market : undefined;
    const asset_id = typeof req.query.asset_id === 'string' ? req.query.asset_id : undefined;
    const orders = await getOpenOrders(
      market || asset_id ? { ...(market && { market }), ...(asset_id && { asset_id }) } : undefined
    );
    success(res, { orders: orders ?? [] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/trade/trades
 * List trade history. Query: market, asset_id, before, after.
 */
router.get('/trades', apiKeyAuth, platformTradeGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const market = typeof req.query.market === 'string' ? req.query.market : undefined;
    const asset_id = typeof req.query.asset_id === 'string' ? req.query.asset_id : undefined;
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    const params =
      market || asset_id || before || after
        ? { ...(market && { market }), ...(asset_id && { asset_id }), ...(before && { before }), ...(after && { after }) }
        : undefined;
    const trades = await getTrades(params);
    success(res, { trades: trades ?? [] });
  } catch (err) {
    next(err);
  }
});

export const tradeRouter = router;
