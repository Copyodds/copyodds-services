/**
 * POST /api/internal/copy-trade/leader-signal
 * - 鉴权：Header X-Internal-Secret === 环境变量 COPY_INTERNAL_SECRET（消息服侧可与 COPYTRADE_BACKEND_INTERNAL_SECRET 同值）
 * - 成功响应沿用全局格式：{ code: 0, data }；HTTP 201 新建 / 200 幂等
 */
import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { publishCopyTradingDispatch } from '../../copyTrading/dispatch/publishCopyTradingDispatch';
import { shouldRedispatchLeaderTrade } from '../../copyTrading/services/leaderTradeDispatchGate';
import { dispatchLeaderTrade } from '../../copyTrading/services/dispatchLeaderTrade';
import {
  scheduleLeaderTradeMarketMetadataEnrich,
} from '../../copyTrading/services/leaderTradeMarketMetadata';
import { CONFIG } from '../../config/env';
import { Code, success, fail } from '../../utils/response';

/** 与链上 listener 无 maker/taker 时的占位一致 */
const PLACEHOLDER_ADDRESS = '0x0000000000000000000000000000000000000000';

export const internalCopyTradeRouter = Router();

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');

const leaderSignalBodySchema = z.object({
  leaderAddress: addressSchema,
  txHash: z
    .string()
    .min(1)
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => /^0x[a-f0-9]{64}$/.test(s), 'Invalid tx hash'),
  logIndex: z.number().int().nonnegative(),
  side: z.enum(['BUY', 'SELL']),
  tokenId: z.string().min(1).transform((s) => s.trim()),
  price: z.string().min(1).transform((s) => s.trim()),
  amount: z.string().min(1).transform((s) => s.trim()),
  marketId: z.union([z.string(), z.null()]).optional(),
  marketTitle: z.union([z.string(), z.null()]).optional(),
  title: z.union([z.string(), z.null()]).optional(),
  question: z.union([z.string(), z.null()]).optional(),
  outcome: z.union([z.string(), z.null()]).optional(),
  blockNumber: z.number().int().nonnegative().nullable().optional(),
  sourceFillCount: z.number().int().min(1).optional(),
  signalSource: z.string().min(1).optional(),
  maker: addressSchema.optional(),
  taker: addressSchema.optional(),
  makerAssetId: z.string().optional(),
  takerAssetId: z.string().optional(),
});

function parseBody(req: unknown) {
  return leaderSignalBodySchema.safeParse(req);
}

