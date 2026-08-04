import { Prisma } from '../../generated/prisma/client';
import { CopyTradeStatus } from '../../generated/prisma/enums';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  createAndPostOrderForUser,
  getClobOrderFillSummary,
} from '../../services/polymarket/polymarketClob';
import { sanitizeCopyBuyFillAgainstIntent } from '../../services/polymarket/clobFillSummary';
import { fetchDataApiPositions, type DataApiPosition } from '../../services/polymarket/polymarketData';
import { getExecutionWalletForUser } from '../../services/polymarket/automationSession';
import { recordAuditEvent } from '../../services/audit/events';
import { TradingGuardService } from '../../services/trading/tradingGuard';
import { getRobotRuntimeManager } from '../runtime/robotRuntimeSingleton';
import { COPY_STALE_SUBMITTING_ERROR_CODE } from './copyRetryPolicy';
import {
  resolveCopyOrderPrice,
  computeCopyRiskNotionalUsd,
  parseSubscriptionSlippage,
} from './copyOrderPrice';
import {
  COPY_COLLATERAL_INSUFFICIENT_WARNING_CODE,
  COPY_FUNDS_EMPTY_ERROR_CODE,
  COPY_GAS_INSUFFICIENT_ERROR_CODE,
  clearCopyFundingWarningForCode,
  isCopyBuyFundingWarningCode,
  markUserCopyTradingFundingWarning,
  maybePauseCopyTradingAfterOrderFailure,
  subscriptionHasBuyFundingWarning,
  syncCopyTradingCollateralFundingState,
} from './copyFundingMonitor';
import { resolveDispatchSubscriptionsForLeader } from './resolveDispatchSubscriptions';
import { isCopySellFillComplete, resolveCopySellSize, roundDownToDecimals, sharesFilledEnough } from './copySellSize';
import { classifyCopyOrderFailure, RiskService, shouldCountCopyFailureTowardStreak } from './riskService';
import { mapPool, sleep } from './mapPool';
import { recordAdminActivity, recordAdminAlert } from '../../services/adminDashboard/adminActivityLog';
import { evaluateCopyOrderFundingPrecheck, invalidateCopyFundingPrecheckCache } from './copyOrderFundingPrecheck';
import { markUserPositionScanActiveBestEffort } from '../../services/polymarket/positionScanState';
import {
  backfillMissingCopyBuyLotsForSubscription,
  closeResidualCopyLotWhenFlat,
  consumeCopyLotsForSell,
  getOpenCopyLotSizeForSubscription,
  recordCopyBuyLot,
} from './copyPositionLots';
import { resolveSellLotCloseFromFill } from './copySettlementProceeds';
import { dispatchVirtualCopyExecutions } from '../../virtualCopyTrading/virtualCopyExecutionService';
import {
  computeRatioBuySize,
  refreshDepositBalanceCacheFromChain,
  resolveAvailableUsdcForRatioBuy,
} from './copyRatioSizing.js';

export type DispatchLeaderTradeSource = 'nats' | 'replay' | 'retry_sweep' | 'manual';

const OUTCOME_SIZE_DECIMALS = 6;
const OUTCOME_SIZE_RAW_SCALE = 10 ** OUTCOME_SIZE_DECIMALS;
const COPY_MIN_ORDER_GUARD_ENABLED = true;
const userDispatchLocks = new Map<number, Promise<void>>();
const leaderTradeDispatchLocks = new Map<string, Promise<void>>();

class CopyDispatchTimeoutError extends Error {
  constructor(
    readonly leaderTradeId: string,
    readonly source: DispatchLeaderTradeSource,
    readonly timeoutMs: number
  ) {
    super(`Copy dispatch timed out after ${timeoutMs}ms`);
    this.name = 'CopyDispatchTimeoutError';
  }
}

const copyUserPositionsCache = new Map<
  number,
  { at: number; promise: Promise<DataApiPosition[] | null> }
>();

function roundUpToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}

function getBufferedBuyMinNotionalUsd(): number {
  return CONFIG.copyBuyMinNotionalUsd;
}

function formatFixed(value: number): string {
  return value.toFixed(6);
}

async function markSellNoPositionRow(params: {
  rowId: string;
  retryCount: number;
  errorMsg: string;
  retryable: boolean;
}): Promise<void> {
  await prisma.copyTradeRow.update({
    where: { id: params.rowId },
    data: {
      status: params.retryable ? CopyTradeStatus.failed : CopyTradeStatus.skipped,
      errorCode: 'ignored_no_position_sell',
      errorMsg: params.errorMsg,
      ...(params.retryable ? { retryCount: params.retryCount + 1 } : {}),
    },
  });
}

function ceilUsdCents(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  return Math.ceil((value - 1e-9) * 100) / 100;
}

function hasAnySellableOpenPosition(positions: DataApiPosition[] | null): boolean | null {
  if (positions == null) return null;
  return positions.some((p) => {
    const size = Number(p.size ?? 0);
    if (!(size > 1e-9)) return false;
    if (p.redeemable === true) return false;
    const price = Number(p.curPrice ?? 0);
    const value = Number(p.currentValue ?? price * size);
    if (!Number.isFinite(price) || !Number.isFinite(value)) return true;
    return price > 0.001 || value > 0.05;
  });
}

function isBuyFundingFailure(errorCode: string): boolean {
  return isCopyBuyFundingWarningCode(errorCode);
}

async function absorbFundingSkippedCopyTradeRow(rowId: string): Promise<void> {
  await prisma.copyTradeRow.deleteMany({ where: { id: rowId } });
}

