import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { reserveUserAssetForOrder, releaseUserAssetFromOrder } from '../custody/custody';
import { recordAuditEvent } from '../audit/events';
import { createAndPostOrderForUser, CreateOrderParams } from '../polymarket/polymarketClob';
import { TradingGuardService } from './tradingGuard';
import {
  computeRatioBuySize,
  resolveAvailableUsdcForRatioBuy,
} from '../../copyTrading/services/copyRatioSizing.js';

/** Dev-only simulate path: mirror event-driven copy using CopySubscription params. */
export async function handleLeaderOrder(params: {
  leaderAddress: string;
  tokenID: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
}) {
  const tradingGuard = new TradingGuardService();
  const leader = await prisma.copyLeader.findUnique({
    where: { address: params.leaderAddress.toLowerCase() },
  });
  if (!leader) return;

  const subscriptions = await prisma.copySubscription.findMany({
    where: {
      leaderId: leader.id,
      enabled: true,
      deletedAt: null,
    },
  });

  if (!subscriptions.length) return;

  for (const s of subscriptions) {
    const userId = s.userId;
    const ratio = s.copyRatio ?? new Prisma.Decimal(1);
    let targetSize: Prisma.Decimal;
    if (s.copyMode === 'FIXED_AMOUNT' && s.fixedAmountUsd != null && params.price > 0) {
      targetSize = s.fixedAmountUsd.div(params.price);
    } else if (params.side === 'BUY') {
      const availableUsd = await resolveAvailableUsdcForRatioBuy(userId);
      const sizeNum = computeRatioBuySize({
        availableUsd,
        copyRatio: Number(ratio.toString()),
        price: params.price,
      });
      targetSize = new Prisma.Decimal(sizeNum);
    } else {
      // Dev simulate SELL: keep leader×ratio fallback (production sells open lots).
      targetSize = ratio.mul(params.size);
    }
    const notional = targetSize.mul(params.price);

    if (s.maxAmount && notional.gt(s.maxAmount)) {
      await prisma.copyExecution.create({
        data: {
          followerUserId: userId,
          leaderAddress: params.leaderAddress,
          tokenID: params.tokenID,
          side: params.side,
          price: new Prisma.Decimal(params.price),
          size: targetSize,
          ratioApplied: ratio,
          notional,
          status: 'SKIPPED_MAX_NOTIONAL_PER_TRADE',
        },
      });
      continue;
    }

    let followCorrelationId: string | undefined;
    try {
      const guardDecision = await tradingGuard.evaluate({
        source: 'FOLLOW_ENGINE',
        userId,
        side: params.side,
        orderPrice: params.price,
        notionalUsd: Number(notional.toString()),
        tokenId: params.tokenID,
        leaderAddress: params.leaderAddress,
      });
      if (!guardDecision.allowed) {
        await prisma.copyExecution.create({
          data: {
            followerUserId: userId,
            leaderAddress: params.leaderAddress,
            tokenID: params.tokenID,
            side: params.side,
            price: new Prisma.Decimal(params.price),
            size: targetSize,
            ratioApplied: ratio,
            notional,
            status: guardDecision.reasonCode ?? 'SKIPPED_BY_GUARD',
            error: guardDecision.message,
          },
        });
        continue;
      }

      followCorrelationId = randomUUID();
      const followLedgerMeta = {
        leaderAddress: params.leaderAddress,
        tokenId: params.tokenID,
        side: params.side,
      };
      await reserveUserAssetForOrder(userId, 'USDC.e', notional, {
        correlationId: followCorrelationId,
        metadata: followLedgerMeta,
      });
    } catch (e) {
      console.warn('[followEngine] insufficient balance for user', userId, (e as Error).message);
      await prisma.copyExecution.create({
        data: {
          followerUserId: userId,
          leaderAddress: params.leaderAddress,
          tokenID: params.tokenID,
          side: params.side,
          price: new Prisma.Decimal(params.price),
          size: targetSize,
          ratioApplied: ratio,
          notional,
          status: 'SKIPPED_INSUFFICIENT_BALANCE',
          error: (e as Error)?.message ?? 'insufficient balance',
        },
      });
      continue;
    }

    try {
      const orderInput: CreateOrderParams = {
        tokenID: params.tokenID,
        price: params.price,
        size: Number(targetSize.toString()),
        side: params.side,
      };

      const result = await createAndPostOrderForUser(userId, orderInput);
      await recordAuditEvent({
        actorType: 'FOLLOW_ENGINE',
        actorId: String(userId),
        userId,
        action: 'FOLLOW_ENGINE_ORDER_SUBMITTED',
        targetType: 'CopyExecution',
        targetId: result?.orderID ? String(result.orderID) : params.tokenID,
        result: result?.success === false ? 'failed' : 'allowed',
        metadata: {
          leaderAddress: params.leaderAddress,
          tokenId: params.tokenID,
          side: params.side,
          notional: notional.toString(),
        },
      });

      await prisma.copyExecution.create({
        data: {
          followerUserId: userId,
          leaderAddress: params.leaderAddress,
          tokenID: params.tokenID,
          side: params.side,
          price: new Prisma.Decimal(params.price),
          size: targetSize,
          ratioApplied: ratio,
          notional,
          polymarketOrderId: result?.orderID ?? null,
          status: result?.success === false ? 'FAILED_TO_POST' : 'ORDER_POSTED',
          error: result?.success === false ? 'polymarket returned success=false' : null,
        },
      });
    } catch (err) {
      if (followCorrelationId) {
        await releaseUserAssetFromOrder(userId, 'USDC.e', notional, {
          correlationId: followCorrelationId,
          metadata: {
            leaderAddress: params.leaderAddress,
            tokenId: params.tokenID,
            side: params.side,
          },
        });
      }
      console.error('[followEngine] failed to place follower order', userId, err);
      await prisma.copyExecution.create({
        data: {
          followerUserId: userId,
          leaderAddress: params.leaderAddress,
          tokenID: params.tokenID,
          side: params.side,
          price: new Prisma.Decimal(params.price),
          size: targetSize,
          ratioApplied: ratio,
          notional,
          status: 'ERROR_PLACING_ORDER',
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}
