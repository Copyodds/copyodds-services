import { NextFunction, Router } from 'express';
import { z } from 'zod';
import type { ApiKeyCreds } from '@polymarket/clob-client-v2';
import { Prisma } from '../generated/prisma/client';
import type { CopyExecution, CopySubscription, CopyTradeRow, LeaderTrade } from '../generated/prisma/client';
import { CopyTradeStatus } from '../generated/prisma/enums';
import { prisma } from '../db';
import { CONFIG } from '../config/env';
import { jwtAuth } from '../middlewares/jwtAuth';
import { requireUserTradePermission } from '../middlewares/requireUserTradePermission';
import { isAppError } from '../utils/appError';
import { Code, success, fail } from '../utils/response';
import { toPublicCopyRelation } from '../utils/publicApiPayload';
import { encryptPolymarketSecret } from '../utils/polymarketCredentialCrypto';
import { handleLeaderOrder } from '../services/trading/followEngine';
import { publishRobotControlEvent } from '../copyTrading/events/publishRobotControlEvent';
import type { RobotControlEventType } from '../copyTrading/events/robotControlSubjects';
import {
  COPY_MIN_NOTIONAL_MODES,
  ensureLeaderAndSubscriptionForUser,
  assertCanEnableCopySubscription,
} from '../copyTrading/services/subscriptionSync';
import { queryCopyPnlCurveForUser } from '../copyTrading/services/copyPnlDailyLedger';
import { checkSmartMoneyCopyPoolSubscription } from '../services/smartMoney/smartMoneyCopyPoolSubscribeGate';
import { deleteCopySubscriptionForUser } from '../copyTrading/services/deleteCopySubscription';
import {
  BULK_COPY_SUBSCRIPTION_MAX,
  BulkCopyFundingRequiredError,
  bulkCopySubscriptionsForUser,
} from '../copyTrading/services/bulkCopySubscriptions';
import {
  formatExecutionError,
  formatUnderlyingFailureReason,
} from '../copyTrading/services/copyExecutionErrorFormat';
import { buildLastErrorsForSubscriptions } from '../copyTrading/services/subscriptionLastError';
import { describeCopyOrderErrorCode } from '../copyTrading/services/riskService';
import { getExecutionWalletForUser } from '../services/polymarket/automationSession';
import {
  getDecryptedClobCredsForWalletIfValid,
  upsertClobApiCredentialsForWallet,
} from '../services/polymarket/polymarketAuth';
import { invalidateUserClobClientCache } from '../services/polymarket/polymarketClob';
import type { PolymarketTokenMarketMetadata } from '../services/polymarket/markets';
import {
  computeCopyTradeRealizedPnlSummaryForUser,
} from '../copyTrading/services/copyTradeRealizedPnlFromFills';
import {
  ensureCopyPnlSummaryLedgerSyncedForUser,
  loadRealizedPnlBySubscriptionIdForUser,
} from '../copyTrading/services/copyPnlSummaryLedger';
import type { ExecutionPnlDetail } from '../copyTrading/services/copyTradeRealizedPnlFromFills';
import {
  getCopyLotCloseDetailsForExecutionKeys,
  getCopyLotCloseBuyLinksForExecutionKeys,
  getCopyLotCloseSellLinksForBuyRowIds,
  getCopyLotCloseDetailsForBuyRowIds,
  reconcilePartiallyClosedBuyLots,
  getOpenCopyLotSizeForSubscription,
  closeResidualCopyLotWhenFlat,
  consumeCopyLotsForSell,
  COPY_LOT_DUST_SHARES,
  type LotCloseBuyLink,
  type LotCloseSellLink,
  type BuyLotCloseDetail,
} from '../copyTrading/services/copyPositionLots';
import { parseLeaderAmountAsClobSize } from '../copyTrading/services/leaderFillAmount';
import { repairManualExpiredOpenLots } from '../copyTrading/services/copyExpiredWorthlessSettlement';
import { logApiRouteMetrics, startApiRouteMetrics } from '../utils/apiRouteMetrics';
import {
  buildDisplayExecutionRows,
  buildSettledDisplayFromClosedBuy,
  SETTLEMENT_SENTINEL_LEADER_ADDRESSES,
  withResolvedDisplayLeaderAddress,
} from '../services/copyTrade/executionLifecycleDisplay';
import { resolveFeedLeaderAddresses } from './copyTradeFeedQuery';
import {
  buildExecutionDetailTimeline,
  isExecutionDetailViewable,
  resolveExecutionDetailViewState,
  type ExecutionDetailViewState,
} from './copyTradeExecutionDetail';
import {
  listOpenCopyPositionsForSubscription,
  loadOpenPositionCountBySubscriptionIdForUser,
  summarizeOpenCopyPositionsForUser,
} from '../copyTrading/services/subscriptionCopyPositions';
import {
  getCopyFundingSnapshot,
  isCopyFundingOperational,
  isCopyFundingReady,
} from '../copyTrading/services/copyFundingCheck';
import {
  COPY_GAS_INSUFFICIENT_ERROR_CODE,
  clearCopyFundingPause,
  clearCopyFundingWarning,
  syncCopyTradingCollateralFundingState,
  syncCopyTradingGasFundingState,
  getCopyFundingPausedState,
  isCopyBuyFundingWarningCode,
  resumeUserCopyTradingFromAutoFundingPause,
  resumeUserCopyTradingPausedForGas,
} from '../copyTrading/services/copyFundingMonitor';
export const copyTradeRouter = Router();

const pnlCurveQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(366).default(30),
});

copyTradeRouter.get('/pnl-curve', jwtAuth, async (req, res, next: NextFunction) => {
  const parsed = pnlCurveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Invalid query', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }
  const userId = Number(req.user?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }
  try {
    success(res, await queryCopyPnlCurveForUser(userId, parsed.data.days));
  } catch (err) {
    next(err);
  }
});

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');

const leaderFollowerCountQuerySchema = z.object({
  leaderAddress: addressSchema.transform((value) => value.toLowerCase()),
});

function computeDefaultLeaderFollowerCount(address: string): number {
  let hash = 2166136261;
  for (const char of address.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return 18 + (Math.abs(hash) % 41);
}

const nullableTrimmedStringSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value == null) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