function resolveBuyFundingSkipMeta(params: {
  baseErrorCode: string;
  baseErrorMsg: string;
  positions: DataApiPosition[] | null;
}): { errorCode: string; errorMsg: string } {
  const isGasFailure = params.baseErrorCode === COPY_GAS_INSUFFICIENT_ERROR_CODE;
  const hasSellablePosition = isGasFailure ? true : hasAnySellableOpenPosition(params.positions);
  const errorCode = isGasFailure
    ? COPY_GAS_INSUFFICIENT_ERROR_CODE
    : hasSellablePosition === false
      ? COPY_FUNDS_EMPTY_ERROR_CODE
      : COPY_COLLATERAL_INSUFFICIENT_WARNING_CODE;
  const errorMsg = isGasFailure
    ? params.baseErrorMsg
    : hasSellablePosition === false
      ? 'Insufficient Polymarket funds and no sellable positions; BUY skipped, copy listening continues.'
      : hasSellablePosition === true
        ? 'Insufficient Polymarket funds; BUY skipped, SELL signals will continue while positions exist.'
        : 'Insufficient Polymarket funds; BUY skipped, position lookup failed, SELL signals will continue.';
  return { errorCode, errorMsg };
}

async function handleBuyFundingSkip(params: {
  rowId: string;
  userId: number;
  leaderTradeId: string;
  subscriptionId: string;
  dispatchSource: DispatchLeaderTradeSource;
  errorCode: string;
  errorMsg: string;
}): Promise<void> {
  await markUserCopyTradingFundingWarning({
    userId: params.userId,
    errorCode: params.errorCode,
    errorMsg: params.errorMsg,
  });
  await absorbFundingSkippedCopyTradeRow(params.rowId);
  void refreshDepositBalanceCacheFromChain(params.userId).catch((err) => {
    console.warn('[copy-dispatch] deposit balance refresh after funding skip failed', {
      userId: params.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  console.warn('[copy-dispatch] buy skipped due to funding (no execution log)', {
    userId: params.userId,
    copyTradeRowId: params.rowId,
    leaderTradeId: params.leaderTradeId,
    subscriptionId: params.subscriptionId,
    errorCode: params.errorCode,
    dispatchSource: params.dispatchSource,
  });
}

async function waitForDispatchWithTimeout<T>(
  promise: Promise<T>,
  params: { leaderTradeId: string; source: DispatchLeaderTradeSource }
): Promise<T> {
  const timeoutMs = CONFIG.copyDispatchTimeoutMs;
  if (!(timeoutMs > 0)) {
    return promise;
  }

  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new CopyDispatchTimeoutError(params.leaderTradeId, params.source, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function runUserSerialized<T>(userId: number, task: () => Promise<T>): Promise<T> {
  const previous = userDispatchLocks.get(userId) ?? Promise.resolve();

  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = previous.then(() => current);
  userDispatchLocks.set(userId, queued);

  await previous;

  try {
    return await task();
  } finally {
    release();
    if (userDispatchLocks.get(userId) === queued) {
      userDispatchLocks.delete(userId);
    }
  }
}

async function dispatchLeaderTradeInner(
  leaderTradeId: string,
  source: DispatchLeaderTradeSource
): Promise<void> {
  const staleBefore = new Date(Date.now() - CONFIG.copyStaleSubmittingMs);
  await prisma.copyTradeRow.updateMany({
    where: {
      leaderTradeId,
      status: CopyTradeStatus.submitting,
      updatedAt: { lt: staleBefore },
    },
    data: {
      status: CopyTradeStatus.failed,
      errorCode: COPY_STALE_SUBMITTING_ERROR_CODE,
      errorMsg: 'Copy order stayed submitting too long; marked retryable.',
      retryCount: { increment: 1 },
    },
  });

  if (CONFIG.copyMaxRetries > 0) {
    await prisma.copyTradeRow.updateMany({
      where: {
        leaderTradeId,
        status: CopyTradeStatus.failed,
        errorCode: COPY_STALE_SUBMITTING_ERROR_CODE,
        retryCount: { gte: CONFIG.copyMaxRetries },
      },
      data: { status: CopyTradeStatus.dead },
    });
  }

  const lt = await prisma.leaderTrade.findUnique({
    where: { id: leaderTradeId },
  });
  if (!lt) {
    console.warn('[copy-dispatch] leader trade not found', { leaderTradeId, source });
    return;
  }

  const leader = await prisma.copyLeader.findUnique({
    where: { address: lt.leaderAddress },
  });
  if (!leader?.enabled) {
    await prisma.leaderTrade.update({ where: { id: lt.id }, data: { processed: true } });
    return;
  }

  if (lt.leaderId !== leader.id) {
    await prisma.leaderTrade.update({ where: { id: lt.id }, data: { leaderId: leader.id } });
  }

  const side: 'BUY' | 'SELL' = lt.side === 'SELL' ? 'SELL' : 'BUY';
  const resolved = await resolveDispatchSubscriptionsForLeader({
    leaderId: leader.id,
    leaderAddress: leader.address,
    runtimeManager: getRobotRuntimeManager(),
    includeFundingPaused: side === 'SELL',
  });

  console.log('[copy-dispatch-subscriptions]', {
    leaderTradeId: lt.id,
    leaderAddress: leader.address,
    dispatchSource: source,
    side: lt.side,
    source: resolved.source,
    runtimeCount: resolved.runtimeCount,
    resolvedCount: resolved.dbCount,
    fallbackReason: resolved.fallbackReason,
  });

  if (resolved.fallbackReason) {
    console.warn('[copy-runtime-dispatch-fallback]', {
      leaderAddress: leader.address,
      reason: resolved.fallbackReason,
      runtimeCount: resolved.runtimeCount,
      dbCount: resolved.dbCount,
    });
  }

  const subs = resolved.subscriptions;
  if (CONFIG.virtualCopyAccountsEnabled && CONFIG.virtualCopyExecutionEnabled) {
    try {
      await dispatchVirtualCopyExecutions(lt.id);
    } catch (error) {
      // The isolated virtual domain must never block or alter real order dispatch.
      // The virtual worker replays recent LeaderTrade rows with idempotent unique keys.
      console.error('[virtual-copy-dispatch] fan-out failed; scheduled replay will retry', {
        leaderTradeId: lt.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const risk = new RiskService();
  const tradingGuard = new TradingGuardService();
  const marketTitle = lt.marketTitle?.trim() || null;
  const outcome = lt.outcome?.trim() || null;

  const buyFundingBlocked =
    side === 'BUY' ? subs.filter((s) => subscriptionHasBuyFundingWarning(s)) : [];
  const subsForRows =
    side === 'BUY' ? subs.filter((s) => !subscriptionHasBuyFundingWarning(s)) : subs;

  if (subsForRows.length > 0) {
    await prisma.copyTradeRow.createMany({
      data: subsForRows.map((s) => ({
        userId: s.userId,
        leaderTradeId: lt.id,
        subscriptionId: s.id,
        txHash: lt.txHash,
        marketId: lt.marketId,
        marketTitle,
        tokenId: lt.tokenId,
        outcome,
        status: CopyTradeStatus.queued,
      })),
      skipDuplicates: true,
    });
  } else {
    // BUY 全部被资金预警挡下：立刻落 skipped，禁止后续 duplicate 空跑补派发变成「延迟成交」。
    if (buyFundingBlocked.length > 0) {
      await prisma.copyTradeRow.createMany({
        data: buyFundingBlocked.map((s) => ({
          userId: s.userId,
          leaderTradeId: lt.id,
          subscriptionId: s.id,
          txHash: lt.txHash,
          marketId: lt.marketId,
          marketTitle,
          tokenId: lt.tokenId,
          outcome,
          side: 'BUY' as const,
          status: CopyTradeStatus.skipped,
          errorCode: s.fundingWarningCode?.trim() || 'buy_funding_warning',
          errorMsg:
            'BUY skipped due to funding warning; will not redispatch this leader trade.',
        })),
        skipDuplicates: true,
      });
      await prisma.leaderTrade.update({ where: { id: lt.id }, data: { processed: true } });
      console.warn('[copy-dispatch] BUY empty after funding filter; marked skipped (no redispatch)', {
        leaderTradeId: lt.id,
        dispatchSource: source,
        blockedSubscriptions: buyFundingBlocked.length,
      });
      return;
    }
    const pendingRows = await prisma.copyTradeRow.count({
      where: {
        leaderTradeId: lt.id,
        status: { in: [CopyTradeStatus.queued, CopyTradeStatus.submitting] },
      },
    });
    if (pendingRows === 0) {
      await prisma.leaderTrade.update({ where: { id: lt.id }, data: { processed: true } });
      console.warn('[copy-dispatch] no eligible subscriptions; marked processed (no redispatch)', {
        leaderTradeId: lt.id,
        dispatchSource: source,
        side,
        resolvedSubscriptions: subs.length,
      });
      return;
    }
    console.warn('[copy-dispatch] no enabled subscriptions; draining existing queued rows', {
      leaderTradeId: lt.id,
      dispatchSource: source,
      pendingRows,
    });
  }

  const rows = await prisma.copyTradeRow.findMany({
    where: { leaderTradeId: lt.id, status: CopyTradeStatus.queued },
    include: { subscription: true },
  });

  const leaderPrice = parseFloat(lt.price) || 0;
  const positionsByUser = new Map<number, Promise<DataApiPosition[] | null>>();

  const fetchPositionsForUser = (userId: number): Promise<DataApiPosition[] | null> =>
    (async () => {
      try {
        const ctx = await getExecutionWalletForUser(userId);
        const custodial = ctx.address.trim();
        const deposit = (ctx.polymarketFunderAddress ?? '').trim();
        const custodialLower = custodial.toLowerCase();
        const depositLower = deposit.toLowerCase();
        const primary = deposit && depositLower !== custodialLower ? deposit : custodial;
        let list = await fetchDataApiPositions(primary, { sizeThreshold: 0, limit: 500 });
        if (list.length === 0 && deposit && depositLower !== custodialLower) {
          list = await fetchDataApiPositions(custodial, { sizeThreshold: 0, limit: 500 });
        }
        return list;
      } catch (error) {
        console.warn('[copy-dispatch] positions precheck failed', {
          userId,
          leaderTradeId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

  const getUserPositions = async (userId: number): Promise<DataApiPosition[] | null> => {
    const ttl = CONFIG.copyPositionsCacheMs;
    if (ttl > 0) {
      const globalHit = copyUserPositionsCache.get(userId);
      if (globalHit && Date.now() - globalHit.at < ttl) {
        return globalHit.promise;
      }
      const promise = fetchPositionsForUser(userId);
      copyUserPositionsCache.set(userId, { at: Date.now(), promise });
      return promise;
    }

    let pending = positionsByUser.get(userId);
    if (!pending) {
      pending = fetchPositionsForUser(userId);
      positionsByUser.set(userId, pending);
    }
    return pending;
  };

  await mapPool(rows, CONFIG.copyDispatchConcurrency, async (row) => {
    const copyT0 = Date.now();
    let copyT1 = copyT0;
    let copyT2 = copyT0;
    let copyT3 = copyT0;
    try {
      await sleep(row.subscription.delayMs);

      if (
        side === 'BUY' &&
        subscriptionHasBuyFundingWarning(row.subscription)
      ) {
        await absorbFundingSkippedCopyTradeRow(row.id);
        return;
      }

      const claimed = await prisma.copyTradeRow.updateMany({
        where: { id: row.id, status: CopyTradeStatus.queued },
        data: { status: CopyTradeStatus.submitting },
      });
      if (claimed.count !== 1) return;

      const liveSub = await prisma.copySubscription.findUnique({
        where: { id: row.subscriptionId },
        select: { enabled: true, fundingPausedAt: true },
      });
      const allowFundingPausedSell =
        side === 'SELL' && liveSub?.enabled === false && liveSub.fundingPausedAt != null;
      if (!liveSub?.enabled && !allowFundingPausedSell) {
        await prisma.copyTradeRow.update({
          where: { id: row.id },
          data: {
            status: CopyTradeStatus.skipped,
            errorCode: 'copy_funding_paused',
            errorMsg: 'Copy trading is paused due to funding or authorization; resolve it and resume copy trading.',
          },
        });
        return;
      }

      const ratio = new Prisma.Decimal(row.subscription.copyRatio.toString()).toNumber();
      const fixedAmountUsd =
        row.subscription.fixedAmountUsd != null
          ? new Prisma.Decimal(row.subscription.fixedAmountUsd.toString()).toNumber()
          : null;
      let size = 0;
      if (row.subscription.copyMode === 'FIXED_AMOUNT') {
        size =
          leaderPrice > 0 && fixedAmountUsd != null
            ? Math.max(0, fixedAmountUsd / leaderPrice)
            : 0;
      } else if (side === 'BUY') {
        // RATIO BUY: follower available USDC (cached) × copyRatio / price
        const availableUsd = await resolveAvailableUsdcForRatioBuy(row.userId);
        size = computeRatioBuySize({
          availableUsd,
          copyRatio: ratio,
          price: leaderPrice,
        });
      }
      // RATIO SELL: formula unused when lots exist; no-lot fallback is 0 (not leader × ratio)
      const originalNotional = size * leaderPrice;
      let minNotionalAdjusted = false;

      if (COPY_MIN_ORDER_GUARD_ENABLED && side === 'BUY' && leaderPrice > 0) {
        const minTargetNotionalUsd = getBufferedBuyMinNotionalUsd();
        const minBuySize = roundUpToDecimals(
          minTargetNotionalUsd / leaderPrice,
          OUTCOME_SIZE_DECIMALS
        );
        if (size > 0 && size * leaderPrice < minTargetNotionalUsd) {
          size = Math.max(size, minBuySize);
          minNotionalAdjusted = true;
        }
      }

      let sellPositionAvailable: number | null = null;
      let sellCopyLotAvailable: number | null = null;
      let sellCopyLotRowsCount = 0;
      if (side === 'SELL') {
        const formulaSellSize = size;
        await backfillMissingCopyBuyLotsForSubscription({
          prismaClient: prisma as any,
          userId: row.userId,
          subscriptionId: row.subscriptionId,
          tokenID: lt.tokenId,
        });
        sellCopyLotAvailable = await getOpenCopyLotSizeForSubscription({
          prismaClient: prisma as any,
          userId: row.userId,
          subscriptionId: row.subscriptionId,
          tokenID: lt.tokenId,
        });
        sellCopyLotRowsCount = await (prisma as any).copyPositionLot.count({
            where: {
              userId: row.userId,
              subscriptionId: row.subscriptionId,
            },
          });
          const positions = await getUserPositions(row.userId);
          if (positions) {
            const tid = lt.tokenId.trim().toLowerCase();
            const matched = positions.find((p) => (p.asset ?? '').trim().toLowerCase() === tid);
            sellPositionAvailable = matched?.size ?? 0;
          }
          let sellAvailable: number | null = null;
          if (sellCopyLotAvailable != null && sellCopyLotAvailable > 0) {
            sellAvailable = roundDownToDecimals(sellCopyLotAvailable, OUTCOME_SIZE_DECIMALS);
            if (sellPositionAvailable != null && sellPositionAvailable > 0) {
              sellAvailable = roundDownToDecimals(
                Math.min(sellAvailable, sellPositionAvailable),
                OUTCOME_SIZE_DECIMALS
              );
            }
          }
          size = resolveCopySellSize({
            formulaSize: formulaSellSize,
            availableSize: sellAvailable != null && sellAvailable > 0 ? sellAvailable : null,
          });
      }

      const slippagePct = parseSubscriptionSlippage(row.subscription.slippage);
      const orderPrice = resolveCopyOrderPrice(leaderPrice, side, slippagePct);
      const marketBuyAmountUsd =
        side === 'BUY' ? ceilUsdCents(size * orderPrice) : null;

      const riskNotionalUsd =
        marketBuyAmountUsd ?? computeCopyRiskNotionalUsd({ size, orderPrice });

      const riskCtx = {
        userId: row.userId,
        subscription: row.subscription,
        leaderPrice,
        notionalUsd: riskNotionalUsd,
        originalNotionalUsd: originalNotional,
        marketId: lt.marketId,
        tokenId: lt.tokenId,
        side,
        minNotionalAdjusted,
      };

      await prisma.copyTradeRow.update({
        where: { id: row.id },
        data: {
          intendedPrice: formatFixed(orderPrice),
          intendedSize: formatFixed(size),
          intendedNotional: formatFixed(riskNotionalUsd),
          minNotionalAdjusted,
        },
      });

      if (
        side === 'SELL' &&
        (!(sellCopyLotAvailable != null && sellCopyLotAvailable > 0) || sellCopyLotAvailable + 1e-9 < size)
      ) {
        const hasAccountPosition = sellPositionAvailable != null && sellPositionAvailable > 0;
        await markSellNoPositionRow({
          rowId: row.id,
          retryCount: row.retryCount,
          retryable: hasAccountPosition,
          errorMsg: hasAccountPosition
            ? `Copy lot not ready yet; need ${size.toFixed(6)}, available ${(sellCopyLotAvailable ?? 0).toFixed(6)}. Will retry while account still holds shares.`
            : `No copy lot available to sell; need ${size.toFixed(6)}, available ${(sellCopyLotAvailable ?? 0).toFixed(6)}.`,
        });
        return;
      }

      if (size <= 0) {
        await prisma.copyTradeRow.update({
          where: { id: row.id },
          data: {
            status: CopyTradeStatus.skipped,
            errorCode: 'zero_size',
            errorMsg: null,
          },
        });
        return;
      }

      // BUY at $0 is invalid. SELL at $0 is a valid worthless close (resolved loss).
      if (side === 'BUY' && !(size * leaderPrice > 0)) {
        await prisma.copyTradeRow.update({
          where: { id: row.id },
          data: {
            status: CopyTradeStatus.skipped,
            errorCode: 'zero_notional',
            errorMsg: null,
          },
        });
        return;
      }

      const guardDecision = await tradingGuard.evaluate({
        source: 'COPY_DISPATCH',
        userId: row.userId,
        side,
        orderPrice,
        notionalUsd: riskNotionalUsd,
        marketId: lt.marketId,
        tokenId: lt.tokenId,
        leaderAddress: lt.leaderAddress,
        leaderTradeId: lt.id,
        copyTradeRowId: row.id,
        subscriptionId: row.subscriptionId,
        copyRiskContext: riskCtx,
      });
      if (!guardDecision.allowed) {
        await prisma.copyTradeRow.update({
          where: { id: row.id },
          data: {
            status: CopyTradeStatus.skipped,
            errorCode: guardDecision.reasonCode ?? 'risk',
            errorMsg: guardDecision.message,
          },
        });
        return;
      }

      if (side === 'SELL') {
        if (
          (!(sellCopyLotAvailable != null && sellCopyLotAvailable > 0) || sellCopyLotAvailable + 1e-9 < size)
        ) {
          const hasAccountPosition = sellPositionAvailable != null && sellPositionAvailable > 0;
          await markSellNoPositionRow({
            rowId: row.id,
            retryCount: row.retryCount,
            retryable: hasAccountPosition,
            errorMsg: hasAccountPosition
              ? `Copy lot not ready yet; need ${size.toFixed(6)}, available ${(sellCopyLotAvailable ?? 0).toFixed(6)}. Will retry while account still holds shares.`
              : `No copy lot available to sell; need ${size.toFixed(6)}, available ${(sellCopyLotAvailable ?? 0).toFixed(6)}.`,
          });
          return;
        }
        if (sellPositionAvailable != null && (!(sellPositionAvailable > 0) || sellPositionAvailable + 1e-9 < size)) {
          await markSellNoPositionRow({
            rowId: row.id,
            retryCount: row.retryCount,
            retryable: false,
            errorMsg: `Account does not hold enough outcome shares to sell; need ${size.toFixed(6)}, account has ${sellPositionAvailable.toFixed(6)}.`,
          });
          return;
        }
      }

      if (side === 'BUY') {
        const fundingPrecheck = await evaluateCopyOrderFundingPrecheck({
          userId: row.userId,
          side,
          requiredUsd: riskNotionalUsd,
        });
        if (!fundingPrecheck.ok) {
          if (isBuyFundingFailure(fundingPrecheck.errorCode)) {
            const isGasFailure = fundingPrecheck.errorCode === COPY_GAS_INSUFFICIENT_ERROR_CODE;
            const positions = isGasFailure ? null : await getUserPositions(row.userId);
            const { errorCode, errorMsg } = resolveBuyFundingSkipMeta({
              baseErrorCode: fundingPrecheck.errorCode,
              baseErrorMsg: fundingPrecheck.errorMsg,
              positions,
            });

            await handleBuyFundingSkip({
              rowId: row.id,
              userId: row.userId,
              leaderTradeId,
              subscriptionId: row.subscriptionId,
              dispatchSource: source,
              errorCode,
              errorMsg,
            });
            return;
          }
          await prisma.copyTradeRow.update({
            where: { id: row.id },
            data: {
              status: CopyTradeStatus.failed,
              errorCode: fundingPrecheck.errorCode,
              errorMsg: fundingPrecheck.errorMsg,
              retryCount: row.retryCount + 1,
            },
          });
          await maybePauseCopyTradingAfterOrderFailure({
            userId: row.userId,
            errorCode: fundingPrecheck.errorCode,
            errorMsg: fundingPrecheck.errorMsg,
            terminal: true,
          });
          if (isBuyFundingFailure(fundingPrecheck.errorCode)) {
            const isGasFailure = fundingPrecheck.errorCode === COPY_GAS_INSUFFICIENT_ERROR_CODE;
            const positions = isGasFailure ? null : await getUserPositions(row.userId);
            const { errorCode, errorMsg } = resolveBuyFundingSkipMeta({
              baseErrorCode: fundingPrecheck.errorCode,
              baseErrorMsg: fundingPrecheck.errorMsg,
              positions,
            });
            await handleBuyFundingSkip({
              rowId: row.id,
              userId: row.userId,
              leaderTradeId,
              subscriptionId: row.subscriptionId,
              dispatchSource: source,
              errorCode,
              errorMsg,
            });
          }
          return;
        }
      }

      copyT1 = Date.now();
      const res = await runUserSerialized(row.userId, async () => {
        console.log('[copy-dispatch] entering user-serialized order placement', {
          userId: row.userId,
          leaderTradeId,
          copyTradeRowId: row.id,
          tokenId: lt.tokenId,
          side,
          price: orderPrice,
          leaderPrice,
          size,
          notionalUsd: riskNotionalUsd,
          dispatchSource: source,
        });

        return createAndPostOrderForUser(
          row.userId,
          {
            tokenID: lt.tokenId,
            price: orderPrice,
            size,
            side,
            orderType: side === 'BUY' ? 'FAK' : undefined,
            marketBuyAmountUsd: marketBuyAmountUsd ?? undefined,
          },
          undefined,
          {
            source: 'COPY_DISPATCH',
            copyTradeRowId: row.id,
            leaderTradeId,
          }
        );
      });
      copyT2 = Date.now();

      const orderId =
        res && typeof res === 'object' && 'orderID' in res
          ? String((res as { orderID?: string }).orderID ?? '')
          : '';
      const fillSummary = getClobOrderFillSummary(res, side);
      if (side === 'BUY' && !fillSummary.filled) {
        await prisma.copyTradeRow.update({
          where: { id: row.id },
          data: {
            status: CopyTradeStatus.skipped,
            polymarketOrderId: orderId || null,
            errorCode: 'clob_no_liquidity',
            errorMsg: 'BUY not filled: no immediately matchable sell liquidity; FAK canceled the unfilled amount.',
          },
        });
        return;
      }
      const filledSizeRaw =
        fillSummary.size != null && fillSummary.size > 0
          ? fillSummary.size
          : size;
      const executionPrice =
        fillSummary.avgPrice != null && fillSummary.avgPrice > 0
          ? fillSummary.avgPrice
          : orderPrice;
      let filledSize = filledSizeRaw;
      if (side === 'BUY') {
        const intendedNotionalUsd = Number(row.intendedNotional ?? riskNotionalUsd ?? 0);
        const sanitized = sanitizeCopyBuyFillAgainstIntent({
          fillSize: filledSizeRaw,
          fillNotional: fillSummary.notional,
          intendedSize: size,
          intendedNotionalUsd: Number.isFinite(intendedNotionalUsd) ? intendedNotionalUsd : 0,
          executionPrice,
        });
        if (sanitized.corrected) {
          console.warn('[copy-dispatch] corrected inflated BUY fill size', {
            userId: row.userId,
            copyTradeRowId: row.id,
            leaderTradeId,
            tokenId: lt.tokenId,
            rawFillSize: filledSizeRaw,
            rawFillNotional: fillSummary.notional ?? null,
            correctedSize: sanitized.size,
            correctedNotional: sanitized.notional,
            intendedSize: size,
            intendedNotionalUsd,
            executionPrice,
          });
        }
        filledSize = sanitized.size;
      }
      const isPartialVsRequested =
        side === 'SELL' &&
        filledSize > 0 &&
        !sharesFilledEnough(filledSize, size);
      let sellLotsAlreadyConsumed = false;

      if (isPartialVsRequested) {
        const partialLotClose = resolveSellLotCloseFromFill({
          lotRemainingShares: filledSize,
          filledSizeShares: filledSize,
          executionPrice,
          fillNotionalUsd: fillSummary.notional,
        });
        await consumeCopyLotsForSell({
          prismaClient: prisma as any,
          userId: row.userId,
          subscriptionId: row.subscriptionId,
          sellCopyTradeRowId: row.id,
          tokenID: lt.tokenId,
          exitPrice: partialLotClose.exitPrice,
          size: partialLotClose.closeSize,
          allowAdditionalClose: true,
        });
        sellLotsAlreadyConsumed = true;

        let accountPositionAfter: number | null = null;
        const positionsAfterFill = await getUserPositions(row.userId);
        if (positionsAfterFill) {
          const tid = lt.tokenId.trim().toLowerCase();
          const matched = positionsAfterFill.find((p) => (p.asset ?? '').trim().toLowerCase() === tid);
          accountPositionAfter = matched?.size ?? 0;
        }

        await closeResidualCopyLotWhenFlat({
          prismaClient: prisma as any,
          userId: row.userId,
          subscriptionId: row.subscriptionId,
          sellCopyTradeRowId: row.id,
          tokenID: lt.tokenId,
          exitPrice: partialLotClose.exitPrice,
          accountPositionSize: accountPositionAfter,
        });

        const copyLotAfter = await getOpenCopyLotSizeForSubscription({
          prismaClient: prisma as any,
          userId: row.userId,
          subscriptionId: row.subscriptionId,
          tokenID: lt.tokenId,
        });

        if (
          !isCopySellFillComplete({
            requestedSize: size,
            filledSize,
            copyLotBefore: sellCopyLotAvailable,
            copyLotAfter,
            accountPositionAfter,
          })
        ) {
          await prisma.copyTradeRow.update({
            where: { id: row.id },
            data: {
              status: CopyTradeStatus.failed,
              polymarketOrderId: orderId || null,
              filledAmount: formatFixed(filledSize),
              avgPrice: formatFixed(executionPrice),
              errorCode: 'clob_partial_fill',
              errorMsg: `SELL partially filled ${filledSize.toFixed(6)} of ${size.toFixed(6)}; retrying remaining copied lot.`,
              retryCount: row.retryCount + 1,
            },
          });
          void markUserPositionScanActiveBestEffort({
            userId: row.userId,
            hasOpenPosition: true,
            source: 'copy_trade_partial_sell',
          });
          await recordAuditEvent({
            actorType: 'COPY_DISPATCH',
            actorId: String(row.userId),
            userId: row.userId,
            action: 'COPY_ORDER_FAILED',
            targetType: 'CopyTradeRow',
            targetId: row.id,
            result: 'failed',
            reasonCode: 'clob_partial_fill',
            metadata: {
              leaderTradeId,
              subscriptionId: row.subscriptionId,
              tokenId: lt.tokenId,
              side,
              requestedSize: size,
              filledSize,
              polymarketOrderId: orderId || null,
              dispatchSource: source,
            },
          });
          return;
        }
      }

      await prisma.copyTradeRow.update({
        where: { id: row.id },
        data: {
          status: CopyTradeStatus.filled,
          polymarketOrderId: orderId || null,
          filledAmount: formatFixed(side === 'SELL' ? size : filledSize),
          avgPrice: formatFixed(executionPrice),
          errorCode: null,
          errorMsg: null,
        },
      });
      if (side === 'BUY') {
        await clearCopyFundingWarningForCode({
          userId: row.userId,
          errorCode: COPY_COLLATERAL_INSUFFICIENT_WARNING_CODE,
        });
        await clearCopyFundingWarningForCode({
          userId: row.userId,
          errorCode: COPY_FUNDS_EMPTY_ERROR_CODE,
        });
        invalidateCopyFundingPrecheckCache(row.userId);
        await recordCopyBuyLot({
          prismaClient: prisma as any,
          lot: {
            userId: row.userId,
            subscriptionId: row.subscriptionId,
            leaderId: row.subscription.leaderId,
            leaderAddress: lt.leaderAddress,
            tokenID: lt.tokenId,
            buyCopyTradeRowId: row.id,
            entryPrice: executionPrice,
            entrySize: filledSize,
          },
        });
      } else if (!sellLotsAlreadyConsumed) {
        const lotRemaining = await getOpenCopyLotSizeForSubscription({
          prismaClient: prisma as any,
          userId: row.userId,
          subscriptionId: row.subscriptionId,
          tokenID: lt.tokenId,
        });
        const sellLotClose = resolveSellLotCloseFromFill({
          lotRemainingShares: lotRemaining,
          filledSizeShares: filledSize,
          executionPrice,
          fillNotionalUsd: fillSummary.notional,
        });
        if (sellLotClose.closeSize > 1e-6) {
          await consumeCopyLotsForSell({
            prismaClient: prisma as any,
            userId: row.userId,
            subscriptionId: row.subscriptionId,
            sellCopyTradeRowId: row.id,
            tokenID: lt.tokenId,
            exitPrice: sellLotClose.exitPrice,
            size: sellLotClose.closeSize,
            allowAdditionalClose: true,
          });
        }
      } else {
        const lotRemaining = await getOpenCopyLotSizeForSubscription({
          prismaClient: prisma as any,
          userId: row.userId,
          subscriptionId: row.subscriptionId,
          tokenID: lt.tokenId,
        });
        if (lotRemaining > 1e-6) {
          const residualLotClose = resolveSellLotCloseFromFill({
            lotRemainingShares: lotRemaining,
            filledSizeShares: filledSize,
            executionPrice,
            fillNotionalUsd: fillSummary.notional,
          });
          if (residualLotClose.closeSize > 1e-6) {
            await consumeCopyLotsForSell({
              prismaClient: prisma as any,
              userId: row.userId,
              subscriptionId: row.subscriptionId,
              sellCopyTradeRowId: row.id,
              tokenID: lt.tokenId,
              exitPrice: residualLotClose.exitPrice,
              size: residualLotClose.closeSize,
              allowAdditionalClose: true,
            });
          }
        }
      }
      if (side === 'SELL') {
        await syncCopyTradingCollateralFundingState({ userId: row.userId });
      }
      void markUserPositionScanActiveBestEffort({
        userId: row.userId,
        hasOpenPosition: true,
        source: 'copy_trade_filled',
      });
      await recordAuditEvent({
        actorType: 'COPY_DISPATCH',
        actorId: String(row.userId),
        userId: row.userId,
        action: 'COPY_ORDER_SUBMITTED',
        targetType: 'CopyTradeRow',
        targetId: row.id,
        result: 'allowed',
        metadata: {
          leaderTradeId,
          subscriptionId: row.subscriptionId,
          tokenId: lt.tokenId,
          side,
          notionalUsd: riskNotionalUsd,
          polymarketOrderId: orderId || null,
          dispatchSource: source,
        },
      });
      await risk.clearFailureStreak(row.userId, row.subscriptionId);
      await risk.recordFilledNotional(riskCtx);
      await risk.armMarketCooldown(riskCtx);
      recordAdminActivity({
        eventType: 'copy.success',
        title: 'Copy Execution Success',
        level: 'info',
        actorType: 'user',
        actorId: String(row.userId),
        targetType: 'CopyTradeRow',
        targetId: row.id,
        metadata: { leaderTradeId, subscriptionId: row.subscriptionId },
      });
      copyT3 = Date.now();
      console.log('[copy-order-timing]', {
        userId: row.userId,
        copyTradeRowId: row.id,
        leaderTradeId,
        side,
        dispatchSource: source,
        copyPrepMs: copyT1 - copyT0,
        placementMs: copyT2 - copyT1,
        postPlacementDbMs: copyT3 - copyT2,
        totalMs: copyT3 - copyT0,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryCount = row.retryCount + 1;
      const failure = classifyCopyOrderFailure(msg);
      const terminal = !failure.retryable || retryCount >= CONFIG.copyMaxRetries;
      if (terminal && side === 'BUY' && isBuyFundingFailure(failure.errorCode)) {
        const isGasFailure = failure.errorCode === COPY_GAS_INSUFFICIENT_ERROR_CODE;
        const positions = isGasFailure ? null : await getUserPositions(row.userId);
        const { errorCode, errorMsg } = resolveBuyFundingSkipMeta({
          baseErrorCode: failure.errorCode,
          baseErrorMsg: msg.slice(0, 2000),
          positions,
        });
        await handleBuyFundingSkip({
          rowId: row.id,
          userId: row.userId,
          leaderTradeId,
          subscriptionId: row.subscriptionId,
          dispatchSource: source,
          errorCode,
          errorMsg: errorMsg.slice(0, 500),
        });
        return;
      }
      await prisma.copyTradeRow.update({
        where: { id: row.id },
        data: {
          status: terminal ? CopyTradeStatus.dead : CopyTradeStatus.failed,
          errorMsg: msg.slice(0, 2000),
          errorCode: failure.errorCode,
          retryCount,
        },
      });
      if (shouldCountCopyFailureTowardStreak(failure)) {
        await risk.recordFailure(row.userId, row.subscriptionId);
      }
      await maybePauseCopyTradingAfterOrderFailure({
        userId: row.userId,
        errorCode: failure.errorCode,
        errorMsg: msg,
        terminal,
      });
      await recordAuditEvent({
        actorType: 'COPY_DISPATCH',
        actorId: String(row.userId),
        userId: row.userId,
        action: 'COPY_ORDER_FAILED',
        targetType: 'CopyTradeRow',
        targetId: row.id,
        result: terminal ? 'dead' : 'failed',
        reasonCode: failure.errorCode,
        metadata: {
          leaderTradeId,
          subscriptionId: row.subscriptionId,
          tokenId: lt.tokenId,
          side,
          notionalUsd: row.intendedNotional ?? null,
          error: msg.slice(0, 2000),
          dispatchSource: source,
        },
      });
      if (terminal) {
        recordAdminActivity({
          eventType: 'copy.failed',
          title: 'Copy Execution Failed',
          level: 'error',
          actorType: 'user',
          actorId: String(row.userId),
          targetType: 'CopyTradeRow',
          targetId: row.id,
          content: failure.errorCode,
        });
        recordAdminAlert({
          alertType: 'copy.failed',
          title: 'Copy Execution Failed',
          level: 'error',
          source: 'COPY_DISPATCH',
          targetId: row.id,
          content: msg.slice(0, 500),
        });
      }
    }
  });

  const pending = await prisma.copyTradeRow.count({
    where: {
      leaderTradeId: lt.id,
      status: { in: [CopyTradeStatus.queued, CopyTradeStatus.submitting] },
    },
  });
  if (pending === 0) {
    await prisma.leaderTrade.update({ where: { id: lt.id }, data: { processed: true } });
  }

  console.log('[copy-leader-dispatch-summary]', {
    leaderTradeId: lt.id,
    leaderAddress: leader.address,
    dispatchSource: source,
    side: lt.side,
    subscriptionCount: subs.length,
    queuedRows: rows.length,
    pendingAfter: pending,
    processed: pending === 0,
  });
}

export async function dispatchLeaderTrade(
  leaderTradeId: string,
  source: DispatchLeaderTradeSource
): Promise<void> {
  const id = leaderTradeId.trim();
  if (!id) {
    return;
  }

  const previous = leaderTradeDispatchLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  leaderTradeDispatchLocks.set(id, chained);

  await previous;

  const dispatchPromise = (async () => {
    console.log('[copy-trading-nats] dispatch started', { leaderTradeId: id, source });
    await dispatchLeaderTradeInner(id, source);
    console.log('[copy-trading-nats] dispatch completed', { leaderTradeId: id, source });
  })()
    .catch((error) => {
      console.error('[copy-trading-nats] dispatch failed', {
        leaderTradeId: id,
        source,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      release();
      if (leaderTradeDispatchLocks.get(id) === chained) {
        leaderTradeDispatchLocks.delete(id);
      }
    });

  try {
    await waitForDispatchWithTimeout(dispatchPromise, { leaderTradeId: id, source });
  } catch (error) {
    if (error instanceof CopyDispatchTimeoutError) {
      void dispatchPromise.catch(() => undefined);
      console.error('[copy-trading-nats] dispatch timeout; DB replay will retry if needed', {
        leaderTradeId: id,
        source,
        timeoutMs: error.timeoutMs,
      });
    }
    throw error;
  }
}

/** @deprecated 娴ｈ法鏁?dispatchLeaderTrade */
export async function processLeaderTradeDispatch(leaderTradeId: string): Promise<void> {
  await dispatchLeaderTrade(leaderTradeId, 'manual');
}
