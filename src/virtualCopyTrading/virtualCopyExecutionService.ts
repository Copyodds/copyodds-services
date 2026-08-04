import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import type { TradeSide } from '../generated/prisma/enums';
import { CONFIG } from '../config/env';
import { prisma } from '../db';
import {
  boundedStatus,
  virtualCopyErrorClass,
  virtualCopyMetrics,
} from '../observability/virtualCopyMetrics';
import { parseLeaderAmountAsClobSize } from '../copyTrading/services/leaderFillAmount';
import { D, hasSufficientVirtualCash, planFifoCloses, ZERO } from './virtualCopyMath';
import {
  requireOwnedVirtualAccount,
  snapshotAccount,
  VirtualCopyDomainError,
} from './virtualAccountService';
import { quoteVirtualCopyFee, VIRTUAL_COPY_FEE_MODEL_VERSION } from './virtualCopyFeeModel';
import { getVirtualCopyOrderBookReader, getVirtualMarkPriceResolver } from './virtualCopyMarketData';
import { OrderBookUnavailableError, walkOrderBook } from './virtualCopyOrderBook';
import { isVirtualCopyBuySafetyPaused } from './virtualCopyReconciliation';

const OPEN_ACCOUNT_STATUSES = ['ACTIVE', 'PAUSED', 'EXPIRED_CLOSING'] as const;