function tryParseManualApiCreds(input: {
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
}): ApiKeyCreds | null {
  const k = input.apiKey?.trim();
  const s = input.apiSecret?.trim();
  const p = input.passphrase?.trim();
  if (k && s && p) {
    return { key: k, secret: s, passphrase: p };
  }
  if (k?.startsWith('{')) {
    try {
      const j = JSON.parse(k) as Partial<ApiKeyCreds>;
      if (j.key && j.secret && j.passphrase) {
        return { key: j.key.trim(), secret: j.secret.trim(), passphrase: j.passphrase.trim() };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

const createBodySchema = z
  .object({
    leaderAddress: addressSchema,
    /** 与 apiSecret、passphrase 一起写入 ApiCredential；也可单字段粘贴 JSON */
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
    passphrase: z.string().optional(),
    isActive: z.boolean().optional(),
    ruleName: nullableTrimmedStringSchema,
    note: nullableTrimmedStringSchema,
    copyMode: z.enum(['RATIO', 'FIXED_AMOUNT']).optional(),
    copyRatio: z.number().positive().max(1).optional(),
    fixedAmountUsd: z.number().positive().nullable().optional(),
    minNotionalMode: z.enum(COPY_MIN_NOTIONAL_MODES).optional(),
    minAmountUsd: z.number().nonnegative().nullable().optional(),
    maxAmount: z.number().nonnegative().nullable().optional(),
    maxAmountPerMarketUsd: z.number().nonnegative().nullable().optional(),
    dailyTotalCapUsd: z.number().positive().nullable().optional(),
    /** 相对值，如 0.05 表示 5% */
    slippage: z.number().min(0).max(1).nullable().optional(),
    delayMs: z.number().int().min(0).max(3_600_000).optional(),
    marketCooldownMinutes: z.number().int().min(0).max(7 * 24 * 60).nullable().optional(),
    pauseAfterConsecutiveFails: z.number().int().min(1).max(100).nullable().optional(),
    /** 有未平仓跟单仓位时跳过加仓 BUY；默认 true（新手友好） */
    skipBuyIfOpenPosition: z.boolean().optional(),
    onlyBuy: z.boolean().optional(),
    onlySell: z.boolean().optional(),
  })
  .refine((d) => d.slippage == null || d.slippage > 0, {
    message: 'slippage 必须大于 0',
    path: ['slippage'],
  })
  .refine((d) => !(d.onlyBuy && d.onlySell), {
    message: 'onlyBuy 与 onlySell 不能同时为 true',
    path: ['onlySell'],
  })
  .refine((d) => d.copyMode !== 'FIXED_AMOUNT' || d.fixedAmountUsd != null, {
    message: '固定金额模式下必须提供 fixedAmountUsd',
    path: ['fixedAmountUsd'],
  })
  .refine(
    (d) =>
      d.copyMode !== 'FIXED_AMOUNT' ||
      d.fixedAmountUsd == null ||
      d.fixedAmountUsd >= CONFIG.copyBuyMinNotionalUsd,
    {
      message: `固定金额不能低于 ${CONFIG.copyBuyMinNotionalUsd} USDC`,
      path: ['fixedAmountUsd'],
    }
  )
  .refine((d) => d.copyMode !== 'RATIO' || d.copyRatio == null || d.copyRatio > 0, {
    message: '按可用余额比例模式下 copyRatio 必须大于 0',
    path: ['copyRatio'],
  })
  .refine(
    (d) =>
      d.minAmountUsd == null ||
      d.maxAmount == null ||
      d.minAmountUsd <= d.maxAmount,
    {
      message: 'minAmountUsd cannot exceed maxAmount',
      path: ['minAmountUsd'],
    }
  )
  .refine(
    (d) =>
      d.maxAmountPerMarketUsd == null ||
      d.maxAmount == null ||
      d.maxAmountPerMarketUsd <= d.maxAmount,
    {
      message: 'maxAmountPerMarketUsd cannot exceed maxAmount',
      path: ['maxAmountPerMarketUsd'],
    }
  )
  .refine((d) => d.maxAmount == null || d.maxAmount >= CONFIG.copyBuyMinNotionalUsd, {
    message: `单笔最大金额不能低于最小下单金额$${CONFIG.copyBuyMinNotionalUsd}`,
    path: ['maxAmount'],
  })
  .refine((d) => d.minAmountUsd == null || d.minAmountUsd >= 0, {
    message: '单笔最小金额不能小于 0',
    path: ['minAmountUsd'],
  });

// 添加或更新跟单关系
copyTradeRouter.post('/relations', jwtAuth, requireUserTradePermission, async (req, res, next: NextFunction) => {
  try {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, {
        details: parsed.error.issues,
      });
      return;
    }

    const userId = Number(req.user?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const {
      leaderAddress,
      apiKey,
      apiSecret,
      passphrase,
      isActive,
      ruleName,
      note,
      copyMode,
      copyRatio,
      fixedAmountUsd,
      minNotionalMode,
      minAmountUsd,
      maxAmount,
      maxAmountPerMarketUsd,
      dailyTotalCapUsd,
      slippage,
      delayMs,
      marketCooldownMinutes,
      pauseAfterConsecutiveFails,
      skipBuyIfOpenPosition,
      onlyBuy,
      onlySell,
    } = parsed.data;

    const executionWallet = await getExecutionWalletForUser(userId).catch(() => null);
    if (!executionWallet) {
      fail(res, Code.STATE_CONFLICT, '当前账户尚未完成自动交易钱包授权', 409);
      return;
    }

    const existingRel = await prisma.copyRelation.findUnique({
      where: {
        leaderAddress_followerUserId: {
          leaderAddress: leaderAddress.toLowerCase(),
          followerUserId: userId,
        },
      } as any,
    });

    const manualCreds = tryParseManualApiCreds({ apiKey, apiSecret, passphrase });
    const hasWalletApiCreds = !!(await getDecryptedClobCredsForWalletIfValid(executionWallet.walletId));

    let apiKeyEncrypted: string;

    if (manualCreds) {
      await upsertClobApiCredentialsForWallet({
        userId,
        walletId: executionWallet.walletId,
        creds: manualCreds,
      });
      invalidateUserClobClientCache(userId, executionWallet.address);
      apiKeyEncrypted = encryptPolymarketSecret(manualCreds.key);
    } else if (hasWalletApiCreds) {
      const credRow = await prisma.apiCredential.findUnique({
        where: { walletId: executionWallet.walletId },
      });
      if (!credRow) {
        fail(res, Code.STATE_CONFLICT, '钱包 Polymarket 凭证异常，请重新在钱包页完成授权', 409);
        return;
      }
      apiKeyEncrypted = encryptPolymarketSecret(credRow.apiKey);
    } else if (existingRel) {
      apiKeyEncrypted = existingRel.apiKeyEncrypted;
    } else {
      fail(
        res,
        Code.STATE_CONFLICT,
        '请先连接钱包并在「钱包」页完成自动交易钱包授权与 Polymarket 授权，或在本页填写 apiKey + apiSecret + passphrase（与 Polymarket CLOB 凭证一致，将写入当前交易钱包凭证）',
        409
      );
      return;
    }

    const relationIsActive = isActive !== undefined ? isActive : existingRel?.isActive ?? true;

    const isActivatingCopy =
      relationIsActive && (!existingRel || existingRel.isActive === false);

    if (isActivatingCopy) {
      const funding = await getCopyFundingSnapshot(userId);
      if (!isCopyFundingReady(funding)) {
        fail(
          res,
          Code.COPY_FUNDING_REQUIRED,
          '开启跟单需要平台 Gas 余额大于 0，请先充值 Gas',
          409,
          {
            reasonCode: 'COPY_FUNDING_REQUIRED',
            minUsdcRequired: funding.minUsdcRequired,
            depositUsdcFormatted: funding.depositUsdcFormatted,
            gasBalance: funding.gasBalance,
            hasSufficientUsdc: funding.hasSufficientUsdc,
            hasGas: funding.hasGas,
          }
        );
        return;
      }
      await clearCopyFundingPause({ userId });
    }

    let copyPoolWarning: string | null = null;
    if (relationIsActive) {
      const copyPoolCheck = await checkSmartMoneyCopyPoolSubscription(leaderAddress.toLowerCase());
      if (!copyPoolCheck.allowed) {
        fail(res, Code.STATE_CONFLICT, '该地址不在聪明钱跟单榜内，暂不支持订阅', 409, {
          reasonCode: copyPoolCheck.warningCode,
          inCopyPool: copyPoolCheck.inCopyPool,
        });
        return;
      }
      copyPoolWarning = copyPoolCheck.warningCode;

      try {
        await assertCanEnableCopySubscription(userId, leaderAddress.toLowerCase());
      } catch (err) {
        if (isAppError(err)) {
          fail(res, err.code, err.message, err.httpStatus, err.details as Record<string, unknown>);
          return;
        }
        throw err;
      }
    }

    const relation = await prisma.copyRelation.upsert({
      where: {
        leaderAddress_followerUserId: {
          leaderAddress: leaderAddress.toLowerCase(),
          followerUserId: userId,
        },
      },
      create: {
        leaderAddress: leaderAddress.toLowerCase(),
        followerUserId: userId,
        followerAddress: executionWallet.address.toLowerCase(),
        apiKeyEncrypted,
        isActive: relationIsActive,
      },
      update: {
        followerAddress: executionWallet.address.toLowerCase(),
        apiKeyEncrypted,
        isActive: relationIsActive,
      },
    } as any);

    const effectiveSlippage =
      slippage == null ? CONFIG.copyDefaultSlippage : slippage;

    const sync = await ensureLeaderAndSubscriptionForUser({
      userId,
      leaderAddress: leaderAddress.toLowerCase(),
      enabled: isActive !== undefined ? isActive : undefined,
      ruleName,
      note,
      copyMode,
      copyRatio,
      fixedAmountUsd: fixedAmountUsd === undefined ? undefined : fixedAmountUsd,
      minNotionalMode,
      minAmountUsd: minAmountUsd === undefined ? undefined : minAmountUsd,
      maxAmount: maxAmount === undefined ? undefined : maxAmount,
      maxAmountPerMarketUsd:
        maxAmountPerMarketUsd === undefined ? undefined : maxAmountPerMarketUsd,
      dailyTotalCapUsd: dailyTotalCapUsd === undefined ? undefined : dailyTotalCapUsd,
      slippage: effectiveSlippage,
      delayMs,
      marketCooldownMinutes:
        marketCooldownMinutes === undefined ? undefined : marketCooldownMinutes,
      pauseAfterConsecutiveFails:
        pauseAfterConsecutiveFails === undefined ? undefined : pauseAfterConsecutiveFails,
      skipBuyIfOpenPosition,
      onlyBuy,
      onlySell,
    });

    let robotEvent: RobotControlEventType;
    if (!sync.enabled) {
      robotEvent = 'pause';
    } else if (isActivatingCopy) {
      robotEvent = 'resume';
    } else if (sync.wasCreated) {
      robotEvent = 'reload';
    } else {
      robotEvent = 'modify';
    }

    await publishRobotControlEvent({
      subscriptionId: sync.subscriptionId,
      event: robotEvent,
      userId,
      leaderId: sync.leaderId,
      leaderAddress: sync.leaderAddress,
    });

    invalidateRelationsBundleCache(userId);
    success(res, {
      ...relation,
      ...(copyPoolWarning ? { copyPoolWarning } : {}),
    });
  } catch (err) {
    next(err);
  }
});

const deleteSubscriptionBodySchema = z.object({
  leaderAddress: addressSchema,
});

const bulkSubscriptionBodySchema = z.object({
  action: z.enum(['pause', 'resume', 'delete']),
  leaderAddresses: z
    .array(addressSchema)
    .min(1, 'At least one leader address is required')
    .max(BULK_COPY_SUBSCRIPTION_MAX),
});

copyTradeRouter.post(
  '/subscriptions/bulk',
  jwtAuth,
  requireUserTradePermission,
  async (req, res, next: NextFunction) => {
    try {
      const userId = Number(req.user?.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
        return;
      }

      const parsed = bulkSubscriptionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, {
          details: parsed.error.issues,
        });
        return;
      }

      try {
        const result = await bulkCopySubscriptionsForUser({
          userId,
          action: parsed.data.action,
          leaderAddresses: parsed.data.leaderAddresses,
        });
        invalidateRelationsBundleCache(userId);
        success(res, result);
      } catch (err) {
        if (err instanceof BulkCopyFundingRequiredError) {
          const funding = err.funding;
          fail(
            res,
            Code.COPY_FUNDING_REQUIRED,
            `批量恢复跟单需要平台 Gas 余额大于 0，请先充值 Gas`,
            409,
            {
              reasonCode: 'COPY_FUNDING_REQUIRED',
              minUsdcRequired: funding.minUsdcRequired,
              depositUsdcFormatted: funding.depositUsdcFormatted,
              gasBalance: funding.gasBalance,
              hasSufficientUsdc: funding.hasSufficientUsdc,
              hasGas: funding.hasGas,
            }
          );
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);

copyTradeRouter.delete('/subscriptions', jwtAuth, requireUserTradePermission, async (req, res, next: NextFunction) => {
  try {
    const userId = Number(req.user?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const parsed = deleteSubscriptionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, {
        details: parsed.error.issues,
      });
      return;
    }

    const deleted = await deleteCopySubscriptionForUser({
      userId,
      leaderAddress: parsed.data.leaderAddress,
    });

    if (!deleted) {
      fail(res, Code.NOT_FOUND, 'Copy subscription not found', 404);
      return;
    }

    invalidateRelationsBundleCache(userId);
    success(res, deleted);
  } catch (err) {
    next(err);
  }
});

/** 链上跟单订阅参数（CopySubscription） */
copyTradeRouter.get('/leader-follower-count', jwtAuth, async (req, res, next: NextFunction) => {
  const parsed = leaderFollowerCountQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const leaderAddress = parsed.data.leaderAddress;
    const defaultFollowerCount = computeDefaultLeaderFollowerCount(leaderAddress);
    const leader = await prisma.copyLeader.findUnique({
      where: { address: leaderAddress },
      select: { id: true },
    });
    const realFollowerCount =
      leader == null
        ? 0
        : await prisma.copySubscription.count({
            where: {
              leaderId: leader.id,
              enabled: true,
              deletedAt: null,
            },
          });

    success(res, {
      leaderAddress,
      defaultFollowerCount,
      realFollowerCount,
      displayFollowerCount: defaultFollowerCount + realFollowerCount,
    });
  } catch (err) {
    next(err);
  }
});

copyTradeRouter.get('/subscriptions', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    const userId = Number(req.user?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const out = await buildCopySubscriptionsDtoForUser(userId);
    success(res, out);
  } catch (err) {
    next(err);
  }
});

const subscriptionIdParamSchema = z.object({
  subscriptionId: z.string().uuid('Invalid subscription id'),
});

/** One-shot open-position mark summary for all subscriptions (copy-rules page header). */
copyTradeRouter.get('/positions-summary', jwtAuth, async (req, res, next: NextFunction) => {
  const metrics = startApiRouteMetrics();
  const userId = Number(req.user?.userId);
  try {
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const result = await summarizeOpenCopyPositionsForUser(userId);
    logApiRouteMetrics('/api/copy-trade/positions-summary', userId, metrics.startedAt, metrics.heapAtStart, {
      positionCount: result.summary.positionCount,
      subscriptionCount: Object.keys(result.bySubscriptionId).length,
    });
    success(res, result);
  } catch (err) {
    logApiRouteMetrics('/api/copy-trade/positions-summary', userId, metrics.startedAt, metrics.heapAtStart, {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

/** Per-subscription open copy positions (lazy-loaded when expanding a subscription row). */
copyTradeRouter.get(
  '/subscriptions/:subscriptionId/positions',
  jwtAuth,
  async (req, res, next: NextFunction) => {
    const metrics = startApiRouteMetrics();
    const userId = Number(req.user?.userId);
    try {
      if (!Number.isInteger(userId) || userId <= 0) {
        fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
        return;
      }

      const parsed = subscriptionIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        fail(res, Code.VALIDATION_FAILED, 'Invalid subscription id', 400, {
          details: parsed.error.flatten(),
        });
        return;
      }

      const result = await listOpenCopyPositionsForSubscription({
        userId,
        subscriptionId: parsed.data.subscriptionId,
      });
      if (!result) {
        fail(res, Code.NOT_FOUND, 'Copy subscription not found', 404);
        return;
      }

      logApiRouteMetrics(
        '/api/copy-trade/subscriptions/:subscriptionId/positions',
        userId,
        metrics.startedAt,
        metrics.heapAtStart,
        { positionCount: result.positions.length }
      );
      success(res, result);
    } catch (err) {
      logApiRouteMetrics(
        '/api/copy-trade/subscriptions/:subscriptionId/positions',
        userId,
        metrics.startedAt,
        metrics.heapAtStart,
        { error: err instanceof Error ? err.message : String(err) }
      );
      next(err);
    }
  }
);

/** 跟单资金前置：Polymarket deposit 中 USDC.e + pUSD 是否满足最低要求 */
copyTradeRouter.get('/funding-status', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    const userId = Number(req.user?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    success(res, await getCopyFundingStatusForUser(userId));
  } catch (err) {
    next(err);
  }
});

type CopySubscriptionDto = {
  id: string;
  leaderId: string;
  leaderAddress: string;
  /** Smart Money 展示名（非地址形态）；缺省时前端回退短地址 */
  leaderDisplayName: string | null;
  /** Smart Money X 用户名（无 @） */
  leaderXUsername: string | null;
  /** 产品档位 S|A|B|C|D */
  leaderTier: string | null;
  ruleName: string | null;
  note: string | null;
  copyMode: string;
  copyRatio: string;
  fixedAmountUsd: string | null;
  minNotionalMode: string;
  minAmountUsd: string | null;
  maxAmount: string | null;
  maxAmountPerMarketUsd: string | null;
  dailyTotalCapUsd: string | null;
  slippage: string | null;
  delayMs: number;
  marketCooldownMinutes: number | null;
  pauseAfterConsecutiveFails: number | null;
  /** 有未平仓跟单仓位时跳过加仓 BUY */
  skipBuyIfOpenPosition: boolean;
  onlyBuy: boolean;
  onlySell: boolean;
  enabled: boolean;
  /** CopyLeader.enabled；后台停用 Leader 时与 enabled 一并变为 false */
  leaderEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  fundingWarningCode: string | null;
  fundingWarningReason: string | null;
  fundingWarningAt: string | null;
  fundingPausedAt: string | null;
  lastError: unknown | null;
  /** Settled (realized) PnL for this subscription in the current trading mode; floating PnL stays on positions. */
  realizedPnlUsd: string;
  /** Distinct open copy tokens (remainingSize > dust); for collapsed Positions (N) without expand fetch. */
  openPositionCount: number;
};

async function buildCopySubscriptionsDtoForUser(userId: number): Promise<CopySubscriptionDto[]> {
  const rows = await prisma.copySubscription.findMany({
      where: { userId, deletedAt: null },
      include: { leader: true },
      orderBy: { updatedAt: 'desc' },
    });

  const emptyPnl = Promise.resolve(new Map<string, string>());
  const emptyCounts = Promise.resolve(new Map<string, number>());
  const [lastErrorBySubId, realizedPnlBySubId, openPositionCountBySubId] = await Promise.all([
    buildLastErrorsForSubscriptions(rows),
    rows.length === 0 ? emptyPnl : loadRealizedPnlBySubscriptionIdForUser(userId),
    rows.length === 0 ? emptyCounts : loadOpenPositionCountBySubscriptionIdForUser(userId),
  ]);

  const subscriptions = rows.map((s) => ({
    id: s.id,
    leaderId: s.leaderId,
    leaderAddress: s.leader.address,
    // 读 CopyLeader 快照（订阅/评分刷新时写入），列表不再联查 Smart Money 榜
    leaderDisplayName: s.leader.displayName ?? null,
    leaderXUsername: s.leader.xUsername ?? null,
    leaderTier: s.leader.tier ?? null,
    ruleName: s.ruleName ?? null,
    note: s.note ?? null,
    copyMode: s.copyMode,
    copyRatio: s.copyRatio.toString(),
    fixedAmountUsd: s.fixedAmountUsd?.toString() ?? null,
    minNotionalMode: s.minNotionalMode,
    minAmountUsd: s.minAmountUsd?.toString() ?? null,
    maxAmount: s.maxAmount?.toString() ?? null,
    maxAmountPerMarketUsd: s.maxAmountPerMarketUsd?.toString() ?? null,
    dailyTotalCapUsd: s.dailyTotalCapUsd?.toString() ?? null,
    slippage: s.slippage?.toString() ?? null,
    delayMs: s.delayMs,
    marketCooldownMinutes: s.marketCooldownMinutes ?? null,
    pauseAfterConsecutiveFails: s.pauseAfterConsecutiveFails ?? null,
    skipBuyIfOpenPosition: s.skipBuyIfOpenPosition,
    onlyBuy: s.onlyBuy,
    onlySell: s.onlySell,
    leaderEnabled: s.leader.enabled,
    // 用户侧「跟单中」：订阅开启且 Leader 未被后台停用（与 watch-list / 派发一致）
    enabled: s.enabled && s.leader.enabled,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    fundingWarningCode: s.fundingWarningCode ?? null,
    fundingWarningReason: s.fundingWarningReason ?? null,
    fundingWarningAt: s.fundingWarningAt?.toISOString() ?? null,
    fundingPausedAt: s.fundingPausedAt?.toISOString() ?? null,
    lastError: lastErrorBySubId.get(s.id) ?? null,
    realizedPnlUsd: realizedPnlBySubId.get(s.id) ?? '0',
    openPositionCount: openPositionCountBySubId.get(s.id) ?? 0,
  }));

  subscriptions.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return subscriptions;
}

type CopyTradeRelationsBundle = {
  relations: any[];
  subscriptions: CopySubscriptionDto[];
  fundingStatus: {
    minUsdcRequired: number;
    minUsdcRequiredToOperate?: number;
    depositUsdcFormatted: string | null;
    gasBalance: string;
    hasSufficientUsdc: boolean;
    hasOperationalUsdc?: boolean;
    hasGas: boolean;
    ready: boolean;
    canOperate?: boolean;
    copyPausedDueToFunding?: boolean;
    fundingPause?: any | null;
  } | null;
  session: {
    hasExecutionWallet: boolean;
    polymarketAuthorized: boolean;
  };
};

const RELATIONS_BUNDLE_CACHE_MS = 30_000;
const relationsBundleCache = new Map<
  number,
  { expiresAt: number; value: CopyTradeRelationsBundle }
>();

function invalidateRelationsBundleCache(userId: number): void {
  relationsBundleCache.delete(userId);
}

async function getCopyTradeSessionForUser(userId: number): Promise<CopyTradeRelationsBundle['session']> {
  const executionWallet = await getExecutionWalletForUser(userId).catch(() => null);
  const hasExecutionWallet = !!executionWallet;
  const polymarketAuthorized = executionWallet
    ? !!(await getDecryptedClobCredsForWalletIfValid(executionWallet.walletId))
    : false;
  return { hasExecutionWallet, polymarketAuthorized };
}

// 获取当前用户的跟单列表
copyTradeRouter.get('/relations', jwtAuth, async (req, res, next: NextFunction) => {
  const metrics = startApiRouteMetrics();
  const userId = Number(req.user?.userId);
  try {
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const cached = relationsBundleCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      logApiRouteMetrics('/api/copy-trade/relations', userId, metrics.startedAt, metrics.heapAtStart, {
        cacheHit: true,
        subscriptionCount: cached.value.subscriptions.length,
      });
      success(res, cached.value);
      return;
    }

    const [relations, subscriptions, fundingStatus, session] = await Promise.all([
      prisma.copyRelation.findMany({
        where: { followerUserId: userId },
        orderBy: { createdAt: 'desc' },
      } as any),
      buildCopySubscriptionsDtoForUser(userId),
      getCopyFundingStatusForUserReadOnly(userId).catch(() => null),
      getCopyTradeSessionForUser(userId),
    ]);

    relations.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    const out: CopyTradeRelationsBundle = {
      relations: relations.map((r) => toPublicCopyRelation(r)),
      subscriptions,
      fundingStatus,
      session,
    };
    relationsBundleCache.set(userId, {
      expiresAt: Date.now() + RELATIONS_BUNDLE_CACHE_MS,
      value: out,
    });

    logApiRouteMetrics('/api/copy-trade/relations', userId, metrics.startedAt, metrics.heapAtStart, {
      cacheHit: false,
      subscriptionCount: subscriptions.length,
    });
    success(res, out);
  } catch (err) {
    logApiRouteMetrics('/api/copy-trade/relations', userId, metrics.startedAt, metrics.heapAtStart, {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

const EXECUTIONS_MAX_LIMIT = 50;
const EXECUTIONS_MAX_FETCH_CAP = 120;
const EXECUTIONS_BATCH_SIZE = 80;
/** Max raw trade/legacy rows scanned per request while paginating in-memory after merge. */
const EXECUTIONS_MAX_RAW_SCAN = 4000;
/** Extra display rows beyond the page window so merge/filter shrink does not truncate the page. */
const EXECUTIONS_DISPLAY_OVERSCAN = 24;
const EXECUTION_LIST_TOTAL_CACHE_MS = 10 * 60 * 1000;
const STALE_SUBMITTING_SWEEP_CACHE_MS = 30_000;
const staleSubmittingSweepAtByUser = new Map<number, number>();
const EXECUTIONS_PREFLIGHT_RECONCILE_CACHE_MS = 60_000;
const executionsPreflightReconcileAtByUser = new Map<number, number>();
const executionsPreflightReconcileInFlightByUser = new Set<number>();

const LEADER_TRADE_EXECUTION_SELECT = {
  id: true,
  leaderAddress: true,
  side: true,
  amount: true,
  price: true,
  tokenId: true,
  marketTitle: true,
  outcome: true,
  blockNumber: true,
  logIndex: true,
  txHash: true,
} as const;

const COPY_TRADE_EXECUTION_SELECT = {
  id: true,
  userId: true,
  subscriptionId: true,
  status: true,
  errorCode: true,
  errorMsg: true,
  polymarketOrderId: true,
  intendedPrice: true,
  intendedSize: true,
  intendedNotional: true,
  filledAmount: true,
  avgPrice: true,
  marketId: true,
  marketTitle: true,
  outcome: true,
  realizedPnlUsd: true,
  createdAt: true,
  updatedAt: true,
  leaderTrade: { select: LEADER_TRADE_EXECUTION_SELECT },
  subscription: {
    select: { copyMode: true, copyRatio: true, fixedAmountUsd: true },
  },
} as const;

/** 无 leader 过滤时：先按 userId+createdAt 索引取行，再批量 hydrate，避免大表 LATERAL join */
const COPY_TRADE_EXECUTION_ROW_SELECT = {
  id: true,
  userId: true,
  subscriptionId: true,
  leaderTradeId: true,
  status: true,
  errorCode: true,
  errorMsg: true,
  polymarketOrderId: true,
  intendedPrice: true,
  intendedSize: true,
  intendedNotional: true,
  filledAmount: true,
  avgPrice: true,
  marketId: true,
  marketTitle: true,
  outcome: true,
  tokenId: true,
  realizedPnlUsd: true,
  createdAt: true,
  updatedAt: true,
} as const;

type CopyTradeExecutionRowBase = CopyTradeRow & {
  leaderTradeId: string;
  subscriptionId: string;
};

async function hydrateCopyTradeExecutionRows(
  rows: CopyTradeExecutionRowBase[]
): Promise<EventDrivenExecutionRow[]> {
  if (!rows.length) return [];

  const leaderIds = [...new Set(rows.map((r) => r.leaderTradeId))];
  const subIds = [...new Set(rows.map((r) => r.subscriptionId))];
  const [leaders, subs] = await Promise.all([
    prisma.leaderTrade.findMany({
      where: { id: { in: leaderIds } },
      select: LEADER_TRADE_EXECUTION_SELECT,
    }),
    prisma.copySubscription.findMany({
      where: { id: { in: subIds } },
      select: { id: true, copyMode: true, copyRatio: true, fixedAmountUsd: true },
    }),
  ]);
  const leaderById = new Map(leaders.map((l) => [l.id, l]));
  const subById = new Map(subs.map((s) => [s.id, s]));

  const out: EventDrivenExecutionRow[] = [];
  for (const row of rows) {
    const leaderTrade = leaderById.get(row.leaderTradeId);
    const subscription = subById.get(row.subscriptionId);
    if (!leaderTrade || !subscription) continue;
    const { leaderTradeId: _lt, subscriptionId: _sub, ...rest } = row;
    out.push({
      ...(rest as Omit<EventDrivenExecutionRow, 'leaderTrade' | 'subscription'>),
      leaderTrade: leaderTrade as EventDrivenExecutionRow['leaderTrade'],
      subscription,
    });
  }
  return out;
}

async function fetchCopyTradeExecutionRows(params: {
  where: Prisma.CopyTradeRowWhereInput;
  take: number;
  skip?: number;
  useLeaderJoin: boolean;
}): Promise<EventDrivenExecutionRow[]> {
  const skip = params.skip ?? 0;
  if (params.useLeaderJoin) {
    return prisma.copyTradeRow.findMany({
      where: params.where,
      select: COPY_TRADE_EXECUTION_SELECT,
      orderBy: { createdAt: 'desc' },
      take: params.take,
      skip,
    }) as Promise<EventDrivenExecutionRow[]>;
  }

  const baseRows = await prisma.copyTradeRow.findMany({
    where: params.where,
    select: COPY_TRADE_EXECUTION_ROW_SELECT,
    orderBy: { createdAt: 'desc' },
    take: params.take,
    skip,
  });
  return hydrateCopyTradeExecutionRows(baseRows as CopyTradeExecutionRowBase[]);
}

const LEGACY_EXECUTION_SELECT = {
  id: true,
  followerUserId: true,
  leaderAddress: true,
  tokenID: true,
  side: true,
  price: true,
  size: true,
  ratioApplied: true,
  notional: true,
  status: true,
  polymarketOrderId: true,
  error: true,
  createdAt: true,
} as const;

const FAILURE_ROW_SELECT = {
  id: true,
  userId: true,
  subscriptionId: true,
  errorCode: true,
  errorMsg: true,
  updatedAt: true,
  leaderTrade: { select: { leaderAddress: true } },
} as const;

const listExecutionsSchema = z.object({
  limit: z.string().optional(),
  offset: z.string().optional(),
  leaderAddress: addressSchema.optional(),
  subscriptionId: z.string().uuid().optional(),
  /** all | success(filled) | settled(closed/redeemed/expired) | failed(failed/dead or with error) */
  status: z.enum(['all', 'success', 'settled', 'failed']).optional(),
});

/** 跟单已实现盈亏：DB 聚合；`todayRealizedPnlUsd` = 自今日窗口（默认每日 8:00 Asia/Shanghai）起已实现 */
copyTradeRouter.get('/pnl-summary', jwtAuth, async (req, res, next: NextFunction) => {
  const metrics = startApiRouteMetrics();
  const userId = Number(req.user?.userId);
  try {
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const summary = await computeCopyTradeRealizedPnlSummaryForUser(userId);
    logApiRouteMetrics('/api/copy-trade/pnl-summary', userId, metrics.startedAt, metrics.heapAtStart);
    success(res, summary);
  } catch (err) {
    logApiRouteMetrics('/api/copy-trade/pnl-summary', userId, metrics.startedAt, metrics.heapAtStart, {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

/** 与前端 `CopyExecution` 对齐；事件驱动写入 `copy_trades`，旧引擎/模拟写入 `CopyExecution` */
type ExecutionListItem = {
  id: string;
  leaderAddress: string;
  tokenID: string;
  side: string;
  price: string;
  size: string;
  ratioApplied?: string | null;
  notional?: string | null;
  status: string;
  polymarketOrderId?: string | null;
  /** 鏈哄櫒鍙閿欒鐮侊紱鍓嶇鍙槧灏勪负鐭枃妗?*/
  errorCode?: string | null;
  error?: string | null;
  realizedPnlUsd?: string | null;
  entryAvgPrice?: string | null;
  exitPrice?: string | null;
  closedSize?: string | null;
  costBasisUsd?: string | null;
  proceedsUsd?: string | null;
  settlementType?: 'market_sell' | 'redeem' | 'expired_worthless' | null;
  settlementResult?: 'win' | 'loss' | 'flat' | null;
  /** Gamma 解析的「问题 · 结果」；列表接口写入，可为 null */
  marketLabel?: string | null;
  /** Gamma 甯傚満闂鏍囬 */
  title?: string | null;
  /** Gamma 鎵€灞炰簨浠舵爣棰?*/
  eventTitle?: string | null;
  question?: string | null;
  outcome?: string | null;
  /** Filled BUY: copy lot remaining; null when unknown (legacy rows). */
  openLotRemaining?: string | null;
  /** BUY + settlement merged for display (lifecycle card). */
  _lifecycle?: {
    buy: ExecutionListItem;
    /** Present when one settlement closes multiple buys (detail timeline). */
    buys?: ExecutionListItem[];
    settlement: ExecutionListItem;
  };
  /** 是否可进入持仓/结算详情页 */
  canViewDetail?: boolean;
  createdAt: string;
};

type EventDrivenExecutionRow = CopyTradeRow & {
  leaderTrade: LeaderTrade;
  subscription: Pick<CopySubscription, 'copyMode' | 'copyRatio' | 'fixedAmountUsd'>;
};
type FailureContextRow = CopyTradeRow & { leaderTrade: Pick<LeaderTrade, 'leaderAddress'> };

async function getCopyFundingStatusForUserReadOnly(userId: number) {
  const [funding, paused] = await Promise.all([
    getCopyFundingSnapshot(userId, { readOnly: true }),
    getCopyFundingPausedState(userId),
  ]);
  const activationReady = isCopyFundingReady(funding);
  const gasOperational = isCopyFundingOperational(funding);

  return {
    ...funding,
    ready: activationReady && paused == null,
    canOperate: gasOperational && paused == null,
    canBuy: gasOperational && funding.hasOperationalUsdc && paused == null,
    canSell: paused == null,
    copyPausedDueToFunding: paused != null,
    fundingPause: paused,
  };
}

async function getCopyFundingStatusForUser(userId: number) {
  let funding = await getCopyFundingSnapshot(userId, { readOnly: true });
  const activationReady = isCopyFundingReady(funding);
  const gasOperational = isCopyFundingOperational(funding);
  let paused = await getCopyFundingPausedState(userId);

  if (paused != null) {
    if (funding.hasGas) {
      await resumeUserCopyTradingFromAutoFundingPause({ userId });
    } else if (paused.errorCode === COPY_GAS_INSUFFICIENT_ERROR_CODE) {
      await resumeUserCopyTradingPausedForGas({ userId });
    }
    paused = await getCopyFundingPausedState(userId);
  }

  if (
    paused != null &&
    paused.errorCode !== COPY_GAS_INSUFFICIENT_ERROR_CODE &&
    funding.hasGas
  ) {
    await clearCopyFundingPause({ userId });
    await resumeUserCopyTradingFromAutoFundingPause({ userId });
    paused = null;
  }

  await syncCopyTradingGasFundingState({ userId, funding });
  await syncCopyTradingCollateralFundingState({ userId });
  funding = await getCopyFundingSnapshot(userId, { readOnly: true });

  return {
    ...funding,
    ready: activationReady && paused == null,
    canOperate: gasOperational && paused == null,
    canBuy: gasOperational && funding.hasOperationalUsdc && paused == null,
    canSell: paused == null,
    copyPausedDueToFunding: paused != null,
    fundingPause: paused,
  };
}

function shouldHideExecutionRow(row: EventDrivenExecutionRow): boolean {
  if (row.status !== CopyTradeStatus.skipped) return false;
  if (
    row.errorCode === 'ignored_no_position_sell' ||
    row.errorCode === 'user_insufficient_shares' ||
    row.errorCode === 'zero_size'
  ) {
    return true;
  }
  return isCopyBuyFundingWarningCode(row.errorCode);
}

async function loadBuyLotRemainingByRowId(
  userId: number,
  rowIds: string[]
): Promise<Map<string, number>> {
  if (rowIds.length === 0) return new Map();
  const lots = await prisma.copyPositionLot.findMany({
    where: {
      userId,
      buyCopyTradeRowId: { in: rowIds },
    },
    select: { buyCopyTradeRowId: true, remainingSize: true },
  });
  const map = new Map<string, number>();
  for (const lot of lots) {
    const rem = Number(lot.remainingSize.toString());
    if (!Number.isFinite(rem)) continue;
    const key = lot.buyCopyTradeRowId;
    map.set(key, (map.get(key) ?? 0) + rem);
  }
  return map;
}

/** Repair failed copy SELL rows that already closed lots on chain (CLOB fill vs lot drift). */
async function reconcileFailedCopySellRows(userId: number): Promise<void> {
  const rows = await prisma.copyTradeRow.findMany({
    where: {
      userId,
      status: CopyTradeStatus.failed,
      leaderTrade: { side: 'SELL' },
    },
    select: {
      id: true,
      subscriptionId: true,
      avgPrice: true,
      intendedPrice: true,
      leaderTrade: { select: { tokenId: true } },
    },
    take: 40,
    orderBy: { updatedAt: 'desc' },
  });
  if (!rows.length) return;

  for (const row of rows) {
    const tokenID = row.leaderTrade.tokenId;
    const closeRows = await prisma.copyPositionLotClose.findMany({
      where: { userId, sellCopyTradeRowId: row.id },
      select: { closedSize: true, exitPrice: true },
    });
    if (!closeRows.length) continue;

    const exitPrice = Number(
      (row.avgPrice ?? row.intendedPrice ?? closeRows[0]?.exitPrice ?? 0).toString()
    );

    let lotRemaining = await getOpenCopyLotSizeForSubscription({
      prismaClient: prisma as any,
      userId,
      subscriptionId: row.subscriptionId,
      tokenID,
    });

    if (lotRemaining > COPY_LOT_DUST_SHARES) {
      await closeResidualCopyLotWhenFlat({
        prismaClient: prisma as any,
        userId,
        subscriptionId: row.subscriptionId,
        sellCopyTradeRowId: row.id,
        tokenID,
        exitPrice: Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : 0,
        accountPositionSize: 0,
      });
      lotRemaining = await getOpenCopyLotSizeForSubscription({
        prismaClient: prisma as any,
        userId,
        subscriptionId: row.subscriptionId,
        tokenID,
      });
    } else if (lotRemaining > 1e-6) {
      await consumeCopyLotsForSell({
        prismaClient: prisma as any,
        userId,
        subscriptionId: row.subscriptionId,
        sellCopyTradeRowId: row.id,
        tokenID,
        exitPrice: Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : 0,
        size: lotRemaining,
        allowAdditionalClose: true,
      });
      lotRemaining = 0;
    }

    if (lotRemaining > COPY_LOT_DUST_SHARES) continue;

    const allCloses = await prisma.copyPositionLotClose.findMany({
      where: { userId, sellCopyTradeRowId: row.id },
      select: { closedSize: true, exitPrice: true },
    });
    let closedSize = 0;
    let exitWeighted = 0;
    for (const close of allCloses) {
      const sz = Number(close.closedSize.toString());
      const px = Number(close.exitPrice.toString());
      if (Number.isFinite(sz) && sz > 0) {
        closedSize += sz;
        if (Number.isFinite(px) && px > 0) exitWeighted += sz * px;
      }
    }
    if (!(closedSize > 0)) continue;

    const avgExit = exitWeighted > 0 ? exitWeighted / closedSize : null;
    await prisma.copyTradeRow.update({
      where: { id: row.id },
      data: {
        status: CopyTradeStatus.filled,
        filledAmount: closedSize.toFixed(8),
        ...(avgExit != null ? { avgPrice: avgExit.toFixed(8) } : {}),
        errorCode: null,
        errorMsg: null,
      },
    });
  }
}

async function maybeReconcileExecutionsPreflight(userId: number): Promise<void> {
  const now = Date.now();
  const last = executionsPreflightReconcileAtByUser.get(userId) ?? 0;
  if (
    now - last < EXECUTIONS_PREFLIGHT_RECONCILE_CACHE_MS ||
    executionsPreflightReconcileInFlightByUser.has(userId)
  ) {
    return;
  }
  executionsPreflightReconcileAtByUser.set(userId, now);
  executionsPreflightReconcileInFlightByUser.add(userId);
  try {
    await repairManualExpiredOpenLots(userId);
    await reconcilePartiallyClosedBuyLots({ prismaClient: prisma as any, userId });
    await reconcileFailedCopySellRows(userId);
    await ensureCopyPnlSummaryLedgerSyncedForUser(userId);
  } catch (e) {
    console.warn('[copy-trade] executions preflight reconcile failed', {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    executionsPreflightReconcileInFlightByUser.delete(userId);
  }
}

async function markStaleSubmittingCopyRowsForUser(userId: number): Promise<void> {
  const now = Date.now();
  const last = staleSubmittingSweepAtByUser.get(userId) ?? 0;
  if (now - last < STALE_SUBMITTING_SWEEP_CACHE_MS) {
    return;
  }
  staleSubmittingSweepAtByUser.set(userId, now);
  const staleBefore = new Date(Date.now() - CONFIG.copyStaleSubmittingMs);
  await prisma.copyTradeRow.updateMany({
    where: {
      userId,
      status: CopyTradeStatus.submitting,
      updatedAt: { lt: staleBefore },
    },
    data: {
      status: CopyTradeStatus.failed,
      errorCode: 'stale_submitting',
      errorMsg: 'Copy order stayed submitting for too long and was marked retryable.',
    },
  });
}

function executionItemHasMarketText(item: ExecutionListItem): boolean {
  return Boolean(
    item.marketLabel?.trim() ||
      item.title?.trim() ||
      item.eventTitle?.trim() ||
      item.question?.trim()
  );
}

function metadataFromLocalRow(row: {
  marketTitle?: string | null;
  outcome?: string | null;
  leaderTrade?: { marketTitle?: string | null; outcome?: string | null } | null;
}): PolymarketTokenMarketMetadata | null {
  const title = row.marketTitle ?? row.leaderTrade?.marketTitle ?? null;
  const outcome = row.outcome ?? row.leaderTrade?.outcome ?? null;
  if (!title && !outcome) return null;
  return {
    marketLabel: title,
    title,
    eventTitle: title,
    category: null,
    question: title,
    outcome,
    volumeNum: null,
  };
}

async function loadLocalMarketMetadataForItems(
  userId: number,
  items: ExecutionListItem[]
): Promise<Map<string, PolymarketTokenMarketMetadata>> {
  const tokenIds = Array.from(
    new Set(
      items
        .filter((item) => !executionItemHasMarketText(item))
        .map((item) => item.tokenID?.trim())
        .filter((tokenId): tokenId is string => Boolean(tokenId && /^\d+$/.test(tokenId)))
    )
  );
  return loadLocalMarketMetadataForTokenIds(userId, tokenIds);
}

async function loadLocalMarketMetadataForTokenIds(
  userId: number,
  tokenIds: string[]
): Promise<Map<string, PolymarketTokenMarketMetadata>> {
  if (!tokenIds.length) return new Map();

  const [directRows, legacyRows] = await Promise.all([
    prisma.copyTradeRow.findMany({
      where: { userId, tokenId: { in: tokenIds } },
      select: {
        tokenId: true,
        marketTitle: true,
        outcome: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.copyTradeRow.findMany({
      where: {
        userId,
        tokenId: null,
        leaderTrade: { tokenId: { in: tokenIds } },
      },
      select: {
        leaderTrade: {
          select: { tokenId: true, marketTitle: true, outcome: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
    }),
  ]);

  const rows = [
    ...directRows.map((row) => ({
      tokenId: row.tokenId,
      marketTitle: row.marketTitle,
      outcome: row.outcome,
      leaderTrade: null as { marketTitle?: string | null; outcome?: string | null } | null,
    })),
    ...legacyRows.map((row) => ({
      tokenId: row.leaderTrade.tokenId,
      marketTitle: row.leaderTrade.marketTitle,
      outcome: row.leaderTrade.outcome,
      leaderTrade: row.leaderTrade,
    })),
  ];

  const out = new Map<string, PolymarketTokenMarketMetadata>();
  for (const row of rows) {
    const tokenId =
      row.tokenId ??
      ('leaderTrade' in row && row.leaderTrade && 'tokenId' in row.leaderTrade
        ? (row.leaderTrade as { tokenId?: string }).tokenId
        : undefined);
    if (!tokenId || out.has(tokenId)) continue;
    const metadata = metadataFromLocalRow(row);
    if (metadata) out.set(tokenId, metadata);
  }
  return out;
}

function formatUnderlyingFailureReasonFromRow(
  row: Pick<CopyTradeRow, 'errorCode' | 'errorMsg'>
): string | null {
  return formatUnderlyingFailureReason(row.errorCode, row.errorMsg);
}

function buildRecentFailureLookup(rows: FailureContextRow[]): Map<number, FailureContextRow[]> {
  const lookup = new Map<number, FailureContextRow[]>();

  for (const row of rows) {
    const list = lookup.get(row.userId);
    if (list) {
      list.push(row);
    } else {
      lookup.set(row.userId, [row]);
    }
  }

  return lookup;
}

function findRecentRootFailureRow(
  row: EventDrivenExecutionRow,
  failureLookup: Map<number, FailureContextRow[]>
): FailureContextRow | null {
  if (row.errorCode !== 'fail_streak') {
    return null;
  }

  const failures = failureLookup.get(row.userId) ?? [];
  if (!failures.length) {
    return null;
  }

  const earlierFailures = failures.filter((candidate) => candidate.updatedAt <= row.updatedAt);
  const sameSubscription = earlierFailures.find(
    (candidate) => candidate.subscriptionId === row.subscriptionId
  );
  const sameLeader = earlierFailures.find(
    (candidate) => candidate.leaderTrade.leaderAddress === row.leaderTrade.leaderAddress
  );
  const fallback = earlierFailures[0];
  return sameSubscription ?? sameLeader ?? fallback ?? failures[0] ?? null;
}

function findRecentRootCause(
  row: EventDrivenExecutionRow,
  failureLookup: Map<number, FailureContextRow[]>
): string | null {
  const root = findRecentRootFailureRow(row, failureLookup);
  if (!root) {
    return null;
  }

  const rootCause = formatUnderlyingFailureReasonFromRow(root);

  return rootCause ? `鏈€杩戠湡瀹炲け璐? ${rootCause}` : null;
}

function resolveExecutionErrorCode(
  row: EventDrivenExecutionRow,
  failureLookup: Map<number, FailureContextRow[]>
): string | null {
  const code = row.errorCode?.trim();
  if (!code) {
    return inferLegacyExecutionErrorCode(row.errorMsg);
  }
  if (code === 'unknown_error') {
    return inferLegacyExecutionErrorCode(row.errorMsg) ?? code;
  }
  if (code === 'fail_streak') {
    const root = findRecentRootFailureRow(row, failureLookup);
    const rootCode = root?.errorCode?.trim();
    if (rootCode && rootCode !== 'fail_streak') {
      return rootCode;
    }
  }
  return code;
}

function inferLegacyExecutionErrorCode(error: string | null | undefined): string | null {
  if (!error?.trim()) return null;
  const s = error.trim();
  if (/insufficient polymarket funds/i.test(s) && /no sellable positions/i.test(s)) {
    return 'user_funds_empty';
  }
  if (/copy trading paused/i.test(s) && /fund/i.test(s)) {
    return 'user_funds_empty';
  }
  if (/auto_settled_expired_worthless/i.test(s)) {
    return 'auto_settled_expired_worthless';
  }
  if (/auto_redeemed_estimated/i.test(s)) {
    return 'auto_redeemed_estimated';
  }
  if (/orderbook\s+\d+\s+does not exist/i.test(s) || /orderbook does not exist/i.test(s)) {
    return 'clob_orderbook_missing';
  }
  const m = s.match(/^([a-z][a-z0-9_]{2,64})(?=[:\s|]|$)/i);
  if (m?.[1]) {
    return m[1].toLowerCase();
  }
  return null;
}

function resolveExecutionError(
  row: EventDrivenExecutionRow,
  failureLookup: Map<number, FailureContextRow[]>
): string | null {
  const baseError = formatExecutionError(resolveExecutionErrorCode(row, failureLookup), row.errorMsg);
  const rootCause = findRecentRootCause(row, failureLookup);

  if (baseError && rootCause) {
    return `${baseError} | ${rootCause}`;
  }

  return baseError ?? rootCause;
}

function getExecutionDisplayPrice(row: EventDrivenExecutionRow): string {
  return row.avgPrice ?? row.intendedPrice ?? row.leaderTrade.price;
}

function getExecutionDisplaySize(row: EventDrivenExecutionRow): string {
  return row.filledAmount ?? row.intendedSize ?? row.leaderTrade.amount;
}

function getExecutionDisplayNotional(row: EventDrivenExecutionRow): string | null {
  return row.intendedNotional ?? null;
}

function getExecutionDisplayRatio(row: EventDrivenExecutionRow): string | null {
  if (row.subscription.copyMode === 'FIXED_AMOUNT') {
    return row.subscription.fixedAmountUsd?.toString() ?? null;
  }
  return row.subscription.copyRatio.toString();
}

function settlementResultFromPnl(pnl: string | null | undefined): 'win' | 'loss' | 'flat' | null {
  if (pnl == null) return null;
  const n = Number(pnl);
  if (!Number.isFinite(n)) return null;
  if (n > 0) return 'win';
  if (n < 0) return 'loss';
  return 'flat';
}

function isFilledSellSide(side: string, status: string): boolean {
  return side.trim().toUpperCase() === 'SELL' && status.trim().toLowerCase() === 'filled';
}

function resolveSettlementType(params: {
  leaderAddress: string;
  side: string;
  status: string;
  hasLotCloseDetail: boolean;
  hasRealizedPnl: boolean;
}): ExecutionListItem['settlementType'] {
  const leader = params.leaderAddress.trim().toLowerCase();
  if (leader === 'manual_redeem' || leader === 'auto_redeem') return 'redeem';
  if (leader === 'manual_expired') return 'expired_worthless';
  const isSell = params.side.trim().toUpperCase() === 'SELL';
  if (!isSell) return null;
  if (leader === 'manual_close') return 'market_sell';
  if (params.hasLotCloseDetail || params.hasRealizedPnl) return 'market_sell';
  if (isFilledSellSide(params.side, params.status)) return null;
  return null;
}

function detailFields(detail: ExecutionPnlDetail | undefined): Partial<ExecutionListItem> {
  if (!detail) return {};
  return {
    realizedPnlUsd: detail.realizedPnlUsd,
    entryAvgPrice: detail.entryAvgPrice,
    exitPrice: detail.exitPrice,
    closedSize: detail.closedSize,
    costBasisUsd: detail.costBasisUsd,
    proceedsUsd: detail.proceedsUsd,
    settlementResult: settlementResultFromPnl(detail.realizedPnlUsd),
  };
}

function legacySettlementType(
  leaderAddress: string,
  side: string,
  status: string,
  hasLotCloseDetail = false,
  hasRealizedPnl = false
): ExecutionListItem['settlementType'] {
  return resolveSettlementType({
    leaderAddress,
    side,
    status,
    hasLotCloseDetail,
    hasRealizedPnl,
  });
}

function mapCopyTradeRowToExecutionDto(
  row: EventDrivenExecutionRow,
  failureLookup: Map<number, FailureContextRow[]>,
  realizedPnlLookup?: Map<string, string>,
  pnlDetailLookup?: Map<string, ExecutionPnlDetail>
): ExecutionListItem {
  const lt = row.leaderTrade;
  const key = `copy:${row.id}`;
  const detail = pnlDetailLookup?.get(key);
  const fallbackRealizedPnl = realizedPnlLookup?.get(key) ?? null;
  const rowRealizedPnl =
    row.realizedPnlUsd != null ? row.realizedPnlUsd.toString() : null;
  const side = lt.side;
  const hasRealizedPnl =
    detail?.realizedPnlUsd != null ||
    fallbackRealizedPnl != null ||
    rowRealizedPnl != null;
  return {
    id: row.id,
    leaderAddress: lt.leaderAddress,
    tokenID: lt.tokenId,
    side,
    price: getExecutionDisplayPrice(row),
    size: getExecutionDisplaySize(row),
    ratioApplied: getExecutionDisplayRatio(row),
    notional: getExecutionDisplayNotional(row),
    status: row.status,
    polymarketOrderId: row.polymarketOrderId,
    errorCode: resolveExecutionErrorCode(row, failureLookup),
    error: resolveExecutionError(row, failureLookup),
    realizedPnlUsd: detail?.realizedPnlUsd ?? fallbackRealizedPnl ?? rowRealizedPnl,
    settlementType: resolveSettlementType({
      leaderAddress: lt.leaderAddress,
      side,
      status: row.status,
      hasLotCloseDetail: !!detail,
      hasRealizedPnl,
    }),
    marketLabel: row.marketTitle ?? lt.marketTitle ?? null,
    title: row.marketTitle ?? lt.marketTitle ?? null,
    eventTitle: row.marketTitle ?? lt.marketTitle ?? null,
    question: row.marketTitle ?? lt.marketTitle ?? null,
    outcome: row.outcome ?? lt.outcome ?? null,
    ...detailFields(detail),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapLegacyCopyExecutionToDto(
  e: CopyExecution,
  realizedPnlLookup?: Map<string, string>,
  pnlDetailLookup?: Map<string, ExecutionPnlDetail>
): ExecutionListItem {
  const key = `legacy:${e.id}`;
  const detail = pnlDetailLookup?.get(key);
  const fallbackRealizedPnl = realizedPnlLookup?.get(key) ?? null;
  const hasRealizedPnl = detail?.realizedPnlUsd != null || fallbackRealizedPnl != null;
  const settlementNotional =
    detail?.proceedsUsd != null && detail.proceedsUsd !== ''
      ? detail.proceedsUsd
      : e.notional?.toString() ?? null;
  return {
    id: e.id,
    leaderAddress: e.leaderAddress,
    tokenID: e.tokenID,
    side: e.side,
    price: e.price.toString(),
    size: e.size.toString(),
    ratioApplied: e.ratioApplied?.toString() ?? null,
    notional: settlementNotional,
    status: e.status,
    polymarketOrderId: e.polymarketOrderId,
    errorCode: inferLegacyExecutionErrorCode(e.error),
    error: e.error,
    realizedPnlUsd: detail?.realizedPnlUsd ?? fallbackRealizedPnl,
    settlementType: legacySettlementType(
      e.leaderAddress,
      e.side,
      e.status,
      !!detail,
      hasRealizedPnl
    ),
    ...detailFields(detail),
    createdAt: e.createdAt.toISOString(),
  };
}

function shouldHideLegacyExecutionRow(e: CopyExecution, closeKeys: Set<string> = new Set()): boolean {
  if (
    ['manual_close', 'virtual_manual_close', 'manual_expired', 'manual_redeem', 'auto_redeem'].includes(
      e.leaderAddress
    )
  ) {
    const key = `legacy:${e.id}`;
    if (!closeKeys.has(key)) return true;
  }
  if (e.leaderAddress !== 'manual_redeem' && e.leaderAddress !== 'auto_redeem') return false;
  const notional = Number(e.notional?.toString() ?? 0);
  return Number.isFinite(notional) && notional <= 0;
}

async function loadLegacyLotCloseKeysForRows(userId: number, rows: CopyExecution[]): Promise<Set<string>> {
  const keys = rows
    .filter((e) =>
      ['manual_close', 'virtual_manual_close', 'manual_expired', 'manual_redeem', 'auto_redeem'].includes(
        e.leaderAddress
      )
    )
    .map((e) => `legacy:${e.id}`);
  if (keys.length === 0) return new Set();
  const closeRows = await prisma.copyPositionLotClose.findMany({
    where: {
      userId,
      sellCopyTradeRowId: { in: keys },
    },
    select: { sellCopyTradeRowId: true },
    distinct: ['sellCopyTradeRowId'],
  });
  return new Set(closeRows.map((row) => row.sellCopyTradeRowId));
}

function addExecutionIdToSettledSets(
  rawId: string | null | undefined,
  ids: { copyIds: Set<string>; legacyIds: Set<string> }
): void {
  const id = rawId?.trim();
  if (!id) return;
  if (id.startsWith('legacy:')) {
    const legacyId = id.slice('legacy:'.length).trim();
    if (legacyId) ids.legacyIds.add(legacyId);
    return;
  }
  ids.copyIds.add(id);
}

async function loadSettledExecutionCandidateIdsForUser(
  userId: number,
  take: number
): Promise<{ copyIds: string[]; legacyIds: string[] }> {
  const cap = Math.max(1, Math.min(take, EXECUTIONS_MAX_FETCH_CAP));
  type SettledIdRow = { id: string; settled_at: Date };
  const rows = await prisma.$queryRaw<SettledIdRow[]>`
    SELECT id, settled_at
    FROM (
      SELECT DISTINCT ON (id) id, settled_at
      FROM (
        SELECT "sellCopyTradeRowId" AS id, "createdAt" AS settled_at
        FROM copy_position_lot_closes
        WHERE "userId" = ${userId}
        UNION ALL
        SELECT "buyCopyTradeRowId", "createdAt"
        FROM copy_position_lot_closes
        WHERE "userId" = ${userId}
        UNION ALL
        SELECT id::text, COALESCE("realizedPnlAt", "updatedAt")
        FROM copy_trades
        WHERE "userId" = ${userId} AND "realizedPnlUsd" IS NOT NULL
      ) raw
      WHERE id IS NOT NULL AND btrim(id) <> ''
      ORDER BY id, settled_at DESC
    ) deduped
    ORDER BY settled_at DESC
    LIMIT ${cap}
  `;

  const copyIds: string[] = [];
  const legacyIds: string[] = [];
  for (const row of rows) {
    const id = row.id.trim();
    if (!id) continue;
    if (id.startsWith('legacy:')) {
      const legacyId = id.slice('legacy:'.length).trim();
      if (legacyId) legacyIds.push(legacyId);
      continue;
    }
    copyIds.push(id);
  }

  return { copyIds, legacyIds };
}

function mergeRowsById<T extends { id: string }>(primary: T[], extra: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of [...primary, ...extra]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

type ExecutionStatusFilter = 'all' | 'success' | 'settled' | 'failed';

function isSettledExecutionItem(item: ExecutionListItem): boolean {
  return !!item.settlementType || !!item._lifecycle;
}

function executionMatchesStatusFilter(
  item: ExecutionListItem,
  filter: ExecutionStatusFilter
): boolean {
  if (filter === 'all') return true;
  const settled = isSettledExecutionItem(item);
  if (filter === 'settled') return settled;
  const st = item.status.trim().toLowerCase();
  if (filter === 'success') return st === 'filled' && !settled;
  if (filter === 'failed') {
    if (settled) return false;
    // 列表接口会为 filled 行附加「最近真实失败」说明（error/errorCode），不能据此算作失败
    if (st === 'filled') return false;
    if (st === 'failed' || st === 'dead') return true;
    if (item.error != null && item.error.trim().length > 0) return true;
    if (item.errorCode != null && item.errorCode.trim().length > 0) return true;
    return false;
  }
  return true;
}

function parseFiniteNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canMergeForDisplay(left: EventDrivenExecutionRow, right: EventDrivenExecutionRow): boolean {
  if (left.userId !== right.userId) return false;
  if (left.status !== right.status) return false;
  if ((left.errorCode ?? null) !== (right.errorCode ?? null)) return false;
  if ((left.errorMsg ?? null) !== (right.errorMsg ?? null)) return false;
  if ((left.polymarketOrderId ?? null) !== (right.polymarketOrderId ?? null)) return false;
  if (left.polymarketOrderId || right.polymarketOrderId) return false;
  if (left.leaderTrade.leaderAddress !== right.leaderTrade.leaderAddress) return false;
  if (left.leaderTrade.txHash !== right.leaderTrade.txHash) return false;
  if (left.leaderTrade.side === right.leaderTrade.side) return false;

  const leftPrice = parseFiniteNumber(getExecutionDisplayPrice(left));
  const rightPrice = parseFiniteNumber(getExecutionDisplayPrice(right));
  if (leftPrice === null || rightPrice === null) return false;

  const leftSize = parseFiniteNumber(getExecutionDisplaySize(left));
  const rightSize = parseFiniteNumber(getExecutionDisplaySize(right));
  if (leftSize === null || rightSize === null) return false;
  if (Math.abs(leftSize - rightSize) > 1e-6) return false;

  const createdAtDeltaMs = Math.abs(left.createdAt.getTime() - right.createdAt.getTime());
  if (createdAtDeltaMs > 60_000) return false;

  return Math.abs(leftPrice + rightPrice - 1) <= 0.02;
}

function mergeRowsForDisplay(
  primary: EventDrivenExecutionRow,
  secondary: EventDrivenExecutionRow,
  failureLookup: Map<number, FailureContextRow[]>,
  realizedPnlLookup?: Map<string, string>,
  pnlDetailLookup?: Map<string, ExecutionPnlDetail>
): ExecutionListItem {
  const entries = [primary, secondary].sort((a, b) => {
    const priceDelta = Number(getExecutionDisplayPrice(b)) - Number(getExecutionDisplayPrice(a));
    if (Number.isFinite(priceDelta) && priceDelta !== 0) {
      return priceDelta;
    }
    return a.leaderTrade.logIndex - b.leaderTrade.logIndex;
  });

  const prices = entries.map((entry) => getExecutionDisplayPrice(entry));
  const sides = Array.from(new Set(entries.map((entry) => entry.leaderTrade.side))).sort();
  const tokenCount = new Set(entries.map((entry) => entry.leaderTrade.tokenId)).size;
  const primaryDetail = pnlDetailLookup?.get(`copy:${primary.id}`);
  const secondaryDetail = pnlDetailLookup?.get(`copy:${secondary.id}`);
  const detail = primaryDetail ?? secondaryDetail;

  return {
    id: `${primary.id}:${secondary.id}`,
    leaderAddress: primary.leaderTrade.leaderAddress,
    tokenID: tokenCount > 1 ? `${tokenCount} fills` : primary.leaderTrade.tokenId,
    side: sides.join('/'),
    price: prices.join(' / '),
    size: getExecutionDisplaySize(primary),
    ratioApplied: getExecutionDisplayRatio(primary),
    notional: getExecutionDisplayNotional(primary),
    status: primary.status,
    polymarketOrderId: primary.polymarketOrderId ?? secondary.polymarketOrderId ?? null,
    errorCode: resolveExecutionErrorCode(primary, failureLookup),
    error: resolveExecutionError(primary, failureLookup),
    realizedPnlUsd:
      detail?.realizedPnlUsd ??
      realizedPnlLookup?.get(`copy:${primary.id}`) ??
      realizedPnlLookup?.get(`copy:${secondary.id}`) ??
      null,
    settlementType: resolveSettlementType({
      leaderAddress: primary.leaderTrade.leaderAddress,
      side: sides.includes('SELL') ? 'SELL' : sides[0] ?? primary.leaderTrade.side,
      status: primary.status,
      hasLotCloseDetail: !!detail,
      hasRealizedPnl:
        detail?.realizedPnlUsd != null ||
        realizedPnlLookup?.get(`copy:${primary.id}`) != null ||
        realizedPnlLookup?.get(`copy:${secondary.id}`) != null,
    }),
    ...detailFields(detail),
    createdAt:
      primary.createdAt >= secondary.createdAt
        ? primary.createdAt.toISOString()
        : secondary.createdAt.toISOString(),
  };
}

function collapseEventDrivenRowsForDisplay(
  rows: EventDrivenExecutionRow[],
  failureLookup: Map<number, FailureContextRow[]>,
  realizedPnlLookup?: Map<string, string>,
  pnlDetailLookup?: Map<string, ExecutionPnlDetail>
): ExecutionListItem[] {
  const used = new Set<string>();
  const items: ExecutionListItem[] = [];

  for (let i = 0; i < rows.length; i++) {
    const current = rows[i];
    if (used.has(current.id)) {
      continue;
    }

    let merged = false;
    for (let j = i + 1; j < rows.length; j++) {
      const candidate = rows[j];
      if (used.has(candidate.id)) {
        continue;
      }

      if (!canMergeForDisplay(current, candidate)) {
        continue;
      }

      used.add(current.id);
      used.add(candidate.id);
      items.push(mergeRowsForDisplay(current, candidate, failureLookup, realizedPnlLookup, pnlDetailLookup));
      merged = true;
      break;
    }

    if (!merged) {
      used.add(current.id);
      items.push(mapCopyTradeRowToExecutionDto(current, failureLookup, realizedPnlLookup, pnlDetailLookup));
    }
  }

  return items;
}

function normalizeExecutionCreatedAt(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) {
    return ts;
  }
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

function collapseDuplicateExecutionItems(items: ExecutionListItem[]): ExecutionListItem[] {
  const seen = new Set<string>();
  const out: ExecutionListItem[] = [];

  for (const item of items) {
    const dedupeKey = [
      item.leaderAddress,
      item.tokenID,
      item.side,
      item.price,
      item.size,
      item.status,
      item.polymarketOrderId ?? '',
      item.errorCode ?? '',
      item.error ?? '',
      normalizeExecutionCreatedAt(item.createdAt),
    ].join('|');

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    out.push(item);
  }

  return out;
}

type ExecutionFailureRow = Awaited<
  ReturnType<
    typeof prisma.copyTradeRow.findMany<{
      select: typeof FAILURE_ROW_SELECT;
    }>
  >
>[number];

/** Incremental DB cache for scan loop — avoids re-querying lot links on every batch. */
type ExecutionMaterializeCache = {
  legacyLotCloseKeys: Set<string>;
  lotRemainingByBuyRowId: Map<string, number>;
  lotCloseSellLinksByBuyId: Map<string, LotCloseSellLink[]>;
  lotCloseBuyLinksBySellId: Map<string, LotCloseBuyLink[]>;
  lotCloseDetailsByBuyId: Map<string, BuyLotCloseDetail>;
  loadedLegacyIds: Set<string>;
  loadedBuyRowIdsForRemaining: Set<string>;
  loadedBuyRowIdsForSellLinks: Set<string>;
  loadedExecutionKeysForBuyLinks: Set<string>;
  loadedClosedBuyRowIdsForDetails: Set<string>;
};

function createExecutionMaterializeCache(): ExecutionMaterializeCache {
  return {
    legacyLotCloseKeys: new Set(),
    lotRemainingByBuyRowId: new Map(),
    lotCloseSellLinksByBuyId: new Map(),
    lotCloseBuyLinksBySellId: new Map(),
    lotCloseDetailsByBuyId: new Map(),
    loadedLegacyIds: new Set(),
    loadedBuyRowIdsForRemaining: new Set(),
    loadedBuyRowIdsForSellLinks: new Set(),
    loadedExecutionKeysForBuyLinks: new Set(),
    loadedClosedBuyRowIdsForDetails: new Set(),
  };
}

async function extendExecutionLegacyCache(
  cache: ExecutionMaterializeCache,
  userId: number,
  legacyRows: CopyExecution[]
): Promise<void> {
  const newLegacy = legacyRows.filter((row) => !cache.loadedLegacyIds.has(row.id));
  if (!newLegacy.length) return;

  const keys = await loadLegacyLotCloseKeysForRows(userId, newLegacy);
  for (const key of keys) cache.legacyLotCloseKeys.add(key);
  for (const row of newLegacy) cache.loadedLegacyIds.add(row.id);
}

async function extendExecutionLotLinkageCache(
  cache: ExecutionMaterializeCache,
  userId: number,
  filledBuyRowIds: string[],
  executionKeys: string[]
): Promise<void> {
  const newBuyForRemaining = filledBuyRowIds.filter(
    (id) => !cache.loadedBuyRowIdsForRemaining.has(id)
  );
  if (newBuyForRemaining.length) {
    const remaining = await loadBuyLotRemainingByRowId(userId, newBuyForRemaining);
    for (const [id, rem] of remaining) cache.lotRemainingByBuyRowId.set(id, rem);
    for (const id of newBuyForRemaining) cache.loadedBuyRowIdsForRemaining.add(id);
  }

  const newBuyForSellLinks = filledBuyRowIds.filter(
    (id) => !cache.loadedBuyRowIdsForSellLinks.has(id)
  );
  if (newBuyForSellLinks.length) {
    const sellLinks = await getCopyLotCloseSellLinksForBuyRowIds({
      prismaClient: prisma as any,
      userId,
      buyRowIds: newBuyForSellLinks,
    });
    for (const [id, links] of sellLinks) cache.lotCloseSellLinksByBuyId.set(id, links);
    for (const id of newBuyForSellLinks) cache.loadedBuyRowIdsForSellLinks.add(id);
  }

  const newExecutionKeys = executionKeys.filter(
    (key) => !cache.loadedExecutionKeysForBuyLinks.has(key)
  );
  if (newExecutionKeys.length) {
    const buyLinks = await getCopyLotCloseBuyLinksForExecutionKeys({
      prismaClient: prisma as any,
      userId,
      executionKeys: newExecutionKeys,
    });
    for (const [id, links] of buyLinks) cache.lotCloseBuyLinksBySellId.set(id, links);
    for (const key of newExecutionKeys) cache.loadedExecutionKeysForBuyLinks.add(key);
  }

  const closedBuyRowIds = filledBuyRowIds.filter((id) => {
    const rem = cache.lotRemainingByBuyRowId.get(id);
    if (rem != null && Number.isFinite(rem)) {
      return rem <= COPY_LOT_DUST_SHARES;
    }
    return (cache.lotCloseSellLinksByBuyId.get(id)?.length ?? 0) > 0;
  });
  const newClosedBuyRowIds = closedBuyRowIds.filter(
    (id) => !cache.loadedClosedBuyRowIdsForDetails.has(id)
  );
  if (newClosedBuyRowIds.length) {
    const details = await getCopyLotCloseDetailsForBuyRowIds({
      prismaClient: prisma as any,
      userId,
      buyRowIds: newClosedBuyRowIds,
    });
    for (const [id, detail] of details) cache.lotCloseDetailsByBuyId.set(id, detail);
    for (const id of newClosedBuyRowIds) cache.loadedClosedBuyRowIdsForDetails.add(id);
  }
}

/** Merge raw trade/legacy rows into sorted display rows (lifecycle collapse, lot links). */
async function materializeExecutionDisplayRows(params: {
  userId: number;
  tradeRows: EventDrivenExecutionRow[];
  legacyRows: Awaited<ReturnType<typeof prisma.copyExecution.findMany>>;
  failureRows: ExecutionFailureRow[];
  statusFilter: ExecutionStatusFilter;
  materializeCache?: ExecutionMaterializeCache;
}): Promise<ExecutionListItem[]> {
  const {
    userId,
    tradeRows,
    legacyRows,
    failureRows,
    statusFilter,
    materializeCache,
  } = params;
  const cache = materializeCache ?? createExecutionMaterializeCache();

  const visibleTradeRows = tradeRows.filter((row) => !shouldHideExecutionRow(row));
  const failureLookup = buildRecentFailureLookup(
    failureRows.filter((row) => row.errorCode !== 'ignored_no_position_sell') as FailureContextRow[]
  );

  await extendExecutionLegacyCache(cache, userId, legacyRows as CopyExecution[]);

  const merged: ExecutionListItem[] = collapseDuplicateExecutionItems([
    ...collapseEventDrivenRowsForDisplay(visibleTradeRows, failureLookup),
    ...legacyRows
      .filter((e) => !shouldHideLegacyExecutionRow(e, cache.legacyLotCloseKeys))
      .map((e) => mapLegacyCopyExecutionToDto(e)),
  ]).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const filledBuyRowIds = merged
    .filter(
      (item) =>
        item.side.trim().toUpperCase() === 'BUY' && item.status.trim().toLowerCase() === 'filled'
    )
    .map((item) => item.id);

  const executionKeys = Array.from(
    new Set(merged.flatMap((item) => executionKeysForListItem(item)))
  );
  await extendExecutionLotLinkageCache(cache, userId, filledBuyRowIds, executionKeys);

  const mergedWithLotRemaining: ExecutionListItem[] = merged.map((item) => {
    const lotRem = cache.lotRemainingByBuyRowId.get(item.id);
    const side = item.side.trim().toUpperCase();
    const isSellOnly = side.includes('SELL') && !side.includes('BUY');
    const hasLotCloseLinks =
      isSellOnly && (cache.lotCloseBuyLinksBySellId.get(item.id)?.length ?? 0) > 0;
    return {
      ...item,
      openLotRemaining:
        lotRem != null && Number.isFinite(lotRem)
          ? lotRem.toFixed(8)
          : item.openLotRemaining ?? null,
      // Lot-close evidence → treat as settlement so buy+sell can merge before page PnL hydrate.
      settlementType: item.settlementType ?? (hasLotCloseLinks ? 'market_sell' : null),
    };
  });

  const displayRows = buildDisplayExecutionRows(
    mergedWithLotRemaining,
    cache.lotCloseBuyLinksBySellId,
    cache.lotCloseSellLinksByBuyId,
    cache.lotCloseDetailsByBuyId
  );
  return statusFilter === 'all'
    ? displayRows
    : displayRows.filter((item) => executionMatchesStatusFilter(item, statusFilter));
}

function applyPnlToExecutionItem(
  item: ExecutionListItem,
  pnlDetailLookup: Map<string, ExecutionPnlDetail>,
  realizedPnlLookup: Map<string, string>
): ExecutionListItem {
  for (const key of executionKeysForListItem(item)) {
    const detail = pnlDetailLookup.get(key);
    if (detail) {
      const withDetail = {
        ...item,
        realizedPnlUsd: detail.realizedPnlUsd,
        settlementType:
          item.settlementType ??
          resolveSettlementType({
            leaderAddress: item.leaderAddress,
            side: item.side,
            status: item.status,
            hasLotCloseDetail: true,
            hasRealizedPnl: detail.realizedPnlUsd != null,
          }),
        ...detailFields(detail),
      };
      if (detail.closedSize && Number(detail.closedSize) > 0) {
        return { ...withDetail, size: detail.closedSize };
      }
      return withDetail;
    }
  }
  for (const key of executionKeysForListItem(item)) {
    const realized = realizedPnlLookup.get(key);
    if (realized != null) {
      return {
        ...item,
        realizedPnlUsd: realized,
        settlementResult: settlementResultFromPnl(realized),
        settlementType:
          item.settlementType ??
          resolveSettlementType({
            leaderAddress: item.leaderAddress,
            side: item.side,
            status: item.status,
            hasLotCloseDetail: false,
            hasRealizedPnl: true,
          }),
      };
    }
  }
  return item;
}

async function loadExecutionPnlLookupsForItems(
  userId: number,
  items: ExecutionListItem[]
): Promise<{
  pnlDetailLookup: Map<string, ExecutionPnlDetail>;
  realizedPnlLookup: Map<string, string>;
}> {
  if (!items.length) {
    return { pnlDetailLookup: new Map(), realizedPnlLookup: new Map() };
  }
  const executionKeys = Array.from(new Set(items.flatMap((item) => executionKeysForListItem(item))));
  const copyIds = executionKeys
    .filter((key) => key.startsWith('copy:'))
    .map((key) => key.slice('copy:'.length));

  const [pnlDetailLookup, copyRowsWithPnl] = await Promise.all([
    getCopyLotCloseDetailsForExecutionKeys({
      prismaClient: prisma as any,
      userId,
      executionKeys,
    }),
    copyIds.length
      ? prisma.copyTradeRow.findMany({
          where: { userId, id: { in: copyIds }, realizedPnlUsd: { not: null } },
          select: { id: true, realizedPnlUsd: true },
        })
      : Promise.resolve([]),
  ]);

  const realizedPnlLookup = new Map<string, string>();
  for (const row of copyRowsWithPnl) {
    if (row.realizedPnlUsd != null) {
      realizedPnlLookup.set(`copy:${row.id}`, row.realizedPnlUsd.toString());
    }
  }

  return { pnlDetailLookup, realizedPnlLookup };
}

function executionKeysForListItem(item: ExecutionListItem): string[] {
  if (item.id.includes(':')) {
    return item.id.split(':').map((part) => `copy:${part}`);
  }
  return [`copy:${item.id}`, `legacy:${item.id}`];
}

/** 当前页 + lifecycle 子行，供分页后批量查盈亏。 */
function collectItemsForPnlLookup(items: ExecutionListItem[]): ExecutionListItem[] {
  const seen = new Set<string>();
  const out: ExecutionListItem[] = [];
  const add = (item: ExecutionListItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };
  for (const item of items) {
    add(item);
    if (item._lifecycle?.buy) add(item._lifecycle.buy);
    if (item._lifecycle?.settlement) add(item._lifecycle.settlement);
  }
  return out;
}

function applyPnlToExecutionItemWithLifecycle(
  item: ExecutionListItem,
  pnlDetailLookup: Map<string, ExecutionPnlDetail>,
  realizedPnlLookup: Map<string, string>
): ExecutionListItem {
  const next = applyPnlToExecutionItem(item, pnlDetailLookup, realizedPnlLookup);
  if (!next._lifecycle) return next;
  const buyCentricSynthetic = next.id === next._lifecycle.buy.id;
  return {
    ...next,
    _lifecycle: {
      buy: applyPnlToExecutionItem(next._lifecycle.buy, pnlDetailLookup, realizedPnlLookup),
      // Buy-centric cards already have per-buy lot-close amounts on settlement.
      // Re-applying sell-keyed lookup would stamp merged multi-buy totals onto a single order.
      settlement: buyCentricSynthetic
        ? next._lifecycle.settlement
        : applyPnlToExecutionItem(
            next._lifecycle.settlement,
            pnlDetailLookup,
            realizedPnlLookup
          ),
    },
  };
}

function parseExecutionRequestIds(requestId: string): { copyIds: string[]; legacyIds: string[] } {
  const trimmed = requestId.trim();
  if (!trimmed) return { copyIds: [], legacyIds: [] };
  if (trimmed.includes(':')) {
    return {
      copyIds: trimmed
        .split(':')
        .map((part) => part.trim())
        .filter(Boolean),
      legacyIds: [],
    };
  }
  return { copyIds: [trimmed], legacyIds: [trimmed] };
}

function findExecutionDisplayItemByRequestId(
  items: ExecutionListItem[],
  requestId: string
): ExecutionListItem | null {
  const trimmed = requestId.trim();
  for (const item of items) {
    if (item.id === trimmed) return item;
    if (item._lifecycle?.buy.id === trimmed) return item;
    if (item._lifecycle?.settlement.id === trimmed) return item;
  }
  return null;
}

async function expandExecutionRowsForDetail(
  userId: number,
  tradeRows: EventDrivenExecutionRow[],
  legacyRows: Awaited<ReturnType<typeof prisma.copyExecution.findMany>>
): Promise<{
  tradeRows: EventDrivenExecutionRow[];
  legacyRows: Awaited<ReturnType<typeof prisma.copyExecution.findMany>>;
}> {
  const knownCopyIds = new Set(tradeRows.map((row) => row.id));
  const knownLegacyIds = new Set(legacyRows.map((row) => row.id));

  const isSell = (side: string) => {
    const s = side.trim().toUpperCase();
    return s.includes('SELL') && !s.includes('BUY');
  };
  const isBuy = (side: string) => {
    const s = side.trim().toUpperCase();
    return s.includes('BUY') && !s.includes('SELL');
  };

  const sellIds = [
    ...tradeRows.filter((row) => isSell(row.leaderTrade.side)).map((row) => row.id),
    ...legacyRows.filter((row) => isSell(row.side)).map((row) => row.id),
  ];
  const buyIds = [
    ...tradeRows.filter((row) => isBuy(row.leaderTrade.side)).map((row) => row.id),
    ...legacyRows.filter((row) => isBuy(row.side)).map((row) => row.id),
  ];

  const relatedIds = new Set<string>();
  if (sellIds.length || buyIds.length) {
    const [sellLinksBySellId, buyLinksByBuyId] = await Promise.all([
      sellIds.length
        ? getCopyLotCloseBuyLinksForExecutionKeys({
            prismaClient: prisma as any,
            userId,
            executionKeys: sellIds.flatMap((id) => [id, `legacy:${id}`]),
          })
        : Promise.resolve(new Map()),
      buyIds.length
        ? getCopyLotCloseSellLinksForBuyRowIds({
            prismaClient: prisma as any,
            userId,
            buyRowIds: buyIds,
          })
        : Promise.resolve(new Map()),
    ]);

    for (const sellId of sellIds) {
      for (const link of sellLinksBySellId.get(sellId) ?? []) {
        relatedIds.add(link.buyRowId);
      }
    }
    for (const buyId of buyIds) {
      for (const link of buyLinksByBuyId.get(buyId) ?? []) {
        relatedIds.add(link.sellRowId);
      }
    }
  }

  for (const id of knownCopyIds) relatedIds.delete(id);
  for (const id of knownLegacyIds) relatedIds.delete(id);

  if (!relatedIds.size) {
    return { tradeRows, legacyRows };
  }

  const relatedIdList = [...relatedIds];
  const [extraTradeRows, extraLegacyRows] = await Promise.all([
    fetchCopyTradeExecutionRows({
      where: { userId, id: { in: relatedIdList } },
      take: relatedIdList.length,
      useLeaderJoin: false,
    }),
    prisma.copyExecution.findMany({
      where: { followerUserId: userId, id: { in: relatedIdList } },
      select: LEGACY_EXECUTION_SELECT,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return {
    tradeRows: mergeRowsById(tradeRows, extraTradeRows),
    legacyRows: mergeRowsById(legacyRows, extraLegacyRows),
  };
}

async function loadExecutionDisplayItemForUser(
  userId: number,
  requestId: string
): Promise<ExecutionListItem | null> {
  const { copyIds, legacyIds } = parseExecutionRequestIds(requestId);
  if (!copyIds.length && !legacyIds.length) return null;

  let tradeRows: EventDrivenExecutionRow[] = copyIds.length
    ? await fetchCopyTradeExecutionRows({
        where: { userId, id: { in: copyIds } },
        take: copyIds.length,
        useLeaderJoin: false,
      })
    : [];
  let legacyRows = legacyIds.length
    ? await prisma.copyExecution.findMany({
        where: { followerUserId: userId, id: { in: legacyIds } },
        select: LEGACY_EXECUTION_SELECT,
        orderBy: { createdAt: 'desc' },
      })
    : [];

  if (!tradeRows.length && !legacyRows.length) return null;

  ({ tradeRows, legacyRows } = await expandExecutionRowsForDetail(userId, tradeRows, legacyRows));

  const displayRows = await materializeExecutionDisplayRows({
    userId,
    tradeRows,
    legacyRows,
    failureRows: [],
    statusFilter: 'all',
  });
  const { pnlDetailLookup, realizedPnlLookup } = await loadExecutionPnlLookupsForItems(
    userId,
    collectItemsForPnlLookup(displayRows)
  );
  const withPnl = displayRows.map((item) =>
    applyPnlToExecutionItemWithLifecycle(item, pnlDetailLookup, realizedPnlLookup)
  );
  return findExecutionDisplayItemByRequestId(withPnl, requestId);
}

function resolveBuyExecutionRowIdForDetail(
  item: ExecutionListItem,
  requestId: string
): string | null {
  const trimmed = requestId.trim();
  if (item._lifecycle?.buy.id === trimmed) return trimmed;
  const side = item.side.trim().toUpperCase();
  if (item.id === trimmed && side.includes('BUY') && !side.includes('SELL')) return trimmed;
  return null;
}

function candidateSellRowIdsForDetail(
  requestId: string,
  item?: ExecutionListItem | null
): string[] {
  return Array.from(
    new Set(
      [requestId, item?.id, item?._lifecycle?.settlement.id]
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .flatMap((id) => {
          const bare = bareExecutionRowId(id);
          return bare ? [bare, `legacy:${bare}`] : [];
        })
    )
  );
}

async function resolveBuyRowIdsFromLotClose(
  userId: number,
  requestId: string,
  item?: ExecutionListItem | null
): Promise<string[]> {
  const candidateSellIds = candidateSellRowIdsForDetail(requestId, item);
  if (!candidateSellIds.length) return [];

  const closes = await prisma.copyPositionLotClose.findMany({
    where: { userId, sellCopyTradeRowId: { in: candidateSellIds } },
    select: { buyCopyTradeRowId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const buyIds: string[] = [];
  const seen = new Set<string>();
  for (const close of closes) {
    const buyRowId = bareExecutionRowId(close.buyCopyTradeRowId?.trim() ?? '');
    if (!buyRowId || seen.has(buyRowId)) continue;
    seen.add(buyRowId);
    buyIds.push(buyRowId);
  }
  return buyIds;
}

/**
 * Folded buy ids (multi-buy / unpaired lifecycle) disappear from display merge.
 * Resolve the primary settlement row so detail can open via the buy deep-link.
 */
async function resolvePrimarySellRowIdForBuyRequest(
  userId: number,
  buyRequestId: string
): Promise<string | null> {
  const buyId = bareExecutionRowId(buyRequestId);
  if (!buyId) return null;

  const details = await getCopyLotCloseDetailsForBuyRowIds({
    prismaClient: prisma as any,
    userId,
    buyRowIds: [buyId],
  });
  const detail = details.get(buyId);
  if (detail?.primarySellRowId) {
    return bareExecutionRowId(detail.primarySellRowId);
  }

  const sellLinks = await getCopyLotCloseSellLinksForBuyRowIds({
    prismaClient: prisma as any,
    userId,
    buyRowIds: [buyId],
  });
  const links = sellLinks.get(buyId) ?? [];
  if (!links.length) return null;
  let best = links[0]!;
  for (const link of links) {
    if (link.closedSize > best.closedSize) best = link;
  }
  return bareExecutionRowId(best.sellRowId);
}

/** Load execution DTOs by id without lifecycle fold (multi-buy buys are hidden in display merge). */
async function loadRawExecutionListItemsByIds(
  userId: number,
  ids: string[]
): Promise<Map<string, ExecutionListItem>> {
  const bareIds = Array.from(
    new Set(ids.map((id) => bareExecutionRowId(id)).filter((id) => id.length > 0))
  );
  const out = new Map<string, ExecutionListItem>();
  if (!bareIds.length) return out;

  const [tradeRows, legacyRows] = await Promise.all([
    fetchCopyTradeExecutionRows({
      where: { userId, id: { in: bareIds } },
      take: bareIds.length,
      useLeaderJoin: false,
    }),
    prisma.copyExecution.findMany({
      where: { followerUserId: userId, id: { in: bareIds } },
      select: LEGACY_EXECUTION_SELECT,
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const failureLookup = new Map<number, FailureContextRow[]>();
  for (const row of tradeRows) {
    out.set(row.id, mapCopyTradeRowToExecutionDto(row, failureLookup));
  }
  for (const row of legacyRows) {
    if (!out.has(row.id)) {
      out.set(row.id, mapLegacyCopyExecutionToDto(row as CopyExecution));
    }
  }
  return out;
}

function attachBuyLegsToSettlementItem(
  settlement: ExecutionListItem,
  buys: ExecutionListItem[]
): ExecutionListItem {
  if (!buys.length) return settlement;
  const sorted = [...buys].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
  const settlementSnapshot: ExecutionListItem = { ...settlement, _lifecycle: undefined };
  return {
    ...settlement,
    _lifecycle: {
      buy: sorted[0]!,
      buys: sorted,
      settlement: settlementSnapshot,
    },
  };
}

/**
 * Build timeline buy legs from lot-close ledger.
 * Prefers live buy execution rows; synthesizes from entryPrice/lot.createdAt when folded/missing.
 */
async function loadSettlementBuyLegsForTimeline(
  userId: number,
  requestId: string,
  item?: ExecutionListItem | null
): Promise<ExecutionListItem[]> {
  let sellIds = candidateSellRowIdsForDetail(requestId, item);
  let closes = sellIds.length
    ? await prisma.copyPositionLotClose.findMany({
        where: { userId, sellCopyTradeRowId: { in: sellIds } },
        select: {
          buyCopyTradeRowId: true,
          lotId: true,
          closedSize: true,
          entryPrice: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  // Request may be a folded buy id — resolve its sell then reload closes.
  if (!closes.length) {
    const sellId = await resolvePrimarySellRowIdForBuyRequest(userId, requestId);
    if (sellId) {
      sellIds = candidateSellRowIdsForDetail(sellId, null);
      closes = await prisma.copyPositionLotClose.findMany({
        where: { userId, sellCopyTradeRowId: { in: sellIds } },
        select: {
          buyCopyTradeRowId: true,
          lotId: true,
          closedSize: true,
          entryPrice: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    }
  }

  if (!closes.length) return [];

  type Acc = {
    buyRowId: string;
    closedSize: number;
    costBasis: number;
    lotIds: string[];
    firstCloseAt: Date;
  };
  const byBuy = new Map<string, Acc>();
  for (const close of closes) {
    const buyRowId = bareExecutionRowId(close.buyCopyTradeRowId?.trim() ?? '');
    if (!buyRowId) continue;
    const closedSize = Number(close.closedSize);
    const entryPrice = Number(close.entryPrice);
    if (!(closedSize > 0) || !Number.isFinite(closedSize)) continue;
    const prev = byBuy.get(buyRowId) ?? {
      buyRowId,
      closedSize: 0,
      costBasis: 0,
      lotIds: [],
      firstCloseAt: close.createdAt,
    };
    prev.closedSize += closedSize;
    if (Number.isFinite(entryPrice)) prev.costBasis += closedSize * entryPrice;
    if (close.lotId) prev.lotIds.push(close.lotId);
    if (close.createdAt < prev.firstCloseAt) prev.firstCloseAt = close.createdAt;
    byBuy.set(buyRowId, prev);
  }

  const buyRowIds = Array.from(byBuy.keys());
  if (!buyRowIds.length) return [];

  const lotIds = Array.from(
    new Set(Array.from(byBuy.values()).flatMap((acc) => acc.lotIds))
  );
  const [rawBuys, lots] = await Promise.all([
    loadRawExecutionListItemsByIds(userId, buyRowIds),
    lotIds.length
      ? prisma.copyPositionLot.findMany({
          where: { userId, id: { in: lotIds } },
          select: { id: true, createdAt: true, entryPrice: true, buyCopyTradeRowId: true },
        })
      : Promise.resolve([]),
  ]);

  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const fallback = item ?? Array.from(rawBuys.values())[0] ?? null;
  const legs: ExecutionListItem[] = [];

  for (const acc of byBuy.values()) {
    const raw = rawBuys.get(acc.buyRowId);
    if (raw) {
      legs.push({
        ...raw,
        // Prefer closed size for this settlement when buy was only partially closed here.
        size:
          acc.closedSize > 0
            ? new Prisma.Decimal(acc.closedSize.toFixed(8)).toString()
            : raw.size,
      });
      continue;
    }

    let entryAt = acc.firstCloseAt;
    let entryPrice =
      acc.closedSize > 0 && acc.costBasis > 0 ? acc.costBasis / acc.closedSize : NaN;
    for (const lotId of acc.lotIds) {
      const lot = lotById.get(lotId);
      if (!lot) continue;
      if (lot.createdAt < entryAt) entryAt = lot.createdAt;
      const lotPrice = Number(lot.entryPrice);
      if (!Number.isFinite(entryPrice) && Number.isFinite(lotPrice)) {
        entryPrice = lotPrice;
      }
    }

    legs.push({
      id: acc.buyRowId,
      leaderAddress: fallback?.leaderAddress ?? 'unknown',
      tokenID: fallback?.tokenID ?? '',
      side: 'BUY',
      price: Number.isFinite(entryPrice)
        ? new Prisma.Decimal(entryPrice.toFixed(8)).toString()
        : '0',
      size: new Prisma.Decimal(acc.closedSize.toFixed(8)).toString(),
      status: 'filled',
      createdAt: entryAt.toISOString(),
      marketLabel: fallback?.marketLabel ?? null,
      title: fallback?.title ?? null,
      eventTitle: fallback?.eventTitle ?? null,
      question: fallback?.question ?? null,
      outcome: fallback?.outcome ?? null,
    });
  }

  return legs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Rebuild settled detail with buy+settlement lifecycle when list merge dropped `_lifecycle`. */
async function hydrateSettledDetailWithBuyLifecycle(
  userId: number,
  requestId: string,
  item: ExecutionListItem | null
): Promise<{ item: ExecutionListItem; viewState: ExecutionDetailViewState } | null> {
  // Prefer attaching buy legs onto the existing settlement card (keeps merged multi-buy totals).
  if (item) {
    const buys = await loadSettlementBuyLegsForTimeline(userId, requestId, item);
    if (buys.length) {
      return {
        item: attachBuyLegsToSettlementItem(item, buys),
        viewState: 'settled',
      };
    }
  }

  const fromDetail =
    item ? resolveBuyExecutionRowIdForDetail(item, requestId) : null;
  const fromLifecycle = item?._lifecycle?.buy.id
    ? bareExecutionRowId(item._lifecycle.buy.id)
    : null;
  let fromLotClose = await resolveBuyRowIdsFromLotClose(userId, requestId, item);

  // Deep-link may be a folded buy id — lot-close lookup by sell id misses; treat request as buy.
  if (!fromLotClose.length && !fromDetail && !fromLifecycle) {
    const requestBuyId = bareExecutionRowId(requestId);
    if (requestBuyId) {
      const buyDetails = await getCopyLotCloseDetailsForBuyRowIds({
        prismaClient: prisma as any,
        userId,
        buyRowIds: [requestBuyId],
      });
      if (buyDetails.has(requestBuyId)) {
        const sellId = bareExecutionRowId(
          buyDetails.get(requestBuyId)!.primarySellRowId
        );
        fromLotClose = sellId
          ? await resolveBuyRowIdsFromLotClose(userId, sellId, null)
          : [requestBuyId];
        if (!fromLotClose.length) fromLotClose = [requestBuyId];

        // Prefer the merged settlement card when one sell closed multiple buys.
        if (!item && sellId) {
          const sellItem = await loadExecutionDisplayItemForUser(userId, sellId);
          if (sellItem) {
            const buys = await loadSettlementBuyLegsForTimeline(userId, sellId, sellItem);
            if (buys.length) {
              return {
                item: attachBuyLegsToSettlementItem(sellItem, buys),
                viewState: 'settled',
              };
            }
            return hydrateSettledDetailWithBuyLifecycle(userId, sellId, sellItem);
          }
        }
      }
    }
  }

  const buyRowIds = Array.from(
    new Set(
      [fromDetail, fromLifecycle, ...fromLotClose].filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0
      )
    )
  );
  if (!buyRowIds.length) {
    // Last resort: synthesize legs even when item was null (buy deep-link).
    const buys = await loadSettlementBuyLegsForTimeline(userId, requestId, item);
    if (buys.length && item) {
      return {
        item: attachBuyLegsToSettlementItem(item, buys),
        viewState: 'settled',
      };
    }
    return null;
  }

  const buyRowId = buyRowIds[0]!;
  const lotDetails = await getCopyLotCloseDetailsForBuyRowIds({
    prismaClient: prisma as any,
    userId,
    buyRowIds: [buyRowId],
  });
  const detail = lotDetails.get(buyRowId);
  if (!detail) {
    const buys = await loadSettlementBuyLegsForTimeline(userId, requestId, item);
    if (buys.length && item) {
      return {
        item: attachBuyLegsToSettlementItem(item, buys),
        viewState: 'settled',
      };
    }
    return null;
  }

  let buyRow: ExecutionListItem | null = null;
  if (item?._lifecycle?.buy && bareExecutionRowId(item._lifecycle.buy.id) === buyRowId) {
    buyRow = item._lifecycle.buy;
  } else if (item) {
    const side = item.side.trim().toUpperCase();
    if (item.id === buyRowId && side.includes('BUY') && !side.includes('SELL')) {
      buyRow = item;
    }
  }
  if (!buyRow) {
    const buyItem = await loadExecutionDisplayItemForUser(userId, buyRowId);
    if (buyItem) {
      buyRow = (buyItem._lifecycle?.buy ?? buyItem) as ExecutionListItem;
    }
  }
  // Display fold hides multi-covered / unpaired buys — fall back to raw / synthesized legs.
  if (!buyRow) {
    buyRow = (await loadRawExecutionListItemsByIds(userId, [buyRowId])).get(buyRowId) ?? null;
  }
  if (!buyRow) {
    const buys = await loadSettlementBuyLegsForTimeline(userId, requestId, item);
    buyRow = buys.find((b) => b.id === buyRowId) ?? buys[0] ?? null;
  }
  if (!buyRow) return null;

  // When we already have the settlement card, keep its merged totals and only attach legs.
  if (item) {
    const buys = await loadSettlementBuyLegsForTimeline(userId, requestId, item);
    if (buys.length) {
      return {
        item: attachBuyLegsToSettlementItem(item, buys),
        viewState: 'settled',
      };
    }
  }

  const settledItem = buildSettledDisplayFromClosedBuy(
    buyRow.id === buyRowId ? buyRow : ({ ...buyRow, id: buyRowId } as ExecutionListItem),
    detail
  );
  return { item: settledItem, viewState: 'settled' };
}

/** Detail view: open buy, settled lifecycle, or lot-close fallback after manual close. */
async function resolveExecutionDetailPayload(
  userId: number,
  requestId: string
): Promise<{ item: ExecutionListItem; viewState: ExecutionDetailViewState } | null> {
  let item = await loadExecutionDisplayItemForUser(userId, requestId);

  // Multi-buy / unpaired settles fold buys out of display — buy deep-links 404 without this.
  if (!item) {
    const sellId = await resolvePrimarySellRowIdForBuyRequest(userId, requestId);
    if (sellId && sellId !== bareExecutionRowId(requestId)) {
      item = await loadExecutionDisplayItemForUser(userId, sellId);
    }
  }

  if (item) {
    const viewState = resolveExecutionDetailViewState(item);
    if (viewState === 'open') return { item, viewState };
    if (viewState === 'settled') {
      // Always hydrate buy legs for timeline (multi-buy merge omits `_lifecycle`;
      // single-buy may omit it on share dust; existing `_lifecycle.buy` alone is not enough
      // when one sell closed multiple entries).
      const hydrated = await hydrateSettledDetailWithBuyLifecycle(userId, requestId, item);
      if (hydrated) return hydrated;
      return { item, viewState };
    }
  }

  return hydrateSettledDetailWithBuyLifecycle(userId, requestId, item);
}

function applyMarketMetadataToExecutionItem(
  item: ExecutionListItem,
  metadata?: PolymarketTokenMarketMetadata
): ExecutionListItem {
  const withFlag = { ...item, canViewDetail: isExecutionDetailViewable(item) };
  if (!metadata) return withFlag;
  return {
    ...withFlag,
    marketLabel:
      metadata.eventTitle ??
      metadata.title ??
      metadata.question ??
      metadata.marketLabel ??
      item.marketLabel ??
      item.title ??
      item.question ??
      null,
    title: metadata.title ?? item.title ?? null,
    eventTitle: metadata.eventTitle ?? item.eventTitle ?? null,
    question: metadata.question ?? item.question ?? null,
    outcome: metadata.outcome ?? item.outcome ?? null,
  };
}

async function loadOpenLotsForExecutionDetail(
  userId: number,
  buyCopyTradeRowId: string
): Promise<
  Array<{
    id: string;
    entryPrice: string;
    entrySize: string;
    remainingSize: string;
    entryNotional: string;
    createdAt: string;
  }>
> {
  const rows = await prisma.copyPositionLot.findMany({
    where: {
      userId,
      buyCopyTradeRowId,
      remainingSize: { gt: new Prisma.Decimal(0) },
    },
    select: {
      id: true,
      entryPrice: true,
      entrySize: true,
      remainingSize: true,
      entryNotional: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    entryPrice: row.entryPrice.toString(),
    entrySize: row.entrySize.toString(),
    remainingSize: row.remainingSize.toString(),
    entryNotional: row.entryNotional.toString(),
    createdAt: row.createdAt.toISOString(),
  }));
}

async function loadExecutionDetailSubscription(
  userId: number,
  subscriptionId: string | null | undefined
) {
  if (!subscriptionId) return null;
  const sub = await prisma.copySubscription.findFirst({
    where: { id: subscriptionId, userId, deletedAt: null },
    select: {
      id: true,
      ruleName: true,
      note: true,
      leader: { select: { address: true, label: true } },
    },
  });
  if (!sub) return null;
  return {
    subscriptionId: sub.id,
    ruleName: sub.ruleName?.trim() || null,
    note: sub.note?.trim() || null,
    subscriptionLabel:
      sub.ruleName?.trim() || sub.note?.trim() || sub.leader.label?.trim() || null,
    leaderAddress: sub.leader.address,
    leaderLabel: sub.leader.label?.trim() || null,
  };
}

function bareExecutionRowId(rowId: string): string {
  const trimmed = rowId.trim();
  if (trimmed.startsWith('legacy:')) return trimmed.slice('legacy:'.length);
  if (trimmed.startsWith('copy:')) return trimmed.slice('copy:'.length);
  return trimmed;
}

/** Batch-resolve sentinel settlement leaders from lot closes (buy may be outside the list scan window). */
async function resolveLeaderAddressesFromLotClosesForItems(
  userId: number,
  items: ExecutionListItem[]
): Promise<Map<string, string>> {
  const sentinelItems = items.filter((item) =>
    SETTLEMENT_SENTINEL_LEADER_ADDRESSES.has(item.leaderAddress.trim().toLowerCase())
  );
  if (!sentinelItems.length) return new Map();

  const sellIds = Array.from(
    new Set(
      sentinelItems.flatMap((item) => {
        const ids = [item.id, item._lifecycle?.settlement.id].filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0
        );
        return ids.flatMap((id) => {
          const bare = bareExecutionRowId(id);
          return bare ? [bare, `legacy:${bare}`] : [];
        });
      })
    )
  );
  if (!sellIds.length) return new Map();

  const closes = await prisma.copyPositionLotClose.findMany({
    where: { userId, sellCopyTradeRowId: { in: sellIds } },
    select: { sellCopyTradeRowId: true, buyCopyTradeRowId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!closes.length) return new Map();

  const buyIdsBySellListId = new Map<string, string[]>();
  for (const close of closes) {
    const sellListId = bareExecutionRowId(close.sellCopyTradeRowId);
    if (!sellListId) continue;
    const list = buyIdsBySellListId.get(sellListId) ?? [];
    list.push(close.buyCopyTradeRowId);
    buyIdsBySellListId.set(sellListId, list);
  }

  const allBuyKeys = Array.from(
    new Set(
      closes.flatMap((close) => {
        const id = close.buyCopyTradeRowId.trim();
        if (!id) return [];
        if (id.startsWith('legacy:')) return [id];
        return [id, `legacy:${id}`];
      })
    )
  );
  if (!allBuyKeys.length) return new Map();

  const lots = await prisma.copyPositionLot.findMany({
    where: { userId, buyCopyTradeRowId: { in: allBuyKeys } },
    select: { buyCopyTradeRowId: true, leaderAddress: true },
    orderBy: { createdAt: 'desc' },
  });

  const leaderByBuyKey = new Map<string, string>();
  for (const lot of lots) {
    const addr = lot.leaderAddress?.trim() ?? '';
    if (!addr || SETTLEMENT_SENTINEL_LEADER_ADDRESSES.has(addr.toLowerCase())) continue;
    const buyKey = lot.buyCopyTradeRowId;
    const bare = bareExecutionRowId(buyKey);
    if (!leaderByBuyKey.has(buyKey)) leaderByBuyKey.set(buyKey, addr);
    if (bare && !leaderByBuyKey.has(bare)) leaderByBuyKey.set(bare, addr);
  }

  const out = new Map<string, string>();
  for (const item of sentinelItems) {
    const buyIds = buyIdsBySellListId.get(bareExecutionRowId(item.id)) ?? [];
    for (const buyId of buyIds) {
      const addr = leaderByBuyKey.get(buyId) ?? leaderByBuyKey.get(bareExecutionRowId(buyId));
      if (addr) {
        out.set(item.id, addr);
        break;
      }
    }
  }
  return out;
}

async function resolveLeaderAddressFromLotCloses(
  userId: number,
  requestId: string,
  item?: ExecutionListItem | null
): Promise<string | null> {
  const { copyIds, legacyIds } = parseExecutionRequestIds(requestId);
  const sellIds = Array.from(
    new Set(
      [...legacyIds, ...copyIds, item?.id, item?._lifecycle?.settlement.id]
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .flatMap((id) => [id, `legacy:${id}`])
    )
  );
  if (!sellIds.length) return null;

  const close = await prisma.copyPositionLotClose.findFirst({
    where: { userId, sellCopyTradeRowId: { in: sellIds } },
    select: { buyCopyTradeRowId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!close?.buyCopyTradeRowId) return null;

  const buyKeys = close.buyCopyTradeRowId.startsWith('legacy:')
    ? [close.buyCopyTradeRowId]
    : [close.buyCopyTradeRowId, `legacy:${close.buyCopyTradeRowId}`];

  const lot = await prisma.copyPositionLot.findFirst({
    where: { userId, buyCopyTradeRowId: { in: buyKeys } },
    select: { leaderAddress: true },
    orderBy: { createdAt: 'desc' },
  });
  const addr = lot?.leaderAddress?.trim() ?? '';
  if (!addr || SETTLEMENT_SENTINEL_LEADER_ADDRESSES.has(addr.toLowerCase())) return null;
  return addr;
}

async function resolveCopyTradeSubscriptionIdForDetail(
  userId: number,
  requestId: string,
  item?: ExecutionListItem | null
): Promise<string | null> {
  const { copyIds, legacyIds } = parseExecutionRequestIds(requestId);
  const candidateIds = Array.from(
    new Set(
      [
        ...copyIds,
        item?._lifecycle?.buy.id,
        item?.id,
      ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    )
  );

  if (candidateIds.length) {
    const row = await prisma.copyTradeRow.findFirst({
      where: { userId, id: { in: candidateIds } },
      select: { subscriptionId: true },
      orderBy: { createdAt: 'desc' },
    });
    if (row?.subscriptionId) return row.subscriptionId;
  }

  const sellIds = Array.from(
    new Set(
      [...legacyIds, ...copyIds, item?.id, item?._lifecycle?.settlement.id]
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .flatMap((id) => [id, `legacy:${id}`])
    )
  );
  if (!sellIds.length) return null;

  const close = await prisma.copyPositionLotClose.findFirst({
    where: { userId, sellCopyTradeRowId: { in: sellIds } },
    select: { buyCopyTradeRowId: true },
    orderBy: { createdAt: 'asc' },
  });
  const buyRowId = close?.buyCopyTradeRowId?.startsWith('legacy:')
    ? close.buyCopyTradeRowId.slice('legacy:'.length)
    : close?.buyCopyTradeRowId;
  if (!buyRowId) return null;

  const buyRow = await prisma.copyTradeRow.findFirst({
    where: { userId, id: buyRowId },
    select: { subscriptionId: true },
  });
  if (buyRow?.subscriptionId) return buyRow.subscriptionId;

  const lot = await prisma.copyPositionLot.findFirst({
    where: { userId, buyCopyTradeRowId: { in: [buyRowId, `legacy:${buyRowId}`] } },
    select: { subscriptionId: true },
    orderBy: { createdAt: 'desc' },
  });
  return lot?.subscriptionId ?? null;
}

function buildCopyTradeStatusWhere(
  statusFilter: ExecutionStatusFilter
): Prisma.CopyTradeRowWhereInput['status'] | undefined {
  if (statusFilter === 'success' || statusFilter === 'settled') {
    return CopyTradeStatus.filled;
  }
  if (statusFilter === 'failed') {
    return { in: [CopyTradeStatus.failed, CopyTradeStatus.dead] };
  }
  return undefined;
}

function buildLegacyStatusWhere(
  statusFilter: ExecutionStatusFilter
): Prisma.CopyExecutionWhereInput['status'] | undefined {
  if (statusFilter === 'success' || statusFilter === 'settled') {
    return { in: ['filled', 'Filled', 'FILLED'] };
  }
  if (statusFilter === 'failed') {
    return { notIn: ['filled', 'Filled', 'FILLED'] };
  }
  return undefined;
}

type ExecutionListScanFilters = {
  statusFilter: ExecutionStatusFilter;
  subscriptionIdFilter?: string;
  resolvedLeaderLower?: string;
  includeLegacy: boolean;
};

type ExecutionListTotalCacheEntry = {
  total: number;
  truncated: boolean;
  cachedAt: number;
};

const executionListTotalCache = new Map<string, ExecutionListTotalCacheEntry>();
const executionListTotalWarmInFlight = new Set<string>();

function executionListTotalCacheKey(userId: number, filters: ExecutionListScanFilters): string {
  return [
    userId,
    filters.statusFilter,
    filters.subscriptionIdFilter ?? '',
    filters.resolvedLeaderLower ?? '',
    filters.includeLegacy ? '1' : '0',
  ].join(':');
}

function getExecutionListTotalFromCache(
  userId: number,
  filters: ExecutionListScanFilters
): ExecutionListTotalCacheEntry | null {
  const key = executionListTotalCacheKey(userId, filters);
  const hit = executionListTotalCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > EXECUTION_LIST_TOTAL_CACHE_MS) {
    executionListTotalCache.delete(key);
    return null;
  }
  return hit;
}

function setExecutionListTotalCache(
  userId: number,
  filters: ExecutionListScanFilters,
  total: number,
  truncated: boolean
): void {
  executionListTotalCache.set(executionListTotalCacheKey(userId, filters), {
    total,
    truncated,
    cachedAt: Date.now(),
  });
}

type ExecutionListScanResult = {
  displayRowsFiltered: ExecutionListItem[];
  tradeRowsFetched: number;
  legacyRowsFetched: number;
  truncated: boolean;
  scanComplete: boolean;
};

/** Scan raw trade/legacy rows, materialize display list; stop early once the page window is satisfied. */
async function scanExecutionDisplayRows(params: {
  userId: number;
  whereTrade: Prisma.CopyTradeRowWhereInput;
  whereLegacy: Prisma.CopyExecutionWhereInput;
  failureRows: ExecutionFailureRow[];
  statusFilter: ExecutionStatusFilter;
  includeLegacy: boolean;
  useLeaderJoin: boolean;
  offset: number;
  limit: number;
  fullScan?: boolean;
}): Promise<ExecutionListScanResult> {
  const {
    userId,
    whereTrade,
    whereLegacy,
    failureRows,
    statusFilter,
    includeLegacy,
    useLeaderJoin,
    offset,
    limit,
    fullScan = false,
  } = params;

  const displayTarget = fullScan
    ? Number.MAX_SAFE_INTEGER
    : offset + limit + EXECUTIONS_DISPLAY_OVERSCAN;

  let tradeRows: EventDrivenExecutionRow[] = [];
  let legacyRows: Awaited<ReturnType<typeof prisma.copyExecution.findMany>> = [];
  let displayRowsFiltered: ExecutionListItem[] = [];
  let skip = 0;
  let truncated = false;
  let scanComplete = false;
  const materializeCache = createExecutionMaterializeCache();

  while (true) {
    const [tradeBatch, legacyBatch] = await Promise.all([
      fetchCopyTradeExecutionRows({
        where: whereTrade,
        take: EXECUTIONS_BATCH_SIZE,
        skip,
        useLeaderJoin,
      }),
      includeLegacy
        ? prisma.copyExecution.findMany({
            where: whereLegacy,
            select: LEGACY_EXECUTION_SELECT,
            orderBy: { createdAt: 'desc' },
            take: EXECUTIONS_BATCH_SIZE,
            skip,
          })
        : Promise.resolve([]),
    ]);

    if (!tradeBatch.length && !legacyBatch.length) {
      scanComplete = true;
      break;
    }

    tradeRows = mergeRowsById(tradeRows, tradeBatch);
    if (includeLegacy) {
      legacyRows = mergeRowsById(legacyRows, legacyBatch);
    }

    displayRowsFiltered = await materializeExecutionDisplayRows({
      userId,
      tradeRows,
      legacyRows,
      failureRows,
      statusFilter,
      materializeCache,
    });

    const batchExhausted =
      tradeBatch.length < EXECUTIONS_BATCH_SIZE &&
      (!includeLegacy || legacyBatch.length < EXECUTIONS_BATCH_SIZE);

    if (!fullScan && displayRowsFiltered.length >= displayTarget && !batchExhausted) {
      truncated = true;
      break;
    }

    if (batchExhausted) {
      scanComplete = true;
      break;
    }

    skip += EXECUTIONS_BATCH_SIZE;
    if (skip >= EXECUTIONS_MAX_RAW_SCAN) {
      truncated = true;
      break;
    }
  }

  return {
    displayRowsFiltered,
    tradeRowsFetched: tradeRows.length,
    legacyRowsFetched: legacyRows.length,
    truncated,
    scanComplete,
  };
}

async function warmExecutionListTotalCache(params: {
  userId: number;
  scanFilters: ExecutionListScanFilters;
  whereTrade: Prisma.CopyTradeRowWhereInput;
  whereLegacy: Prisma.CopyExecutionWhereInput;
  failureRows: ExecutionFailureRow[];
  useLeaderJoin: boolean;
}): Promise<void> {
  const key = executionListTotalCacheKey(params.userId, params.scanFilters);
  if (executionListTotalWarmInFlight.has(key)) return;
  executionListTotalWarmInFlight.add(key);
  try {
    const result = await scanExecutionDisplayRows({
      userId: params.userId,
      whereTrade: params.whereTrade,
      whereLegacy: params.whereLegacy,
      failureRows: params.failureRows,
      statusFilter: params.scanFilters.statusFilter,
      includeLegacy: params.scanFilters.includeLegacy,
      useLeaderJoin: params.useLeaderJoin,
      offset: 0,
      limit: 0,
      fullScan: true,
    });
    setExecutionListTotalCache(
      params.userId,
      params.scanFilters,
      result.displayRowsFiltered.length,
      result.truncated
    );
  } finally {
    executionListTotalWarmInFlight.delete(key);
  }
}

function scheduleExecutionListTotalWarm(params: {
  userId: number;
  scanFilters: ExecutionListScanFilters;
  whereTrade: Prisma.CopyTradeRowWhereInput;
  whereLegacy: Prisma.CopyExecutionWhereInput;
  failureRows: ExecutionFailureRow[];
  useLeaderJoin: boolean;
}): void {
  const key = executionListTotalCacheKey(params.userId, params.scanFilters);
  if (executionListTotalWarmInFlight.has(key) || getExecutionListTotalFromCache(params.userId, params.scanFilters)) {
    return;
  }
  void warmExecutionListTotalCache(params).catch(() => {});
}

// 获取当前用户的跟单执行记录（用于观测：是否下单/是否失败）copyTradeRouter.get('/executions', jwtAuth, async (req, res, next: NextFunction) => {
copyTradeRouter.get('/executions', jwtAuth, async (req, res, next: NextFunction) => {
  const metrics = startApiRouteMetrics();
  try {
    const userId = Number(req.user?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const parsed = listExecutionsSchema.safeParse(req.query);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid query', 400, { details: parsed.error.issues });
      return;
    }

    const limit = Math.min(
      EXECUTIONS_MAX_LIMIT,
      Math.max(1, parsed.data.limit && /^\d+$/.test(parsed.data.limit) ? parseInt(parsed.data.limit, 10) : 20)
    );
    const offset =
      parsed.data.offset && /^\d+$/.test(parsed.data.offset) ? parseInt(parsed.data.offset, 10) : 0;

    const rawStatus = parsed.data.status;
    const statusFilter: ExecutionStatusFilter =
      rawStatus === 'success' || rawStatus === 'failed' || rawStatus === 'settled'
        ? rawStatus
        : 'all';

    const leaderLower = parsed.data.leaderAddress?.toLowerCase();
    const subscriptionIdFilter = parsed.data.subscriptionId;

    let resolvedLeaderLower = leaderLower;
    if (subscriptionIdFilter) {
      const sub = await prisma.copySubscription.findFirst({
        where: { id: subscriptionIdFilter, userId, deletedAt: null },
        include: { leader: { select: { address: true } } },
      });
      if (!sub) {
        success(res, { items: [], total: 0, truncated: false, hasMore: false });
        return;
      }
      resolvedLeaderLower = sub.leader.address.toLowerCase();
    }

    await markStaleSubmittingCopyRowsForUser(userId);
    void maybeReconcileExecutionsPreflight(userId);

    const copyTradeStatus = buildCopyTradeStatusWhere(statusFilter);
    const legacyStatus = buildLegacyStatusWhere(statusFilter);

    const whereTrade: Prisma.CopyTradeRowWhereInput = {
      userId,
      ...(copyTradeStatus != null && { status: copyTradeStatus }),
      ...(subscriptionIdFilter && { subscriptionId: subscriptionIdFilter }),
      ...(resolvedLeaderLower &&
        !subscriptionIdFilter && {
          leaderTrade: { leaderAddress: resolvedLeaderLower },
        }),
    };

    const whereLegacy: Prisma.CopyExecutionWhereInput = {
      followerUserId: userId,
      ...(legacyStatus != null && { status: legacyStatus }),
      ...(resolvedLeaderLower && { leaderAddress: resolvedLeaderLower }),
    };

    const useLeaderJoin = Boolean(resolvedLeaderLower);
    const needsFailureContext = statusFilter === 'all' || statusFilter === 'success';
    const includeLegacy = !subscriptionIdFilter;
    const scanFilters: ExecutionListScanFilters = {
      statusFilter,
      subscriptionIdFilter,
      resolvedLeaderLower,
      includeLegacy,
    };
    const warmScanParams = {
      userId,
      scanFilters,
      whereTrade,
      whereLegacy,
      useLeaderJoin,
      failureRows: [] as ExecutionFailureRow[],
    };

    let tradeRowsFetched = 0;
    let legacyRowsFetched = 0;
    let failureRows: ExecutionFailureRow[];
    let settledCandidatesTruncated = false;
    let truncated = false;
    let scanComplete = false;
    let displayRowsFiltered: ExecutionListItem[] = [];

    if (statusFilter === 'settled') {
      const candidateTake = EXECUTIONS_MAX_FETCH_CAP;
      const settledCandidateIds = await loadSettledExecutionCandidateIdsForUser(
        userId,
        candidateTake
      );
      settledCandidatesTruncated =
        settledCandidateIds.copyIds.length + settledCandidateIds.legacyIds.length >= candidateTake;

      const tradeRows: EventDrivenExecutionRow[] = settledCandidateIds.copyIds.length
        ? await fetchCopyTradeExecutionRows({
            where: {
              userId,
              id: { in: settledCandidateIds.copyIds },
              ...(resolvedLeaderLower && {
                leaderTrade: { leaderAddress: resolvedLeaderLower },
              }),
              ...(subscriptionIdFilter && { subscriptionId: subscriptionIdFilter }),
            },
            take: settledCandidateIds.copyIds.length,
            useLeaderJoin,
          })
        : [];
      const legacyRows =
        includeLegacy && settledCandidateIds.legacyIds.length
          ? await prisma.copyExecution.findMany({
              where: {
                followerUserId: userId,
                id: { in: settledCandidateIds.legacyIds },
                ...(resolvedLeaderLower && { leaderAddress: resolvedLeaderLower }),
              },
              select: LEGACY_EXECUTION_SELECT,
              orderBy: { createdAt: 'desc' },
            })
          : [];
      failureRows = [];

      displayRowsFiltered = await materializeExecutionDisplayRows({
        userId,
        tradeRows,
        legacyRows,
        failureRows,
        statusFilter,
      });
      tradeRowsFetched = tradeRows.length;
      legacyRowsFetched = legacyRows.length;
      truncated = settledCandidatesTruncated;
      scanComplete = !settledCandidatesTruncated;
    } else {
      failureRows = needsFailureContext
        ? await prisma.copyTradeRow.findMany({
            where: {
              userId,
              status: { in: [CopyTradeStatus.failed, CopyTradeStatus.dead] },
              NOT: [{ errorCode: 'fail_streak' }],
              ...(subscriptionIdFilter && { subscriptionId: subscriptionIdFilter }),
            },
            select: FAILURE_ROW_SELECT,
            orderBy: { updatedAt: 'desc' },
            take: 50,
          })
        : [];
      warmScanParams.failureRows = failureRows;

      const scanResult = await scanExecutionDisplayRows({
        userId,
        whereTrade,
        whereLegacy,
        failureRows,
        statusFilter,
        includeLegacy,
        useLeaderJoin,
        offset,
        limit,
      });
      displayRowsFiltered = scanResult.displayRowsFiltered;
      tradeRowsFetched = scanResult.tradeRowsFetched;
      legacyRowsFetched = scanResult.legacyRowsFetched;
      truncated = scanResult.truncated;
      scanComplete = scanResult.scanComplete;

      if (scanComplete && !truncated) {
        setExecutionListTotalCache(userId, scanFilters, displayRowsFiltered.length, false);
      } else if (truncated && !scanComplete) {
        scheduleExecutionListTotalWarm(warmScanParams);
      }
    }

    const pageItems = displayRowsFiltered.slice(offset, offset + limit);
    const hasMore = truncated || displayRowsFiltered.length > offset + limit;
    const cachedTotal = getExecutionListTotalFromCache(userId, scanFilters);
    let total: number;
    if (scanComplete && !truncated) {
      total = displayRowsFiltered.length;
    } else if (cachedTotal) {
      total = cachedTotal.total;
      truncated = truncated || cachedTotal.truncated;
    } else {
      /** 提前终止扫描时 total 仅为已扫到的下限；后台会预热精确 total 缓存 */
      total = Math.max(displayRowsFiltered.length, offset + pageItems.length + (hasMore ? 1 : 0));
    }

    const { pnlDetailLookup, realizedPnlLookup } = await loadExecutionPnlLookupsForItems(
      userId,
      collectItemsForPnlLookup(pageItems)
    );
    const pageItemsWithPnl = pageItems.map((item) =>
      applyPnlToExecutionItemWithLifecycle(item, pnlDetailLookup, realizedPnlLookup)
    );

    const localMetadataMap = await loadLocalMarketMetadataForItems(userId, pageItemsWithPnl);
    const leaderByItemId = await resolveLeaderAddressesFromLotClosesForItems(
      userId,
      pageItemsWithPnl
    );

    const itemsOut = pageItemsWithPnl.map((it) => {
      const metadata = localMetadataMap.get(it.tokenID);
      return applyMarketMetadataToExecutionItem(
        withResolvedDisplayLeaderAddress(it, leaderByItemId.get(it.id)),
        metadata
      );
    });

    logApiRouteMetrics('/api/copy-trade/executions', userId, metrics.startedAt, metrics.heapAtStart, {
      resultCount: itemsOut.length,
      limit,
      offset,
      tradeRowsFetched,
      legacyRowsFetched,
      truncated,
      hasMore,
      scanComplete,
    });
    success(res, { items: itemsOut, total, truncated, hasMore });
  } catch (err) {
    logApiRouteMetrics('/api/copy-trade/executions', Number(req.user?.userId), metrics.startedAt, metrics.heapAtStart, {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

/** 持仓/结算详情：仅 filled 且持仓中，或已结算记录可查看 */
copyTradeRouter.get('/executions/:id', jwtAuth, async (req, res, next: NextFunction) => {
  const metrics = startApiRouteMetrics();
  try {
    const userId = Number(req.user?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const requestId = String(req.params.id ?? '').trim();
    if (!requestId) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid execution id', 400);
      return;
    }

    const resolved = await resolveExecutionDetailPayload(userId, requestId);
    if (!resolved) {
      fail(res, Code.NOT_FOUND, 'Execution not found', 404, { errorCode: 'EXECUTION_NOT_FOUND' });
      return;
    }

    const { item, viewState } = resolved;

    const localMetadataMap = await loadLocalMarketMetadataForItems(userId, [item]);

    const buyRowId =
      viewState === 'open'
        ? item._lifecycle?.buy.id ?? item.id
        : item._lifecycle?.buy.id ?? null;

    const subscriptionId = await resolveCopyTradeSubscriptionIdForDetail(userId, requestId, item);
    const [openLots, subscriptionOut, lotLeaderAddress] = await Promise.all([
      viewState === 'open' && buyRowId
        ? loadOpenLotsForExecutionDetail(userId, buyRowId)
        : Promise.resolve(undefined),
      loadExecutionDetailSubscription(userId, subscriptionId),
      resolveLeaderAddressFromLotCloses(userId, requestId, item),
    ]);

    let itemOut = applyMarketMetadataToExecutionItem(
      withResolvedDisplayLeaderAddress(
        item,
        subscriptionOut?.leaderAddress ?? lotLeaderAddress
      ),
      localMetadataMap.get(item.tokenID)
    );

    let timeline = buildExecutionDetailTimeline(itemOut, viewState);
    // Safety net: settled cards must expose entry legs even when lifecycle merge omitted them.
    if (viewState === 'settled' && !timeline.some((event) => event.phase === 'buy')) {
      const buyLegs = await loadSettlementBuyLegsForTimeline(userId, requestId, itemOut);
      if (buyLegs.length) {
        itemOut = {
          ...attachBuyLegsToSettlementItem(itemOut, buyLegs),
          canViewDetail: true,
        };
        timeline = buildExecutionDetailTimeline(itemOut, viewState);
      }
    }

    logApiRouteMetrics('/api/copy-trade/executions/:id', userId, metrics.startedAt, metrics.heapAtStart, {
      viewState,
      requestId,
    });
    success(res, {
      viewState,
      canViewDetail: true,
      item: itemOut,
      openLots: openLots ?? undefined,
      subscription: subscriptionOut,
      timeline,
    });
  } catch (err) {
    logApiRouteMetrics(
      '/api/copy-trade/executions/:id',
      Number(req.user?.userId),
      metrics.startedAt,
      metrics.heapAtStart,
      { error: err instanceof Error ? err.message : String(err) }
    );
    next(err);
  }
});

function parsePublicLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return Math.min(max, Math.max(1, n));
  }
  return Math.min(max, Math.max(1, fallback));
}

const feedQuerySchema = z.object({
  limit: z.string().optional(),
  offset: z.string().optional(),
  /** all | BUY | SELL（大小写不敏感） */
  side: z.enum(['all', 'BUY', 'SELL', 'buy', 'sell']).optional(),
  status: z.enum(['all', 'success', 'settled', 'zeroed', 'failed']).optional(),
  subscriptionId: z.string().uuid().optional(),
  leaderAddress: addressSchema.optional(),
});

type LeaderFeedSubscriptionMeta = {
  subscriptionId: string;
  ruleName: string | null;
  note: string | null;
  subscriptionLabel: string | null;
};

function pickSubscriptionLabel(parts: Array<string | null | undefined>): string | null {
  for (const part of parts) {
    const trimmed = part?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function buildLeaderFeedSubscriptionMetaByAddress(
  subscriptions: Array<
    Pick<CopySubscription, 'id' | 'ruleName' | 'note'> & {
      leader: { address: string; label: string | null };
    }
  >
): Map<string, LeaderFeedSubscriptionMeta> {
  const byAddress = new Map<string, LeaderFeedSubscriptionMeta>();
  for (const subscription of subscriptions) {
    const address = subscription.leader.address.toLowerCase();
    if (!address || byAddress.has(address)) continue;
    byAddress.set(address, {
      subscriptionId: subscription.id,
      ruleName: subscription.ruleName?.trim() || null,
      note: subscription.note?.trim() || null,
      subscriptionLabel: pickSubscriptionLabel([
        subscription.ruleName,
        subscription.note,
        subscription.leader.label,
      ]),
    });
  }
  return byAddress;
}

function leaderTradeNotionalUsd(amount: string, price: string): string | null {
  try {
    const pxNum = Number(price);
    const sharesNum = parseLeaderAmountAsClobSize(amount, pxNum);
    if (!Number.isFinite(pxNum) || !(pxNum > 0) || !Number.isFinite(sharesNum) || !(sharesNum > 0)) {
      return null;
    }
    return new Prisma.Decimal(sharesNum).mul(new Prisma.Decimal(pxNum)).toFixed(2);
  } catch {
    return null;
  }
}

/** Align with 买卖记录 filters, plus explicit 归零. */
type FeedCopyLegStatus = 'pending' | 'success' | 'settled' | 'zeroed' | 'failed';
type FeedStatusFilter = 'all' | 'success' | 'settled' | 'zeroed' | 'failed';
type FeedCopySettlement = 'settled' | 'zeroed';

type FeedCopyLeg = {
  executionId: string;
  subscriptionId: string;
  status: FeedCopyLegStatus;
  copiedAt: string;
  ourSize: string;
  ourPrice: string | null;
  ourNotionalUsd: string | null;
  /** 已实现盈亏（USD）；未结算或尚未写入时为 null */
  realizedPnlUsd: string | null;
  settlementResult: 'win' | 'loss' | 'flat' | null;
  errorCode: string | null;
};

type FeedCopyRowSelect = {
  id: string;
  leaderTradeId: string;
  subscriptionId: string;
  status: CopyTradeStatus;
  filledAmount: string | null;
  intendedSize: string | null;
  avgPrice: string | null;
  intendedPrice: string | null;
  intendedNotional: string | null;
  realizedPnlUsd: Prisma.Decimal | null;
  errorCode: string | null;
  filledAt: Date | null;
  submittedAt: Date | null;
  createdAt: Date;
};

const FEED_LEADER_TRADE_SELECT = {
  id: true,
  leaderAddress: true,
  txHash: true,
  side: true,
  amount: true,
  price: true,
  tokenId: true,
  marketId: true,
  marketTitle: true,
  outcome: true,
  createdAt: true,
} as const;

const FEED_COPY_ROW_SELECT = {
  id: true,
  leaderTradeId: true,
  subscriptionId: true,
  status: true,
  filledAmount: true,
  intendedSize: true,
  avgPrice: true,
  intendedPrice: true,
  intendedNotional: true,
  realizedPnlUsd: true,
  errorCode: true,
  filledAt: true,
  submittedAt: true,
  createdAt: true,
} as const;

function mapFeedCopyStatus(
  status: CopyTradeStatus,
  settlement?: FeedCopySettlement | null
): FeedCopyLegStatus {
  if (settlement === 'zeroed') return 'zeroed';
  if (settlement === 'settled') return 'settled';
  switch (status) {
    case 'filled':
      return 'success';
    case 'failed':
    case 'dead':
    case 'skipped':
      return 'failed';
    default:
      return 'pending';
  }
}

/** One lot-close round-trip for the current page's filled copy ids. */
async function resolveFeedCopySettlements(params: {
  userId: number;
  filledCopyIds: string[];
}): Promise<Map<string, FeedCopySettlement>> {
  const out = new Map<string, FeedCopySettlement>();
  const ids = Array.from(new Set(params.filledCopyIds.filter(Boolean)));
  if (!ids.length) return out;

  const idSet = new Set(ids);
  const buyKeys = ids.flatMap((id) => [id, `legacy:${id}`]);
  const closes = await prisma.copyPositionLotClose.findMany({
    where: {
      userId: params.userId,
      OR: [{ buyCopyTradeRowId: { in: buyKeys } }, { sellCopyTradeRowId: { in: ids } }],
    },
    select: { buyCopyTradeRowId: true, sellCopyTradeRowId: true },
  });
  if (!closes.length) return out;

  const legacySellIds: string[] = [];
  for (const row of closes) {
    const buyRaw = String(row.buyCopyTradeRowId);
    const buyId = buyRaw.startsWith('legacy:') ? buyRaw.slice('legacy:'.length) : buyRaw;
    if (idSet.has(buyId)) out.set(buyId, 'settled');
    const sellRaw = String(row.sellCopyTradeRowId);
    if (idSet.has(sellRaw)) out.set(sellRaw, 'settled');
    if (sellRaw.startsWith('legacy:')) {
      const legacyId = sellRaw.slice('legacy:'.length);
      if (legacyId) legacySellIds.push(legacyId);
    }
  }

  if (!legacySellIds.length) return out;

  const expiredSells = await prisma.copyExecution.findMany({
    where: {
      followerUserId: params.userId,
      id: { in: Array.from(new Set(legacySellIds)) },
      leaderAddress: 'manual_expired',
    },
    select: { id: true },
  });
  if (!expiredSells.length) return out;

  const expiredSellIds = new Set(expiredSells.map((row) => row.id));
  for (const row of closes) {
    const sellRaw = String(row.sellCopyTradeRowId);
    if (!sellRaw.startsWith('legacy:')) continue;
    if (!expiredSellIds.has(sellRaw.slice('legacy:'.length))) continue;
    const buyRaw = String(row.buyCopyTradeRowId);
    const buyId = buyRaw.startsWith('legacy:') ? buyRaw.slice('legacy:'.length) : buyRaw;
    if (idSet.has(buyId)) out.set(buyId, 'zeroed');
  }
  return out;
}

/** Lot-close PnL first, then CopyTradeRow.realizedPnlUsd. */
async function loadFeedCopyRealizedPnlById(params: {
  userId: number;
  copyRows: Array<Pick<FeedCopyRowSelect, 'id' | 'realizedPnlUsd'>>;
}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(params.copyRows.map((row) => row.id).filter(Boolean)));
  if (!ids.length) return out;

  const [buyDetails, sellDetails] = await Promise.all([
    getCopyLotCloseDetailsForBuyRowIds({
      prismaClient: prisma as any,
      userId: params.userId,
      buyRowIds: ids,
    }),
    getCopyLotCloseDetailsForExecutionKeys({
      prismaClient: prisma as any,
      userId: params.userId,
      executionKeys: ids.map((id) => `copy:${id}`),
    }),
  ]);

  for (const row of params.copyRows) {
    const fromBuy = buyDetails.get(row.id)?.realizedPnlUsd;
    const fromSell = sellDetails.get(`copy:${row.id}`)?.realizedPnlUsd;
    const fromRow = row.realizedPnlUsd != null ? row.realizedPnlUsd.toString() : null;
    const pnl = fromBuy ?? fromSell ?? fromRow;
    if (pnl != null) out.set(row.id, pnl);
  }
  return out;
}

function mapFeedCopyLeg(
  row: FeedCopyRowSelect,
  subscription?: Pick<CopySubscription, 'copyMode' | 'fixedAmountUsd'> | null,
  settlement?: FeedCopySettlement | null,
  realizedPnlUsd?: string | null
): FeedCopyLeg {
  const ourSize = (row.filledAmount ?? row.intendedSize ?? '0').trim() || '0';
  const ourPriceRaw = (row.avgPrice ?? row.intendedPrice)?.trim() || null;
  const fixedAmountNotional =
    subscription?.copyMode === 'FIXED_AMOUNT'
      ? (subscription.fixedAmountUsd?.toString().trim() || null)
      : null;
  const ourNotionalUsd =
    (fixedAmountNotional ?? row.intendedNotional?.trim()) ||
    (ourPriceRaw ? leaderTradeNotionalUsd(ourSize, ourPriceRaw) : null);
  const copiedAt = (row.filledAt ?? row.submittedAt ?? row.createdAt).toISOString();
  const pnl =
    realizedPnlUsd ?? (row.realizedPnlUsd != null ? row.realizedPnlUsd.toString() : null);
  return {
    executionId: row.id,
    subscriptionId: row.subscriptionId,
    status: mapFeedCopyStatus(row.status, settlement),
    copiedAt,
    ourSize,
    ourPrice: ourPriceRaw,
    ourNotionalUsd,
    realizedPnlUsd: pnl,
    settlementResult: settlementResultFromPnl(pnl),
    errorCode: row.errorCode ?? null,
  };
}

function feedFilledSettlementSql(filter: 'success' | 'settled' | 'zeroed') {
  const hasBuyClose = Prisma.sql`(
    EXISTS (
      SELECT 1 FROM copy_position_lot_closes lc
      WHERE lc."userId" = ct."userId"
        AND (lc."buyCopyTradeRowId" = ct.id OR lc."buyCopyTradeRowId" = 'legacy:' || ct.id)
    )
  )`;
  const hasSellClose = Prisma.sql`(
    EXISTS (
      SELECT 1 FROM copy_position_lot_closes lc
      WHERE lc."userId" = ct."userId"
        AND lc."sellCopyTradeRowId" = ct.id
    )
  )`;
  const isZeroed = Prisma.sql`(
    EXISTS (
      SELECT 1
      FROM copy_position_lot_closes lc
      INNER JOIN "CopyExecution" ce
        ON lc."sellCopyTradeRowId" = 'legacy:' || ce.id
       AND ce."followerUserId" = ct."userId"
       AND ce."leaderAddress" = 'manual_expired'
      WHERE lc."userId" = ct."userId"
        AND (lc."buyCopyTradeRowId" = ct.id OR lc."buyCopyTradeRowId" = 'legacy:' || ct.id)
    )
  )`;
  if (filter === 'zeroed') return isZeroed;
  if (filter === 'settled') {
    return Prisma.sql`((${hasBuyClose} OR ${hasSellClose}) AND NOT ${isZeroed})`;
  }
  return Prisma.sql`(NOT ${hasBuyClose} AND NOT ${hasSellClose})`;
}

/** DB-paged copy ids for success / settled / zeroed (no over-fetch). */
async function findFeedFilledCopyIdsBySettlement(params: {
  userId: number;
  subscriptionIds: string[];
  leaderAddresses: string[];
  sideFilter?: 'BUY' | 'SELL';
  statusFilter: 'success' | 'settled' | 'zeroed';
  offset: number;
  limit: number;
}): Promise<{ ids: string[]; total: number }> {
  const sideSql = params.sideFilter
    ? Prisma.sql`AND UPPER(lt.side) = ${params.sideFilter}`
    : Prisma.empty;
  const settlementSql = feedFilledSettlementSql(params.statusFilter);
  const baseFrom = Prisma.sql`
    FROM copy_trades ct
    INNER JOIN "LeaderTrade" lt ON lt.id = ct."leaderTradeId"
    WHERE ct."userId" = ${params.userId}
      AND ct."subscriptionId" = ANY(${params.subscriptionIds}::text[])
      AND LOWER(lt."leaderAddress") = ANY(${params.leaderAddresses}::text[])
      AND ct.status = 'filled'::"CopyTradeStatus"
      ${sideSql}
      AND ${settlementSql}
  `;
  const [idRows, countRows] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT ct.id
      ${baseFrom}
      ORDER BY ct."createdAt" DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      ${baseFrom}
    `,
  ]);
  return {
    ids: idRows.map((row) => row.id),
    total: Number(countRows[0]?.count ?? 0n),
  };
}

function mapLeaderTradeListItem(
  row: Pick<
    LeaderTrade,
    | 'id'
    | 'leaderAddress'
    | 'txHash'
    | 'side'
    | 'amount'
    | 'price'
    | 'tokenId'
    | 'marketId'
    | 'marketTitle'
    | 'outcome'
    | 'createdAt'
  >
) {
  const title = row.marketTitle?.trim() || null;
  const outcome = row.outcome?.trim() || null;
  return {
    id: row.id,
    leaderAddress: row.leaderAddress,
    txHash: row.txHash,
    side: row.side,
    amount: row.amount,
    price: row.price,
    tokenId: row.tokenId,
    marketId: row.marketId,
    marketLabel: title,
    title,
    eventTitle: title,
    category: null,
    question: title,
    outcome,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapLeaderTradeFeedItem(
  row: Pick<
    LeaderTrade,
    | 'id'
    | 'leaderAddress'
    | 'txHash'
    | 'side'
    | 'amount'
    | 'price'
    | 'tokenId'
    | 'marketId'
    | 'marketTitle'
    | 'outcome'
    | 'createdAt'
  >,
  subscriptionMeta: LeaderFeedSubscriptionMeta | null,
  copy: FeedCopyLeg | null = null
) {
  const base = mapLeaderTradeListItem(row);
  const notionalUsd = leaderTradeNotionalUsd(row.amount, row.price);
  return {
    ...base,
    side: row.side.trim().toUpperCase(),
    notionalUsd,
    scaleUsd: notionalUsd,
    subscriptionId: subscriptionMeta?.subscriptionId ?? null,
    ruleName: subscriptionMeta?.ruleName ?? null,
    note: subscriptionMeta?.note ?? null,
    subscriptionLabel: subscriptionMeta?.subscriptionLabel ?? null,
    copy,
  };
}

/** 当前用户已追踪钱包的最近动作流 */
copyTradeRouter.get('/feed', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    const userId = Number(req.user?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const parsed = feedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid query', 400, { details: parsed.error.issues });
      return;
    }

    const limit = parsePublicLimit(parsed.data.limit, 20, 50);
    const offset = Math.max(0, Number(parsed.data.offset ?? 0) || 0);
    const rawSide = parsed.data.side;
    const statusFilter = parsed.data.status ?? 'all';
    const sideFilter =
      rawSide && rawSide !== 'all' ? (rawSide.toUpperCase() as 'BUY' | 'SELL') : undefined;

    // Include paused (enabled=false) subscriptions: pause stops mirroring, not leader feed.
    const subscriptions = await prisma.copySubscription.findMany({
      where: { userId, deletedAt: null },
      include: {
        leader: {
          select: { address: true, label: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const subscriptionMetaByAddress = buildLeaderFeedSubscriptionMetaByAddress(subscriptions);
    const subscriptionById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
    const leaderAddresses = resolveFeedLeaderAddresses({
      subscriptions,
      subscriptionId: parsed.data.subscriptionId,
      leaderAddress: parsed.data.leaderAddress,
    });

    if (!leaderAddresses.length) {
      success(res, { items: [], total: 0, offset, hasMore: false });
      return;
    }

    const filteredSubscriptionId = parsed.data.subscriptionId ?? null;
    const subscriptionIdsForJoin = filteredSubscriptionId
      ? [filteredSubscriptionId]
      : [
          ...new Set(
            subscriptions
              .filter((subscription) =>
                leaderAddresses.includes(subscription.leader.address.toLowerCase())
              )
              .map((subscription) => subscription.id)
          ),
        ];

    const filteredSubscriptionMeta = filteredSubscriptionId
      ? (() => {
          const subscription = subscriptions.find((s) => s.id === filteredSubscriptionId);
          if (!subscription) return null;
          return {
            subscriptionId: subscription.id,
            ruleName: subscription.ruleName?.trim() || null,
            note: subscription.note?.trim() || null,
            subscriptionLabel: pickSubscriptionLabel([
              subscription.ruleName,
              subscription.note,
              subscription.leader.label,
            ]),
          } satisfies LeaderFeedSubscriptionMeta;
        })()
      : null;

    const resolveMeta = (leaderAddress: string, subscriptionId?: string | null) => {
      if (filteredSubscriptionMeta) return filteredSubscriptionMeta;
      if (subscriptionId) {
        const subscription = subscriptionById.get(subscriptionId);
        if (subscription) {
          return {
            subscriptionId: subscription.id,
            ruleName: subscription.ruleName?.trim() || null,
            note: subscription.note?.trim() || null,
            subscriptionLabel: pickSubscriptionLabel([
              subscription.ruleName,
              subscription.note,
              subscription.leader.label,
            ]),
          } satisfies LeaderFeedSubscriptionMeta;
        }
      }
      return subscriptionMetaByAddress.get(leaderAddress.toLowerCase()) ?? null;
    };

    const leaderWhere = {
      leaderAddress: { in: leaderAddresses },
      ...(sideFilter ? { side: { equals: sideFilter, mode: 'insensitive' as const } } : {}),
    };

    // --- all: page LeaderTrade, attach copy only for this page ---
    if (statusFilter === 'all') {
      const [rows, total] = await Promise.all([
        prisma.leaderTrade.findMany({
          where: leaderWhere,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          select: FEED_LEADER_TRADE_SELECT,
        }),
        prisma.leaderTrade.count({ where: leaderWhere }),
      ]);

      const copyByLeaderTradeAndSub = new Map<string, FeedCopyLeg>();
      if (rows.length > 0 && subscriptionIdsForJoin.length > 0) {
        const copyRows = await prisma.copyTradeRow.findMany({
          where: {
            userId,
            leaderTradeId: { in: rows.map((row) => row.id) },
            subscriptionId: { in: subscriptionIdsForJoin },
          },
          select: FEED_COPY_ROW_SELECT,
        });
        const filledCopyRows = copyRows.filter((row) => row.status === CopyTradeStatus.filled);
        const [settlements, realizedPnlById] = await Promise.all([
          resolveFeedCopySettlements({
            userId,
            filledCopyIds: filledCopyRows.map((row) => row.id),
          }),
          loadFeedCopyRealizedPnlById({ userId, copyRows: filledCopyRows }),
        ]);
        for (const copyRow of copyRows) {
          copyByLeaderTradeAndSub.set(
            `${copyRow.leaderTradeId}:${copyRow.subscriptionId}`,
            mapFeedCopyLeg(
              copyRow,
              subscriptionById.get(copyRow.subscriptionId) ?? null,
              settlements.get(copyRow.id) ?? null,
              realizedPnlById.get(copyRow.id) ?? null
            )
          );
        }
      }

      const items = rows.map((row) => {
        const meta = resolveMeta(row.leaderAddress);
        const subscriptionIdForCopy = meta?.subscriptionId ?? null;
        const copy =
          subscriptionIdForCopy != null
            ? copyByLeaderTradeAndSub.get(`${row.id}:${subscriptionIdForCopy}`) ?? null
            : null;
        return mapLeaderTradeFeedItem(row, meta, copy);
      });

      success(res, {
        items,
        total,
        offset,
        hasMore: offset + items.length < total,
      });
      return;
    }

    if (!subscriptionIdsForJoin.length) {
      success(res, { items: [], total: 0, offset, hasMore: false });
      return;
    }

    // --- failed: page CopyTradeRow by status ---
    if (statusFilter === 'failed') {
      const copyWhere = {
        userId,
        subscriptionId: { in: subscriptionIdsForJoin },
        status: { in: [CopyTradeStatus.failed, CopyTradeStatus.dead, CopyTradeStatus.skipped] },
        leaderTrade: leaderWhere,
      };
      const [copyRows, total] = await Promise.all([
        prisma.copyTradeRow.findMany({
          where: copyWhere,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          select: {
            ...FEED_COPY_ROW_SELECT,
            leaderTrade: { select: FEED_LEADER_TRADE_SELECT },
          },
        }),
        prisma.copyTradeRow.count({ where: copyWhere }),
      ]);

      const items = copyRows.map((copyRow) => {
        const meta = resolveMeta(copyRow.leaderTrade.leaderAddress, copyRow.subscriptionId);
        return mapLeaderTradeFeedItem(
          copyRow.leaderTrade,
          meta,
          mapFeedCopyLeg(copyRow, subscriptionById.get(copyRow.subscriptionId) ?? null, null)
        );
      });

      success(res, {
        items,
        total,
        offset,
        hasMore: offset + items.length < total,
      });
      return;
    }

    // --- success / settled / zeroed: SQL EXISTS + DB pagination ---
    const { ids, total } = await findFeedFilledCopyIdsBySettlement({
      userId,
      subscriptionIds: subscriptionIdsForJoin,
      leaderAddresses,
      sideFilter,
      statusFilter,
      offset,
      limit,
    });

    if (!ids.length) {
      success(res, { items: [], total, offset, hasMore: false });
      return;
    }

    const copyRows = await prisma.copyTradeRow.findMany({
      where: { id: { in: ids } },
      select: {
        ...FEED_COPY_ROW_SELECT,
        leaderTrade: { select: FEED_LEADER_TRADE_SELECT },
      },
    });
    const copyById = new Map(copyRows.map((row) => [row.id, row]));
    const settlementHint: FeedCopySettlement | null =
      statusFilter === 'zeroed' ? 'zeroed' : statusFilter === 'settled' ? 'settled' : null;
    const realizedPnlById = await loadFeedCopyRealizedPnlById({ userId, copyRows });

    const items = ids
      .map((id) => copyById.get(id))
      .filter((row): row is NonNullable<typeof row> => row != null)
      .map((copyRow) => {
        const meta = resolveMeta(copyRow.leaderTrade.leaderAddress, copyRow.subscriptionId);
        return mapLeaderTradeFeedItem(
          copyRow.leaderTrade,
          meta,
          mapFeedCopyLeg(
            copyRow,
            subscriptionById.get(copyRow.subscriptionId) ?? null,
            settlementHint,
            realizedPnlById.get(copyRow.id) ?? null
          )
        );
      });

    success(res, {
      items,
      total,
      offset,
      hasMore: offset + items.length < total,
    });
  } catch (err) {
    next(err);
  }
});

/** 首页等：最近 leader 链上成交（不含 follower 信息） */
copyTradeRouter.get('/public/recent-leader-trades', async (req, res, next: NextFunction) => {
  try {
    const limit = parsePublicLimit(req.query.limit, 20, 50);
    const rows = await prisma.leaderTrade.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        leaderAddress: true,
        txHash: true,
        side: true,
        amount: true,
        price: true,
        tokenId: true,
        marketId: true,
        marketTitle: true,
        outcome: true,
        createdAt: true,
      },
    });
    const items = rows.map((row) => mapLeaderTradeListItem(row));
    success(res, { items });
  } catch (err) {
    next(err);
  }
});

/** 首页：最近已成交的镜像单（脱敏，不含 userId） */
copyTradeRouter.get('/public/recent-mirrored-trades', async (req, res, next: NextFunction) => {
  try {
    const limit = parsePublicLimit(req.query.limit, 10, 50);
    const rows = await prisma.copyTradeRow.findMany({
      where: { status: CopyTradeStatus.filled },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        leaderTrade: {
          select: {
            side: true,
            amount: true,
            price: true,
            tokenId: true,
            marketId: true,
          },
        },
      },
    });
    const items = rows.map((r) => {
      const lt = r.leaderTrade;
      const pnl = r.realizedPnlUsd;
      return {
        id: r.id,
        tokenId: lt.tokenId,
        marketId: lt.marketId,
        side: lt.side,
        amount: r.intendedSize ?? lt.amount,
        price: r.intendedPrice ?? lt.price,
        notional: r.intendedNotional,
        createdAt: r.createdAt.toISOString(),
        realizedPnlUsd: pnl != null ? pnl.toString() : null,
      };
    });
    success(res, { items });
  } catch (err) {
    next(err);
  }
});

const simulateLeaderOrderSchema = z.object({
  leaderAddress: addressSchema,
  tokenID: z.string().min(1),
  price: z.number().positive(),
  size: z.number().positive(),
  side: z.enum(['BUY', 'SELL']),
});

// 开发模式：模拟「检测到 leader 下单」，触发跟单引擎写入 CopyExecution
copyTradeRouter.post('/dev/simulate-leader-order', jwtAuth, requireUserTradePermission, async (req, res, next: NextFunction) => {
  try {
    if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production') {
      fail(res, Code.NOT_FOUND, 'Not found', 404);
      return;
    }

    const userId = Number(req.user?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const parsed = simulateLeaderOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, { details: parsed.error.issues });
      return;
    }

    await handleLeaderOrder({
      leaderAddress: parsed.data.leaderAddress.toLowerCase(),
      tokenID: parsed.data.tokenID,
      price: parsed.data.price,
      size: parsed.data.size,
      side: parsed.data.side,
    });

    success(res, { ok: true });
  } catch (err) {
    next(err);
  }
});