async function respondDuplicateLeaderTrade(
  res: Parameters<typeof success>[0],
  leaderTradeId: string,
  leaderAddress: string,
  meta: { signalSource: string; txHash: string; logIndex: number }
): Promise<void> {
  let redispatched = false;
  let dispatchPublished = false;

  if (await shouldRedispatchLeaderTrade(leaderTradeId)) {
    const pub = await publishCopyTradingDispatch({
      leaderTradeId,
      leaderAddress,
      reason: 'leader_signal_redispatch',
      signalSource: meta.signalSource,
      txHash: meta.txHash,
      logIndex: meta.logIndex,
    });
    dispatchPublished = pub.published;
    redispatched = pub.published;
    if (!pub.published) {
      void dispatchLeaderTrade(leaderTradeId, 'manual').catch((error) => {
        console.error('[internal-copy-trade] duplicate direct dispatch fallback failed', {
          leaderTradeId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      redispatched = true;
    }
    console.log('[internal-copy-trade] duplicate leader-signal redispatch publish', {
      leaderTradeId,
      dispatchPublished,
    });
  }

  success(
    res,
    {
      leaderTradeId,
      duplicate: true,
      redispatched,
      dispatchBackend: 'nats',
      dispatchPublished,
    },
    200
  );
}

internalCopyTradeRouter.get('/watch-list', async (_req, res, next: NextFunction) => {
  try {
    const leaders = await prisma.copyLeader.findMany({
      where: {
        enabled: true,
        OR: [
          { subscriptions: { some: { enabled: true, deletedAt: null } } },
          {
            virtualSubscriptions: {
              some: {
                enabled: true,
                deletedAt: null,
                account: { status: { in: ['ACTIVE', 'PAUSED', 'EXPIRED_CLOSING'] } },
              },
            },
          },
        ],
      },
      select: {
        address: true,
      },
    });

    const addresses = Array.from(
      new Set(leaders.map((leader) => leader.address.trim().toLowerCase()).filter(Boolean))
    ).sort();

    success(res, { chainId: CONFIG.chainId || 137, addresses });
  } catch (e) {
    next(e);
  }
});

internalCopyTradeRouter.post('/leader-signal', async (req, res, next: NextFunction) => {
  const parsed = parseBody(req.body);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }

  const body = parsed.data;
  const leaderLower = body.leaderAddress.toLowerCase();
  let marketId: string | null = null;
  if (body.marketId !== undefined && body.marketId !== null) {
    const t = body.marketId.trim();
    marketId = t.length > 0 ? t : null;
  }
  const marketTitle =
    body.marketTitle?.trim() ||
    body.title?.trim() ||
    body.question?.trim() ||
    null;
  const outcome = body.outcome?.trim() || null;
  const blockNumber = body.blockNumber === undefined ? null : body.blockNumber;
  const sourceFillCount = body.sourceFillCount ?? 1;
  const signalSource = body.signalSource?.trim() || 'websocket';
  const maker = (body.maker ?? PLACEHOLDER_ADDRESS).toLowerCase();
  const taker = (body.taker ?? PLACEHOLDER_ADDRESS).toLowerCase();
  const makerAssetId = body.makerAssetId?.trim() ?? '';
  const takerAssetId = body.takerAssetId?.trim() ?? '';

  const leader = await prisma.copyLeader.findUnique({
    where: { address: leaderLower },
  });

  if (!leader || !leader.enabled) {
    console.warn('[internal-copy-trade] leader missing or disabled', {
      leaderAddress: leaderLower,
      txHash: body.txHash,
      logIndex: body.logIndex,
      found: Boolean(leader),
      enabled: leader?.enabled ?? false,
    });
    fail(res, Code.NOT_FOUND, 'Copy leader not found or not enabled', 404);
    return;
  }

  const [realSubscriptionCount, virtualSubscriptionCount] = await Promise.all([
    prisma.copySubscription.count({
      where: { leaderId: leader.id, enabled: true, deletedAt: null },
    }),
    prisma.virtualCopySubscription.count({
      where: {
        leaderId: leader.id,
        deletedAt: null,
        OR: [
          { enabled: true },
          { lots: { some: { remainingSize: { gt: 0 } } } },
        ],
      },
    }),
  ]);
  const activeSubscriptionCount = realSubscriptionCount + virtualSubscriptionCount;

  if (activeSubscriptionCount < 1) {
    console.warn('[internal-copy-trade] leader has no enabled subscriptions', {
      leaderAddress: leaderLower,
      txHash: body.txHash,
      logIndex: body.logIndex,
    });
    fail(res, Code.NOT_FOUND, 'Copy leader has no enabled subscriptions', 404);
    return;
  }

  const existing = await prisma.leaderTrade.findUnique({
    where: {
      leaderAddress_txHash_logIndex: {
        leaderAddress: leaderLower,
        txHash: body.txHash,
        logIndex: body.logIndex,
      },
    },
  });

  if (existing) {
    scheduleLeaderTradeMarketMetadataEnrich(existing.id, existing.tokenId, {
      marketTitle: existing.marketTitle,
      outcome: existing.outcome,
    });
    await respondDuplicateLeaderTrade(res, existing.id, leaderLower, {
      signalSource,
      txHash: body.txHash,
      logIndex: body.logIndex,
    });
    return;
  }

  let row;
  try {
    row = await prisma.leaderTrade.create({
      data: {
        leaderAddress: leaderLower,
        leaderId: leader.id,
        txHash: body.txHash,
        logIndex: body.logIndex,
        sourceFillCount,
        signalSource,
        side: body.side,
        amount: body.amount,
        price: body.price,
        marketId,
        marketTitle,
        tokenId: body.tokenId,
        outcome,
        maker,
        taker,
        makerAssetId,
        takerAssetId,
        blockNumber,
        processed: false,
      },
    });
  } catch (e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await prisma.leaderTrade.findUnique({
        where: {
          leaderAddress_txHash_logIndex: {
            leaderAddress: leaderLower,
            txHash: body.txHash,
            logIndex: body.logIndex,
          },
        },
      });
      if (again) {
        await respondDuplicateLeaderTrade(res, again.id, leaderLower, {
          signalSource,
          txHash: body.txHash,
          logIndex: body.logIndex,
        });
        return;
      }
      console.error('[internal-copy-trade] P2002 but row not found on retry', {
        txHash: body.txHash,
        logIndex: body.logIndex,
      });
    }
    console.error('[internal-copy-trade] leaderTrade.create failed', {
      leaderAddress: leaderLower,
      txHash: body.txHash,
      logIndex: body.logIndex,
      error: e instanceof Error ? e.message : String(e),
    });
    next(e);
    return;
  }

  scheduleLeaderTradeMarketMetadataEnrich(row.id, body.tokenId, { marketTitle, outcome });

  const pub = await publishCopyTradingDispatch({
    leaderTradeId: row.id,
    leaderAddress: leaderLower,
    reason: 'leader_signal_create',
    signalSource,
    txHash: body.txHash,
    logIndex: body.logIndex,
  });
  if (!pub.published) {
    void dispatchLeaderTrade(row.id, 'manual').catch((error) => {
      console.error('[internal-copy-trade] direct dispatch fallback failed', {
        leaderTradeId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  success(
    res,
    {
      leaderTradeId: row.id,
      dispatchBackend: 'nats',
      dispatchPublished: pub.published,
    },
    201
  );
});