async function recordTerminalVirtualFailure(executionId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const execution = await tx.virtualCopyExecution.findUnique({
      where: { id: executionId },
      select: { subscriptionId: true },
    });
    if (!execution) return;
    await tx.$queryRaw`SELECT 1 FROM "VirtualCopySubscription" WHERE "id" = ${execution.subscriptionId} FOR UPDATE`;
    const subscription = await tx.virtualCopySubscription.findUnique({
      where: { id: execution.subscriptionId },
    });
    if (!subscription || subscription.deletedAt) return;
    const failStreakCount = subscription.failStreakCount + 1;
    const shouldPause =
      subscription.pauseAfterConsecutiveFails != null &&
      failStreakCount >= subscription.pauseAfterConsecutiveFails;
    await tx.virtualCopySubscription.update({
      where: { id: subscription.id },
      data: {
        failStreakCount,
        failStreakUpdatedAt: new Date(),
        ...(shouldPause
          ? {
              enabled: false,
              status: 'PAUSED',
              pausedAt: new Date(),
              pauseReason: 'CONSECUTIVE_EXECUTION_FAILURES',
            }
          : {}),
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function dispatchVirtualCopyExecutions(
  leaderTradeId: string,
  options?: { runDue?: boolean },
): Promise<number> {
  const trade = await prisma.leaderTrade.findUnique({ where: { id: leaderTradeId } });
  if (!trade?.leaderId) return 0;
  const side = trade.side === 'SELL' ? 'SELL' : 'BUY';
  const closeableSubscriptionIds = side === 'SELL'
    ? (await prisma.virtualPositionLot.findMany({
        where: {
          leaderId: trade.leaderId,
          tokenId: trade.tokenId,
          remainingSize: { gt: 0 },
          account: { status: { in: [...OPEN_ACCOUNT_STATUSES] } },
        },
        select: { subscriptionId: true },
        distinct: ['subscriptionId'],
      })).map((row) => row.subscriptionId)
    : [];
  const subscriptions = await prisma.virtualCopySubscription.findMany({
    where: {
      leaderId: trade.leaderId,
      account: { status: { in: [...OPEN_ACCOUNT_STATUSES] } },
      OR: [
        { enabled: true, status: 'ACTIVE', deletedAt: null },
        ...(closeableSubscriptionIds.length > 0
          ? [{ id: { in: closeableSubscriptionIds } }]
          : []),
      ],
    },
    include: { account: true },
  });
  const leaderPrice = D(trade.price);
  const baseSize = D(parseLeaderAmountAsClobSize(trade.amount, leaderPrice.toNumber()));
  const now = new Date();
  const rows = subscriptions.flatMap((sub) => {
    if (sub.startedAt > trade.createdAt || (sub.onlyBuy && side === 'SELL') || (sub.onlySell && side === 'BUY')) {
      return [];
    }
    let targetSize = sub.copyMode === 'FIXED_AMOUNT' && sub.fixedAmountUsd
      ? sub.fixedAmountUsd.div(leaderPrice)
      : baseSize.mul(sub.copyRatio);
    let targetNotional = targetSize.mul(leaderPrice);
    if (sub.minAmountUsd && targetNotional.lt(sub.minAmountUsd)) {
      if (sub.minNotionalMode === 'SKIP') return [];
      targetNotional = sub.minAmountUsd;
      targetSize = targetNotional.div(leaderPrice);
    }
    if (sub.maxAmountUsd && targetNotional.gt(sub.maxAmountUsd)) {
      targetNotional = sub.maxAmountUsd;
      targetSize = targetNotional.div(leaderPrice);
    }
    if (targetSize.lte(0) || targetNotional.lte(0)) return [];
    return [{
      userId: sub.userId,
      accountId: sub.accountId,
      subscriptionId: sub.id,
      leaderTradeId: trade.id,
      leaderId: trade.leaderId!,
      leaderAddress: trade.leaderAddress,
      marketId: trade.marketId,
      marketTitle: trade.marketTitle,
      tokenId: trade.tokenId,
      outcome: trade.outcome,
      side: side as TradeSide,
      leaderPrice,
      targetSize,
      targetNotionalUsd: targetNotional,
      maxSlippage: sub.maxSlippage,
      fillModel: 'CLOB_ORDER_BOOK_WALK_V1',
      priceSource: 'POLYMARKET_CLOB_PUBLIC_BOOK',
      feeModelVersion: CONFIG.virtualCopyFeeModelVersion,
      feeRate: D(CONFIG.virtualCopyFeeRate),
      configSnapshot: {
        accountId: sub.accountId,
        copyMode: sub.copyMode,
        copyRatio: sub.copyRatio.toString(),
        fixedAmountUsd: sub.fixedAmountUsd?.toString() ?? null,
        minAmountUsd: sub.minAmountUsd?.toString() ?? null,
        maxAmountUsd: sub.maxAmountUsd?.toString() ?? null,
        maxAmountPerMarketUsd: sub.maxAmountPerMarketUsd?.toString() ?? null,
        dailyTotalCapUsd: sub.dailyTotalCapUsd?.toString() ?? null,
        maxSlippage: sub.maxSlippage?.toString() ?? null,
        delayMs: sub.delayMs,
        marketCooldownMinutes: sub.marketCooldownMinutes,
        skipBuyIfOpenPosition: sub.skipBuyIfOpenPosition,
        feeModelVersion: CONFIG.virtualCopyFeeModelVersion,
        feeRate: CONFIG.virtualCopyFeeRate.toString(),
      },
      scheduledAt: new Date(Math.max(now.getTime(), trade.createdAt.getTime() + sub.delayMs)),
    }];
  });
  virtualCopyMetrics.fanout.observe(rows.length);
  if (rows.length === 0) return 0;
  const result = await prisma.virtualCopyExecution.createMany({ data: rows, skipDuplicates: true });
  if (options?.runDue !== false) {
    await runDueVirtualCopyExecutions(Math.max(50, rows.length));
  }
  return result.count;
}

export async function replayRecentVirtualCopyExecutions(
  since: Date,
  limit = 500,
): Promise<{ scanned: number; created: number; lastCreatedAt: Date | null }> {
  const trades = await prisma.leaderTrade.findMany({
    where: {
      createdAt: { gte: since },
      leader: {
        virtualSubscriptions: {
          some: {
            deletedAt: null,
            account: { status: { in: [...OPEN_ACCOUNT_STATUSES] } },
          },
        },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, createdAt: true },
  });
  let created = 0;
  for (const trade of trades) {
    created += await dispatchVirtualCopyExecutions(trade.id, { runDue: false });
  }
  if (created > 0) {
    await runDueVirtualCopyExecutions(Math.max(100, created));
  }
  return {
    scanned: trades.length,
    created,
    lastCreatedAt: trades.at(-1)?.createdAt ?? null,
  };
}

const VIRTUAL_REPLAY_CHECKPOINT_KEY = 'virtual-copy-leader-trades-v1';

/**
 * Replays leader trades from a durable (createdAt,id) checkpoint.
 * The composite cursor avoids losing rows when a batch boundary contains equal timestamps.
 */
export async function replayPendingVirtualCopyExecutions(
  limit = 500,
): Promise<{ scanned: number; created: number; lastCreatedAt: Date | null }> {
  const checkpoint = await prisma.virtualCopyReplayCheckpoint.findUnique({
    where: { key: VIRTUAL_REPLAY_CHECKPOINT_KEY },
  });
  const earliestSubscription = checkpoint
    ? null
    : await prisma.virtualCopySubscription.findFirst({
        where: {
          deletedAt: null,
          account: { status: { in: [...OPEN_ACCOUNT_STATUSES] } },
        },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        select: { startedAt: true },
      });
  if (!checkpoint && !earliestSubscription) {
    return { scanned: 0, created: 0, lastCreatedAt: null };
  }
  const activeLeaders = await prisma.virtualCopySubscription.findMany({
    where: {
      deletedAt: null,
      account: { status: { in: [...OPEN_ACCOUNT_STATUSES] } },
    },
    select: { leaderId: true },
    distinct: ['leaderId'],
  });
  if (activeLeaders.length === 0) {
    return { scanned: 0, created: 0, lastCreatedAt: null };
  }

  const trades = await prisma.leaderTrade.findMany({
    where: {
      ...(checkpoint
        ? {
            OR: [
              { createdAt: { gt: checkpoint.lastCreatedAt } },
              {
                createdAt: checkpoint.lastCreatedAt,
                id: { gt: checkpoint.lastTradeId },
              },
            ],
          }
        : { createdAt: { gte: earliestSubscription!.startedAt } }),
      leaderId: { in: activeLeaders.map((row) => row.leaderId) },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(limit, 5_000)),
    select: { id: true, createdAt: true },
  });

  let created = 0;
  for (const trade of trades) {
    created += await dispatchVirtualCopyExecutions(trade.id, { runDue: false });
  }
  if (created > 0) {
    await runDueVirtualCopyExecutions(Math.max(100, created));
  }
  const last = trades.at(-1);
  if (last) {
    await prisma.$executeRaw`
      INSERT INTO "VirtualCopyReplayCheckpoint"
        ("key", "lastCreatedAt", "lastTradeId", "createdAt", "updatedAt")
      VALUES
        (${VIRTUAL_REPLAY_CHECKPOINT_KEY}, ${last.createdAt}, ${last.id}, NOW(), NOW())
      ON CONFLICT ("key") DO UPDATE
      SET "lastCreatedAt" = EXCLUDED."lastCreatedAt",
          "lastTradeId" = EXCLUDED."lastTradeId",
          "updatedAt" = NOW()
      WHERE ("VirtualCopyReplayCheckpoint"."lastCreatedAt", "VirtualCopyReplayCheckpoint"."lastTradeId")
          < (EXCLUDED."lastCreatedAt", EXCLUDED."lastTradeId")
    `;
    virtualCopyMetrics.replayLagSeconds.set(
      Math.max(0, (Date.now() - last.createdAt.getTime()) / 1_000),
    );
  }
  return {
    scanned: trades.length,
    created,
    lastCreatedAt: last?.createdAt ?? null,
  };
}

export async function executeVirtualCopyExecution(executionId: string): Promise<void> {
  const executionStartedAt = performance.now();
  const claimToken = randomUUID();
  const claimedAt = new Date();
  const claimed = await prisma.virtualCopyExecution.updateMany({
    where: { id: executionId, status: 'QUEUED', scheduledAt: { lte: claimedAt } },
    data: {
      status: 'SIMULATING',
      claimedAt,
      claimToken,
      claimExpiresAt: new Date(claimedAt.getTime() + CONFIG.virtualCopyClaimLeaseMs),
    },
  });
  if (claimed.count !== 1) return;

  try {
    const marketExecution = await prisma.virtualCopyExecution.findUniqueOrThrow({
      where: { id: executionId },
    });
    let requestedBookSize = marketExecution.targetSize;
    if (marketExecution.side === 'SELL') {
      const available = await prisma.virtualPositionLot.aggregate({
        where: {
          accountId: marketExecution.accountId,
          userId: marketExecution.userId,
          subscriptionId: marketExecution.subscriptionId,
          tokenId: marketExecution.tokenId,
          remainingSize: { gt: 0 },
        },
        _sum: { remainingSize: true },
      });
      requestedBookSize = Prisma.Decimal.min(
        requestedBookSize,
        available._sum.remainingSize ?? ZERO,
      );
      if (requestedBookSize.lte(0)) {
        await prisma.virtualCopyExecution.update({
          where: { id: executionId },
          data: {
            status: 'SKIPPED',
            errorCode: 'virtual_no_position',
            errorMessage: 'No account lot available to sell',
          },
        });
        return;
      }
    }
    let book;
    try {
      book = await getVirtualCopyOrderBookReader().read(marketExecution.tokenId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.virtualCopyExecution.update({
        where: { id: executionId },
        data: {
          status: 'SKIPPED',
          errorCode: error instanceof OrderBookUnavailableError
            ? error.code
            : 'virtual_order_book_unavailable',
          errorMessage: message.slice(0, 1000),
        },
      });
      return;
    }
    const maxSlippage = marketExecution.maxSlippage ?? D(CONFIG.virtualCopyDefaultMaxSlippage);
    const fill = walkOrderBook({
      book,
      side: marketExecution.side,
      targetSize: requestedBookSize,
      referencePrice: marketExecution.leaderPrice,
      maxSlippage,
    });
    if (!fill) {
      await prisma.virtualCopyExecution.update({
        where: { id: executionId },
        data: {
          status: 'SKIPPED',
          errorCode: 'virtual_order_book_no_fill',
          errorMessage: 'No trusted order book liquidity is executable inside the maximum slippage limit',
          priceObservedAt: book.observedAt,
        },
      });
      return;
    }
    const executionConfig = marketExecution.configSnapshot as Record<string, unknown>;
    const minimumFillNotional = typeof executionConfig.minAmountUsd === 'string'
      ? D(executionConfig.minAmountUsd)
      : null;
    if (minimumFillNotional && fill.grossNotionalUsd.lt(minimumFillNotional)) {
      await prisma.virtualCopyExecution.update({
        where: { id: executionId },
        data: {
          status: 'SKIPPED',
          errorCode: 'virtual_partial_fill_below_minimum',
          errorMessage: 'Executable order book depth is below the configured minimum notional',
          priceObservedAt: book.observedAt,
          limitPrice: fill.limitPrice,
          unfilledSize: fill.unfilledSize,
          orderBookEvidence: {
            source: book.source,
            observedAt: book.observedAt.toISOString(),
            consumedLevels: fill.consumedLevels,
          },
        },
      });
      return;
    }
    const feeRate = typeof executionConfig.feeRate === 'string'
      ? D(executionConfig.feeRate)
      : D(CONFIG.virtualCopyFeeRate);
    const feeModelVersion = VIRTUAL_COPY_FEE_MODEL_VERSION;
    const evidence = {
      source: book.source,
      observedAt: book.observedAt.toISOString(),
      bestBid: book.bids[0]?.price.toString() ?? null,
      bestAsk: book.asks[0]?.price.toString() ?? null,
      bidLevelCount: book.bids.length,
      askLevelCount: book.asks.length,
      consumedLevels: fill.consumedLevels,
      limitPrice: fill.limitPrice.toString(),
      requestedSize: requestedBookSize.toString(),
      unfilledSize: fill.unfilledSize.toString(),
    };

    await prisma.$transaction(async (tx) => {
      const execution = await tx.virtualCopyExecution.findUniqueOrThrow({
        where: { id: executionId },
        include: { account: true },
      });
      if (execution.status !== 'SIMULATING' || execution.claimToken !== claimToken) return;
      const lockStartedAt = performance.now();
      await tx.$queryRaw`SELECT 1 FROM "VirtualCopyAccount" WHERE "id" = ${execution.accountId} FOR UPDATE`;
      virtualCopyMetrics.lockWaitSeconds
        .labels('execution_account')
        .observe((performance.now() - lockStartedAt) / 1_000);
      const account = await tx.virtualCopyAccount.findUniqueOrThrow({ where: { id: execution.accountId } });
      if (account.userId !== execution.userId || account.status === 'ARCHIVED' || account.status === 'SETTLED') {
        await tx.virtualCopyExecution.update({
          where: { id: execution.id },
          data: { status: 'SKIPPED', errorCode: 'virtual_account_unavailable', errorMessage: 'Account unavailable' },
        });
        return;
      }
      const now = new Date();
      if (
        execution.side === 'BUY'
        && (!CONFIG.virtualCopyBuyEnabled || await isVirtualCopyBuySafetyPaused(tx))
      ) {
        await tx.virtualCopyExecution.update({
          where: { id: execution.id },
          data: {
            status: 'SKIPPED',
            errorCode: 'virtual_buy_kill_switch',
            errorMessage: 'Opening new virtual positions is temporarily disabled',
          },
        });
        return;
      }
      if (execution.side === 'BUY' && (account.status !== 'ACTIVE' || account.expiresAt <= now)) {
        await tx.virtualCopyExecution.update({
          where: { id: execution.id },
          data: { status: 'SKIPPED', errorCode: 'virtual_account_expired', errorMessage: 'Expired accounts cannot open BUY positions' },
        });
        return;
      }
      const config = execution.configSnapshot as Record<string, unknown>;
      const fillNotional = fill.grossNotionalUsd;
      if (execution.side === 'BUY') {
        const maxAmount = typeof config.maxAmountUsd === 'string'
          ? D(config.maxAmountUsd) : null;
        if (maxAmount && fillNotional.gt(maxAmount)) {
          await tx.virtualCopyExecution.update({
            where: { id: execution.id },
            data: { status: 'SKIPPED', errorCode: 'virtual_max_amount', errorMessage: 'Slippage-adjusted notional exceeds per-trade cap' },
          });
          return;
        }
        const dailyCap = typeof config.dailyTotalCapUsd === 'string' ? D(config.dailyTotalCapUsd) : null;
        if (dailyCap) {
          const dayStart = new Date(now);
          dayStart.setUTCHours(0, 0, 0, 0);
          const used = await tx.virtualCopyExecution.aggregate({
            where: {
              accountId: account.id,
              subscriptionId: execution.subscriptionId,
              side: 'BUY',
              status: { in: ['FILLED', 'PARTIALLY_FILLED'] },
              filledAt: { gte: dayStart },
            },
            _sum: { simulatedNotionalUsd: true },
          });
          if ((used._sum.simulatedNotionalUsd ?? ZERO).add(fillNotional).gt(dailyCap)) {
            await tx.virtualCopyExecution.update({
              where: { id: execution.id },
              data: { status: 'SKIPPED', errorCode: 'virtual_daily_cap', errorMessage: 'Daily virtual notional cap exceeded' },
            });
            return;
          }
        }
        const marketCap = typeof config.maxAmountPerMarketUsd === 'string'
          ? D(config.maxAmountPerMarketUsd) : null;
        if (marketCap) {
          const marketLots = await tx.virtualPositionLot.findMany({
            where: {
              accountId: account.id,
              subscriptionId: execution.subscriptionId,
              remainingSize: { gt: 0 },
              ...(execution.marketId ? { marketId: execution.marketId } : { tokenId: execution.tokenId }),
            },
            select: { remainingSize: true, entryPrice: true },
          });
          const exposure = marketLots.reduce(
            (sum, lot) => sum.add(lot.remainingSize.mul(lot.entryPrice)),
            ZERO,
          );
          if (exposure.add(fillNotional).gt(marketCap)) {
            await tx.virtualCopyExecution.update({
              where: { id: execution.id },
              data: { status: 'SKIPPED', errorCode: 'virtual_market_cap', errorMessage: 'Per-market virtual cap exceeded' },
            });
            return;
          }
        }
        const cooldownMinutes = Number(config.marketCooldownMinutes ?? 0);
        if (cooldownMinutes > 0) {
          const recent = await tx.virtualCopyExecution.count({
            where: {
              id: { not: execution.id },
              accountId: account.id,
              subscriptionId: execution.subscriptionId,
              side: 'BUY',
              status: { in: ['FILLED', 'PARTIALLY_FILLED'] },
              filledAt: { gte: new Date(now.getTime() - cooldownMinutes * 60_000) },
              ...(execution.marketId ? { marketId: execution.marketId } : { tokenId: execution.tokenId }),
            },
          });
          if (recent > 0) {
            await tx.virtualCopyExecution.update({
              where: { id: execution.id },
              data: { status: 'SKIPPED', errorCode: 'virtual_market_cooldown', errorMessage: 'Virtual market cooldown active' },
            });
            return;
          }
        }
        const skipBuyIfOpen =
          config.skipBuyIfOpenPosition === undefined
            ? true
            : Boolean(config.skipBuyIfOpenPosition);
        if (skipBuyIfOpen) {
          const openLots = await tx.virtualPositionLot.findMany({
            where: {
              accountId: account.id,
              subscriptionId: execution.subscriptionId,
              remainingSize: { gt: 0 },
              tokenId: execution.tokenId,
            },
            select: { remainingSize: true },
          });
          const openSize = openLots.reduce(
            (sum, lot) => sum.add(lot.remainingSize),
            ZERO,
          );
          if (openSize.gt(0.01)) {
            await tx.virtualCopyExecution.update({
              where: { id: execution.id },
              data: {
                status: 'SKIPPED',
                errorCode: 'virtual_already_open_position',
                errorMessage:
                  'Open virtual position already exists for this outcome; skipped add-on BUY',
              },
            });
            return;
          }
        }
      }
      if (execution.side === 'BUY') {
        const notional = fillNotional;
        const fee = quoteVirtualCopyFee(notional, {
          version: feeModelVersion,
          rate: feeRate,
        });
        if (!hasSufficientVirtualCash(account.cashBalanceUsd, fee.requiredCashUsd)) {
          await tx.virtualCopyExecution.update({
            where: { id: execution.id },
            data: { status: 'SKIPPED', errorCode: 'virtual_insufficient_cash', errorMessage: 'Insufficient virtual cash' },
          });
          return;
        }
        const balanceAfter = account.cashBalanceUsd.sub(fee.requiredCashUsd);
        await tx.virtualCopyAccount.update({
          where: { id: account.id },
          data: { cashBalanceUsd: balanceAfter, version: { increment: 1 } },
        });
        await tx.virtualAccountLedger.create({
          data: {
            userId: execution.userId, accountId: account.id, direction: 'DEBIT', category: 'BUY_DEBIT',
            amountUsd: fee.requiredCashUsd, balanceAfterUsd: balanceAfter, refType: 'VirtualCopyExecution',
            refId: execution.id, idempotencyKey: `virtual-buy:${execution.id}`,
            metadata: {
              grossNotionalUsd: notional.toString(),
              feeUsd: fee.feeUsd.toString(),
              feeModelVersion,
              feeRate: feeRate.toString(),
            },
          },
        });
        await tx.virtualPositionLot.create({
          data: {
            userId: execution.userId, accountId: account.id, subscriptionId: execution.subscriptionId,
            leaderId: execution.leaderId, leaderAddress: execution.leaderAddress, marketId: execution.marketId,
            tokenId: execution.tokenId, buyExecutionId: execution.id, entryPrice: fill.averagePrice,
            entrySize: fill.filledSize, remainingSize: fill.filledSize,
            entryNotionalUsd: notional, entryFeeUsd: fee.feeUsd, openedAt: now,
          },
        });
        await tx.virtualCopyExecution.update({
          where: { id: execution.id },
          data: {
            status: fill.unfilledSize.gt(0) ? 'PARTIALLY_FILLED' : 'FILLED',
            simulatedFillSize: fill.filledSize, simulatedAvgPrice: fill.averagePrice,
            simulatedNotionalUsd: notional, simulatedFeeUsd: fee.feeUsd,
            slippageAmountUsd: fill.averagePrice.sub(execution.leaderPrice).mul(fill.filledSize),
            slippageBps: fill.slippageBps,
            feeRate,
            feeModelVersion,
            limitPrice: fill.limitPrice,
            unfilledSize: fill.unfilledSize,
            fillModel: 'CLOB_ORDER_BOOK_WALK_V1',
            priceSource: book.source,
            priceObservedAt: book.observedAt,
            priceStalenessMs: Math.max(0, now.getTime() - book.observedAt.getTime()),
            orderBookEvidence: evidence,
            configSnapshot: {
              ...config,
              feeModelVersion,
              feeRate: feeRate.toString(),
              orderBookEvidence: evidence,
            },
            filledAt: now,
          },
        });
      } else {
        await tx.$queryRaw`SELECT 1 FROM "VirtualPositionLot" WHERE "accountId" = ${account.id} AND "subscriptionId" = ${execution.subscriptionId} AND "tokenId" = ${execution.tokenId} AND "remainingSize" > 0 ORDER BY "openedAt" FOR UPDATE`;
        const lots = await tx.virtualPositionLot.findMany({
          where: {
            accountId: account.id, userId: execution.userId, subscriptionId: execution.subscriptionId,
            tokenId: execution.tokenId, remainingSize: { gt: 0 },
          },
          orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
        });
        const plan = planFifoCloses(lots, fill.filledSize, fill.averagePrice, feeRate);
        if (plan.filledSize.lte(0)) {
          await tx.virtualCopyExecution.update({
            where: { id: execution.id },
            data: { status: 'SKIPPED', errorCode: 'virtual_no_position', errorMessage: 'No account lot available to sell' },
          });
          return;
        }
        let totalProceeds = ZERO;
        let realizedPnl = ZERO;
        let totalExitFee = ZERO;
        for (const close of plan.closes) {
          const lot = lots.find((item) => item.id === close.lotId)!;
          const newRemaining = lot.remainingSize.sub(close.closedSize);
          await tx.virtualPositionLot.update({
            where: { id: lot.id },
            data: {
              remainingSize: newRemaining,
              entryFeeUsd: Prisma.Decimal.max(
                ZERO,
                lot.entryFeeUsd.sub(close.allocatedEntryFeeUsd),
              ),
              status: newRemaining.lte(0) ? 'CLOSED' : 'OPEN',
              closedAt: newRemaining.lte(0) ? now : null,
            },
          });
          await tx.virtualPositionLotClose.create({
            data: {
              userId: execution.userId, accountId: account.id, subscriptionId: execution.subscriptionId,
              lotId: lot.id, buyExecutionId: lot.buyExecutionId, sellExecutionId: execution.id,
              tokenId: execution.tokenId, closedSize: close.closedSize, entryPrice: lot.entryPrice,
              exitPrice: fill.averagePrice, costBasisUsd: close.costBasisUsd, proceedsUsd: close.proceedsUsd,
              allocatedEntryFeeUsd: close.allocatedEntryFeeUsd,
              exitFeeUsd: close.exitFeeUsd,
              allocatedFeeUsd: close.allocatedEntryFeeUsd.add(close.exitFeeUsd),
              realizedPnlUsd: close.realizedPnlUsd,
              closeReason:
                (execution.configSnapshot as Record<string, unknown>).manualClose === true
                  ? 'MANUAL_CLOSE'
                  : 'LEADER_SELL',
            },
          });
          totalProceeds = totalProceeds.add(close.proceedsUsd);
          realizedPnl = realizedPnl.add(close.realizedPnlUsd);
          totalExitFee = totalExitFee.add(close.exitFeeUsd);
        }
        const balanceAfter = account.cashBalanceUsd.add(totalProceeds);
        await tx.virtualCopyAccount.update({
          where: { id: account.id },
          data: { cashBalanceUsd: balanceAfter, realizedPnlUsd: { increment: realizedPnl }, version: { increment: 1 } },
        });
        await tx.virtualAccountLedger.create({
          data: {
            userId: execution.userId, accountId: account.id, direction: 'CREDIT', category: 'SELL_CREDIT',
            amountUsd: totalProceeds, balanceAfterUsd: balanceAfter, refType: 'VirtualCopyExecution',
            refId: execution.id, idempotencyKey: `virtual-sell:${execution.id}`,
            metadata: {
              grossNotionalUsd: plan.filledSize.mul(fill.averagePrice).toString(),
              feeUsd: totalExitFee.toString(),
              feeModelVersion,
              feeRate: feeRate.toString(),
            },
          },
        });
        await tx.virtualCopyExecution.update({
          where: { id: execution.id },
          data: {
            status:
              plan.filledSize.lt(execution.targetSize) || fill.unfilledSize.gt(0)
                ? 'PARTIALLY_FILLED'
                : 'FILLED',
            simulatedFillSize: plan.filledSize, simulatedAvgPrice: fill.averagePrice,
            simulatedNotionalUsd: plan.filledSize.mul(fill.averagePrice), simulatedFeeUsd: totalExitFee,
            slippageAmountUsd: execution.leaderPrice.sub(fill.averagePrice).mul(plan.filledSize),
            slippageBps: fill.slippageBps,
            feeRate,
            feeModelVersion,
            limitPrice: fill.limitPrice,
            unfilledSize: execution.targetSize.sub(plan.filledSize),
            fillModel: 'CLOB_ORDER_BOOK_WALK_V1',
            priceSource: book.source,
            priceObservedAt: book.observedAt,
            priceStalenessMs: Math.max(0, now.getTime() - book.observedAt.getTime()),
            orderBookEvidence: evidence,
            configSnapshot: {
              ...config,
              feeModelVersion,
              feeRate: feeRate.toString(),
              orderBookEvidence: evidence,
            },
            filledAt: now,
          },
        });
      }
      await tx.virtualCopySubscription.updateMany({
        where: {
          id: execution.subscriptionId,
          OR: [
            { failStreakCount: { gt: 0 } },
            { failStreakUpdatedAt: { not: null } },
          ],
        },
        data: { failStreakCount: 0, failStreakUpdatedAt: null },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const completed = await prisma.virtualCopyExecution.findUnique({
      where: { id: executionId },
      select: { accountId: true, status: true },
    });
    if (completed?.status === 'FILLED' || completed?.status === 'PARTIALLY_FILLED') {
      await snapshotAccount(completed.accountId).catch((error) => {
        console.error('[virtual-copy] mark-to-market snapshot failed', {
          executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    const retry = await prisma.virtualCopyExecution.updateMany({
      where: {
        id: executionId,
        status: 'SIMULATING',
        claimToken,
        retryCount: { lt: 2 },
      },
      data: {
        status: 'QUEUED',
        claimToken: null,
        claimExpiresAt: null,
        errorCode: 'virtual_execution_failed',
        errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        retryCount: { increment: 1 },
      },
    });
    if (retry.count === 0) {
      const dead = await prisma.virtualCopyExecution.updateMany({
        where: { id: executionId, status: 'SIMULATING', claimToken },
        data: {
          status: 'DEAD',
          claimToken: null,
          claimExpiresAt: null,
          errorCode: 'virtual_execution_failed',
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          retryCount: { increment: 1 },
        },
      });
      if (dead.count === 1) {
        await recordTerminalVirtualFailure(executionId);
      }
    }
  } finally {
    const observed = await prisma.virtualCopyExecution.findUnique({
      where: { id: executionId },
      select: {
        status: true,
        errorCode: true,
        side: true,
        executionSource: true,
        slippageBps: true,
        simulatedFeeUsd: true,
      },
    }).catch(() => null);
    if (observed) {
      const status = boundedStatus(observed.status);
      const source = observed.executionSource === 'MANUAL_CLOSE'
        ? 'manual'
        : observed.executionSource === 'MARKET_SETTLEMENT'
          ? 'settlement'
          : 'leader';
      const side = observed.side.toLowerCase();
      virtualCopyMetrics.executions
        .labels(status, virtualCopyErrorClass(observed.errorCode), side, source)
        .inc();
      virtualCopyMetrics.executionDurationSeconds
        .labels(status)
        .observe((performance.now() - executionStartedAt) / 1_000);
      if (observed.slippageBps != null) {
        virtualCopyMetrics.slippageBps.labels(side).observe(Math.max(0, observed.slippageBps));
      }
      if (observed.simulatedFeeUsd != null) {
        virtualCopyMetrics.feesUsd.labels(side).observe(observed.simulatedFeeUsd.toNumber());
      }
      if (observed.status === 'PARTIALLY_FILLED') {
        virtualCopyMetrics.executionConditions.labels('partial_fill', side).inc();
      }
      if (observed.errorCode === 'virtual_insufficient_cash') {
        virtualCopyMetrics.executionConditions.labels('insufficient_cash', side).inc();
      }
      if (observed.errorCode === 'virtual_partial_fill_below_minimum') {
        virtualCopyMetrics.executionConditions.labels('partial_below_minimum', side).inc();
      }
    }
  }
}

export async function runDueVirtualCopyExecutions(limit = 100): Promise<number> {
  const recovered = await prisma.virtualCopyExecution.updateMany({
    where: {
      status: 'SIMULATING',
      claimExpiresAt: { lt: new Date() },
      retryCount: { lt: 3 },
    },
    data: {
      status: 'QUEUED',
      claimToken: null,
      claimExpiresAt: null,
      errorCode: 'virtual_stale_claim_recovered',
      retryCount: { increment: 1 },
    },
  });
  if (recovered.count > 0) virtualCopyMetrics.staleClaims.inc(recovered.count);
  const rows = await prisma.virtualCopyExecution.findMany({
    where: { status: 'QUEUED', scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: 'asc' },
    take: limit,
    select: { id: true, accountId: true },
  });
  const byAccount = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byAccount.get(row.accountId) ?? [];
    ids.push(row.id);
    byAccount.set(row.accountId, ids);
  }
  const accountQueues = [...byAccount.values()];
  for (let offset = 0; offset < accountQueues.length; offset += CONFIG.virtualCopyWorkerConcurrency) {
    await Promise.all(
      accountQueues
        .slice(offset, offset + CONFIG.virtualCopyWorkerConcurrency)
        .map(async (ids) => {
          for (const id of ids) await executeVirtualCopyExecution(id);
        }),
    );
  }
  return rows.length;
}

export async function previewVirtualPositionClose(params: {
  userId: number;
  accountId: string;
  tokenId: string;
  size?: string;
  idempotencyKey: string;
}) {
  const account = await requireOwnedVirtualAccount(params.userId, params.accountId);
  if (account.status === 'ARCHIVED' || account.status === 'SETTLED') {
    throw new VirtualCopyDomainError('Virtual account cannot be traded', 409, 'CONFLICT');
  }
  const tokenId = params.tokenId.trim();
  const lots = await prisma.virtualPositionLot.findMany({
    where: {
      userId: params.userId,
      accountId: params.accountId,
      tokenId,
      remainingSize: { gt: 0 },
    },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
  });
  if (lots.length === 0) {
    throw new VirtualCopyDomainError('Virtual position not found', 404, 'NOT_FOUND');
  }
  const available = lots.reduce((sum, lot) => sum.add(lot.remainingSize), ZERO);
  const requested = params.size == null ? available : D(params.size);
  if (requested.lte(0) || requested.gt(available)) {
    throw new VirtualCopyDomainError('Close size exceeds the available virtual position', 409, 'CONFLICT');
  }
  const existing = await prisma.virtualPositionCloseQuote.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  });
  if (existing) {
    if (existing.userId !== params.userId || existing.accountId !== params.accountId || existing.tokenId !== tokenId) {
      throw new VirtualCopyDomainError('Close quote idempotency key is already in use', 409, 'CONFLICT');
    }
    return existing;
  }

  const [book, mark] = await Promise.all([
    getVirtualCopyOrderBookReader().read(tokenId),
    getVirtualMarkPriceResolver().resolve(tokenId),
  ]);
  if (!mark.price || mark.status === 'UNAVAILABLE' || mark.status === 'STALE') {
    throw new VirtualCopyDomainError('A fresh authoritative mark price is required', 409, 'CONFLICT');
  }
  const maxSlippage = D(CONFIG.virtualCopyManualCloseMaxSlippage);
  const fill = walkOrderBook({
    book,
    side: 'SELL',
    targetSize: requested,
    referencePrice: mark.price,
    maxSlippage,
  });
  if (!fill) {
    throw new VirtualCopyDomainError('No executable bid liquidity inside the maximum slippage limit', 409, 'CONFLICT');
  }
  const feeRate = D(CONFIG.virtualCopyFeeRate);
  const fee = quoteVirtualCopyFee(fill.grossNotionalUsd, {
    version: VIRTUAL_COPY_FEE_MODEL_VERSION,
    rate: feeRate,
  });
  const fifo = planFifoCloses(lots, fill.filledSize, fill.averagePrice, feeRate);
  const realizedPnl = fifo.closes.reduce((sum, close) => sum.add(close.realizedPnlUsd), ZERO);
  const now = new Date();
  return prisma.virtualPositionCloseQuote.create({
    data: {
      userId: params.userId,
      accountId: params.accountId,
      tokenId,
      requestedSize: requested,
      estimatedFillSize: fill.filledSize,
      estimatedAvgPrice: fill.averagePrice,
      estimatedGrossUsd: fill.grossNotionalUsd,
      estimatedFeeUsd: fee.feeUsd,
      estimatedProceedsUsd: fee.netProceedsUsd,
      estimatedRealizedPnlUsd: realizedPnl,
      slippageBps: fill.slippageBps,
      priceSource: book.source,
      priceObservedAt: book.observedAt,
      feeModelVersion: VIRTUAL_COPY_FEE_MODEL_VERSION,
      feeRate,
      orderBookEvidence: {
        markPrice: mark.price.toString(),
        markSource: mark.source,
        markAsOf: mark.asOf?.toISOString() ?? null,
        bestBid: book.bids[0]?.price.toString() ?? null,
        bestAsk: book.asks[0]?.price.toString() ?? null,
        consumedLevels: fill.consumedLevels,
        limitPrice: fill.limitPrice.toString(),
        unfilledSize: fill.unfilledSize.toString(),
      },
      expiresAt: new Date(now.getTime() + CONFIG.virtualCopyCloseQuoteTtlMs),
      idempotencyKey: params.idempotencyKey,
    },
  });
}

export async function confirmVirtualPositionClose(params: {
  userId: number;
  accountId: string;
  tokenId: string;
  quoteId: string;
  idempotencyKey: string;
}): Promise<{ executionIds: string[]; requestedSize: string }> {
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "VirtualPositionCloseQuote" WHERE "id" = ${params.quoteId} FOR UPDATE`;
    const quote = await tx.virtualPositionCloseQuote.findFirst({
      where: {
        id: params.quoteId,
        userId: params.userId,
        accountId: params.accountId,
        tokenId: params.tokenId.trim(),
      },
    });
    if (!quote) throw new VirtualCopyDomainError('Close quote not found', 404, 'NOT_FOUND');
    if (quote.status === 'CONSUMED') {
      const existing = await tx.virtualCopyExecution.findMany({
        where: { idempotencyKey: { startsWith: `virtual-manual-close:${params.idempotencyKey}:` } },
        select: { id: true },
      });
      if (existing.length > 0) {
        return { executionIds: existing.map((row) => row.id), requestedSize: quote.requestedSize.toString() };
      }
      throw new VirtualCopyDomainError('Close quote was already consumed', 409, 'CONFLICT');
    }
    if (quote.status !== 'ACTIVE' || quote.expiresAt <= now) {
      await tx.virtualPositionCloseQuote.update({
        where: { id: quote.id },
        data: { status: 'EXPIRED' },
      });
      throw new VirtualCopyDomainError('Close quote expired; refresh the preview', 409, 'CONFLICT');
    }
    await tx.$queryRaw`SELECT 1 FROM "VirtualCopyAccount" WHERE "id" = ${params.accountId} FOR UPDATE`;
    const account = await tx.virtualCopyAccount.findFirst({
      where: { id: params.accountId, userId: params.userId },
    });
    if (!account || account.status === 'ARCHIVED' || account.status === 'SETTLED') {
      throw new VirtualCopyDomainError('Virtual account cannot be traded', 409, 'CONFLICT');
    }
    await tx.$queryRaw`SELECT 1 FROM "VirtualPositionLot" WHERE "accountId" = ${params.accountId} AND "tokenId" = ${params.tokenId.trim()} AND "remainingSize" > 0 ORDER BY "openedAt" FOR UPDATE`;
    const lots = await tx.virtualPositionLot.findMany({
      where: {
        userId: params.userId,
        accountId: params.accountId,
        tokenId: params.tokenId.trim(),
        remainingSize: { gt: 0 },
      },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    });
    const available = lots.reduce((sum, lot) => sum.add(lot.remainingSize), ZERO);
    if (available.lt(quote.estimatedFillSize)) {
      throw new VirtualCopyDomainError('Position changed after preview; refresh the quote', 409, 'CONFLICT');
    }
    const grouped = new Map<string, { first: (typeof lots)[number]; size: Prisma.Decimal }>();
    let remaining = quote.estimatedFillSize;
    for (const lot of lots) {
      if (remaining.lte(0)) break;
      const selected = Prisma.Decimal.min(lot.remainingSize, remaining);
      const current = grouped.get(lot.subscriptionId);
      grouped.set(lot.subscriptionId, {
        first: current?.first ?? lot,
        size: (current?.size ?? ZERO).add(selected),
      });
      remaining = remaining.sub(selected);
    }
    const executionIds: string[] = [];
    let part = 0;
    for (const { first, size } of grouped.values()) {
      const idempotencyKey = `virtual-manual-close:${params.idempotencyKey}:${part++}`;
      const execution = await tx.virtualCopyExecution.upsert({
        where: { idempotencyKey },
        update: {},
        create: {
          userId: params.userId,
          accountId: params.accountId,
          subscriptionId: first.subscriptionId,
          leaderTradeId: null,
          leaderId: first.leaderId,
          leaderAddress: first.leaderAddress,
          marketId: first.marketId,
          marketTitle: null,
          tokenId: params.tokenId.trim(),
          outcome: null,
          side: 'SELL',
          status: 'QUEUED',
          leaderPrice: quote.estimatedAvgPrice,
          targetSize: size,
          targetNotionalUsd: size.mul(quote.estimatedAvgPrice),
          maxSlippage: D(CONFIG.virtualCopyManualCloseMaxSlippage),
          fillModel: 'CLOB_ORDER_BOOK_WALK_V1',
          priceSource: quote.priceSource,
          executionSource: 'MANUAL_CLOSE',
          priceObservedAt: quote.priceObservedAt,
          feeModelVersion: quote.feeModelVersion,
          feeRate: quote.feeRate,
          idempotencyKey,
          configSnapshot: {
            manualClose: true,
            quoteId: quote.id,
            closeRequestIdempotencyKey: params.idempotencyKey,
            feeModelVersion: quote.feeModelVersion,
            feeRate: quote.feeRate.toString(),
          },
          scheduledAt: now,
        },
      });
      executionIds.push(execution.id);
    }
    await tx.virtualPositionCloseQuote.update({
      where: { id: quote.id },
      data: { status: 'CONSUMED', consumedAt: now },
    });
    return { executionIds, requestedSize: quote.requestedSize.toString() };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  for (const executionId of result.executionIds) await executeVirtualCopyExecution(executionId);
  return result;
}

/**
 * Creates explicit manual SELL executions using a recent observed market trade.
 * It refuses stale/missing prices instead of silently closing at entry price or zero.
 */
export async function closeVirtualPositionManually(params: {
  userId: number;
  accountId: string;
  tokenId: string;
  size?: string;
}): Promise<{ executionIds: string[]; requestedSize: string }> {
  const account = await requireOwnedVirtualAccount(params.userId, params.accountId);
  if (account.status === 'ARCHIVED' || account.status === 'SETTLED') {
    throw new VirtualCopyDomainError('Virtual account cannot be traded', 409, 'CONFLICT');
  }
  const tokenId = params.tokenId.trim();
  if (!tokenId) {
    throw new VirtualCopyDomainError('tokenId is required', 400, 'VALIDATION');
  }
  const lots = await prisma.virtualPositionLot.findMany({
    where: {
      userId: params.userId,
      accountId: params.accountId,
      tokenId,
      remainingSize: { gt: 0 },
    },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
  });
  if (lots.length === 0) {
    throw new VirtualCopyDomainError('Virtual position not found', 404, 'NOT_FOUND');
  }
  const available = lots.reduce((sum, lot) => sum.add(lot.remainingSize), ZERO);
  const requested = params.size == null ? available : Prisma.Decimal.min(D(params.size), available);
  if (requested.lte(0)) {
    throw new VirtualCopyDomainError('Close size must be positive', 400, 'VALIDATION');
  }
  const [mark, marketMetadata] = await Promise.all([
    getVirtualMarkPriceResolver().resolve(tokenId),
    prisma.leaderTrade.findFirst({
    where: { tokenId },
    orderBy: { createdAt: 'desc' },
    select: { marketTitle: true, outcome: true },
    }),
  ]);
  if (!mark.price || mark.status === 'UNAVAILABLE') {
    throw new VirtualCopyDomainError(
      'An authoritative CLOB/Gamma mark price is unavailable; the position was not closed',
      409,
      'CONFLICT',
    );
  }

  const plannedBySubscription = new Map<
    string,
    { first: (typeof lots)[number]; closeSize: Prisma.Decimal }
  >();
  let remaining = requested;
  for (const lot of lots) {
    if (remaining.lte(0)) break;
    const selectedSize = Prisma.Decimal.min(lot.remainingSize, remaining);
    const planned = plannedBySubscription.get(lot.subscriptionId);
    plannedBySubscription.set(lot.subscriptionId, {
      first: planned?.first ?? lot,
      closeSize: (planned?.closeSize ?? ZERO).add(selectedSize),
    });
    remaining = remaining.sub(selectedSize);
  }
  const executionIds: string[] = [];
  for (const { first, closeSize } of plannedBySubscription.values()) {
    const execution = await prisma.virtualCopyExecution.create({
      data: {
        userId: params.userId,
        accountId: params.accountId,
        subscriptionId: first.subscriptionId,
        leaderTradeId: null,
        leaderId: first.leaderId,
        leaderAddress: first.leaderAddress,
        marketId: first.marketId,
        marketTitle: marketMetadata?.marketTitle,
        tokenId,
        outcome: marketMetadata?.outcome,
        side: 'SELL',
        status: 'QUEUED',
        leaderPrice: mark.price,
        targetSize: closeSize,
        targetNotionalUsd: closeSize.mul(mark.price),
        maxSlippage: D(CONFIG.virtualCopyDefaultMaxSlippage),
        fillModel: 'CLOB_ORDER_BOOK_WALK_V1',
        priceSource: mark.source,
        executionSource: 'MANUAL_CLOSE',
        priceObservedAt: mark.asOf,
        configSnapshot: {
          manualClose: true,
          referenceMarkSource: mark.source,
          referenceMarkAsOf: mark.asOf?.toISOString() ?? null,
          referenceMarkStatus: mark.status,
          feeModelVersion: CONFIG.virtualCopyFeeModelVersion,
          feeRate: CONFIG.virtualCopyFeeRate.toString(),
        },
        scheduledAt: new Date(),
      },
    });
    executionIds.push(execution.id);
  }
  for (const executionId of executionIds) {
    await executeVirtualCopyExecution(executionId);
  }
  return { executionIds, requestedSize: requested.toString() };
}
