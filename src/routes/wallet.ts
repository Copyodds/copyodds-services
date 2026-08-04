import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';
import { getNativeBalance, getUsdcBalance } from '../services/polymarket/web3';
import { prisma } from '../db';
import { Code, success, fail } from '../utils/response';
import { jwtAuth } from '../middlewares/jwtAuth';
import {
  bindReferrerIfNeeded,
  claimAffiliateCommissions,
  createGasRechargeWithCommissions,
} from '../services/gas/gas';
import {
  DOWNLINE_SUBTREE_DEFAULTS,
  queryDownlineSubtree,
} from '../services/gas/downlineTree';
import { getCustodialWalletAddressForUser } from '../services/custody/custody';
import { toPublicGasUser } from '../utils/publicApiPayload';

const router = Router();

const DIRECT_DOWNLINE_COHORT_MAX = 2000;

const claimCommissionsSchema = z.object({
  fromUserId: z.number().int().positive().optional(),
});

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');

router.get('/balance/:address', async (req, res, next) => {
  try {
    const parseResult = addressSchema.safeParse(req.params.address);
    if (!parseResult.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid address', 400, { details: parseResult.error.issues });
      return;
    }
    const address = parseResult.data as `0x${string}`;
    const balance = await getNativeBalance(address);

    // 在数据库中记录或更新该地址
    await prisma.wallet.upsert({
      where: { address },
      update: {},
      create: { address },
    });

    success(res, {
      address,
      balanceWei: balance.wei.toString(),
      balanceEther: balance.ether,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/assets/:address', async (req, res, next) => {
  try {
    const parseResult = addressSchema.safeParse(req.params.address);
    if (!parseResult.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid address', 400, { details: parseResult.error.issues });
      return;
    }
    const address = parseResult.data as `0x${string}`;
    const [native, usdc] = await Promise.all([
      getNativeBalance(address),
      getUsdcBalance(address),
    ]);
    success(res, {
      address,
      native: {
        symbol: 'MATIC',
        balanceWei: native.wei.toString(),
        balanceEther: native.ether,
      },
      usdc: {
        symbol: 'USDC.e',
        balanceRaw: usdc.raw.toString(),
        balanceFormatted: usdc.formatted,
      },
    });
  } catch (err) {
    next(err);
  }
});

const gasRechargeSchema = z.object({
  amountPaid: z.number().positive(),
  // 可选：首充时绑定推荐人
  referrerId: z.number().int().positive().optional(),
});

router.post('/gas/recharge', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = gasRechargeSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, { details: parsed.error.issues });
      return;
    }

    const userId = req.user.userId;
    const { amountPaid, referrerId } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      fail(res, Code.NOT_FOUND, 'User not found', 404);
      return;
    }

    // 首次充值时绑定推荐人（如果尚未绑定）
    const ensuredUser = await bindReferrerIfNeeded(user as any, referrerId);

    const order = await createGasRechargeWithCommissions({
      userId: (ensuredUser as any).id,
      amountPaid,
    });

    const updatedUser = await prisma.user.findUnique({
      where: { id: (ensuredUser as any).id },
    } as any);

    success(res, {
      orderId: (order as any).id,
      user: toPublicGasUser(updatedUser as any),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/gas/referral-summary', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const userId = req.user.userId;

    const [user, totalCommission, directReferralRows, pendingMall, claimedMall, custodyWalletAddress] =
      await Promise.all([
        (prisma as any).user.findUnique({
          where: { id: userId },
        }),
        (prisma as any).mallOrderCommission.aggregate({
          where: { toUserId: userId },
          _sum: { commissionAmount: true },
        }),
        (prisma as any).user.findMany({
          where: { referrerId: userId },
          select: { affiliateTier: true },
        }),
        (prisma as any).mallOrderCommission.aggregate({
          where: { toUserId: userId, claimedAt: null },
          _sum: { commissionAmount: true },
        }),
        (prisma as any).mallOrderCommission.aggregate({
          where: {
            toUserId: userId,
            claimedAt: { not: null },
          },
          _sum: { commissionAmount: true },
        }),
        getCustodialWalletAddressForUser(userId),
      ]);

    if (!user) {
      fail(res, Code.NOT_FOUND, 'User not found', 404);
      return;
    }

    const directReferrals = directReferralRows.length;
    const currentTier = (user as any).affiliateTier ?? 0;
    const directReferralsAtTier1Plus = directReferralRows.filter(
      (row: { affiliateTier: number | null }) => (row.affiliateTier ?? 0) >= 1,
    ).length;
    const directReferralsAtCurrentTierPlus =
      currentTier > 0
        ? directReferralRows.filter(
            (row: { affiliateTier: number | null }) => (row.affiliateTier ?? 0) >= currentTier,
          ).length
        : 0;

    success(res, {
      gasBalance: (user as any).gasBalance,
      totalCommission: totalCommission._sum.commissionAmount ?? 0,
      directReferrals,
      directReferralsAtTier1Plus,
      directReferralsAtCurrentTierPlus,
      affiliateTier: (user as any).affiliateTier ?? null,
      pendingMallCommissionUsd: pendingMall._sum.commissionAmount ?? 0,
      claimedMallCommissionUsd: claimedMall._sum.commissionAmount ?? 0,
      custodyWalletAddress,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/gas/claim-commissions', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = claimCommissionsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, { details: parsed.error.issues });
      return;
    }
    const userId = req.user.userId;
    try {
      const result = await claimAffiliateCommissions({
        toUserId: userId,
        fromUserId: parsed.data.fromUserId,
      });
      if (result.mallCommissionCount === 0) {
        fail(res, Code.STATE_CONFLICT, 'No pending commissions to claim', 409);
        return;
      }
      success(res, {
        claimedMallTotal: result.claimedMallTotal.toString(),
        mallCommissionCount: result.mallCommissionCount,
        destinationAddress: result.destinationAddress,
        txHashes: result.txHashes,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? '');
      if (msg === 'CONCURRENT_CLAIM_MALL_COMMISSION') {
        fail(res, Code.CONFLICT, 'Claim conflict, please retry', 409);
        return;
      }
      if (msg.includes('Polymarket DepositWallet not found')) {
        fail(
          res,
          Code.STATE_CONFLICT,
          'Polymarket deposit wallet not ready; open custody / authorize Polymarket first',
          409,
        );
        return;
      }
      // production 会隐藏 HTTP>=500 的 message；用 422 把可操作错误直接返回给前端/运维
      if (msg.includes('CUSTODY_TREASURY_ADDRESS')) {
        fail(res, Code.DEPENDENCY_UNAVAILABLE, msg, 422);
        return;
      }
      if (
        msg.includes('treasury payout') ||
        msg.includes('Go wallet API') ||
        msg.includes('insufficient treasury') ||
        msg.includes('treasury_address') ||
        msg.includes('mnemonicWithdraw') ||
        msg.includes('WALLET_PASSWORD_WITHDRAW')
      ) {
        fail(res, Code.DEPENDENCY_UNAVAILABLE, msg, 422);
        return;
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// 下属列表：多级下属树（默认）或仅一层（scope=direct）；佣金仅统计商城 USDC 分佣；待领取优先排序
router.get('/gas/downlines', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const userId = req.user.userId;

    const scope = req.query.scope === 'direct' ? 'direct' : 'subtree';
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const maxDepth = Math.min(
      64,
      Math.max(1, Number(req.query.maxDepth ?? DOWNLINE_SUBTREE_DEFAULTS.maxDepth)),
    );
    const maxNodes = Math.min(
      20_000,
      Math.max(1, Number(req.query.maxNodes ?? DOWNLINE_SUBTREE_DEFAULTS.maxNodes)),
    );
    /** subtree 默认一次返回与 maxNodes 对齐的页大小 */
    const defaultLimit = scope === 'subtree' ? maxNodes : 50;
    const limitCap = scope === 'subtree' ? 20_000 : 500;
    const limit = Math.min(limitCap, Math.max(1, Number(req.query.limit ?? defaultLimit)));

    const viewerRow = await (prisma as any).user.findUnique({
      where: { id: userId },
      select: { inviteCode: true },
    });
    const viewerInviteCode = (viewerRow as { inviteCode?: string } | null)?.inviteCode ?? '';

    let cohort: Array<{
      id: number;
      parentId: number;
      depth: number;
      username: string;
      inviteCode: string;
      affiliateTier: number | null;
    }>;
    let truncated = false;
    let totalInScope: number;
    let cohortCapped = false;

    if (scope === 'direct') {
      totalInScope = await (prisma as any).user.count({
        where: { referrerId: userId },
      });
      const directRows = await (prisma as any).user.findMany({
        where: { referrerId: userId },
        orderBy: { id: 'asc' },
        take: DIRECT_DOWNLINE_COHORT_MAX,
      });
      cohortCapped = totalInScope > DIRECT_DOWNLINE_COHORT_MAX;
      cohort = directRows.map((u: any) => ({
        id: u.id,
        parentId: userId,
        depth: 1,
        username: u.username,
        inviteCode: u.inviteCode,
        affiliateTier: u.affiliateTier ?? null,
      }));
    } else {
      const { rows, truncated: t } = await queryDownlineSubtree(userId, { maxDepth, maxNodes });
      truncated = t;
      totalInScope = rows.length;
      cohort = rows;
    }

    const ids = cohort.map((u) => u.id);
    const mallByFrom: Record<number, Prisma.Decimal> = {};
    const mallUnByFrom: Record<number, Prisma.Decimal> = {};

    if (ids.length > 0) {
      const baseWhere = { toUserId: userId, fromUserId: { in: ids } };
      const [mallRows, mallUnRows] = await Promise.all([
        (prisma as any).mallOrderCommission.groupBy({
          by: ['fromUserId'],
          where: baseWhere,
          _sum: { commissionAmount: true },
        }),
        (prisma as any).mallOrderCommission.groupBy({
          by: ['fromUserId'],
          where: { ...baseWhere, claimedAt: null },
          _sum: { commissionAmount: true },
        }),
      ]);

      for (const r of mallRows as any[]) {
        mallByFrom[r.fromUserId] = r._sum.commissionAmount ?? new Prisma.Decimal(0);
      }
      for (const r of mallUnRows as any[]) {
        mallUnByFrom[r.fromUserId] = r._sum.commissionAmount ?? new Prisma.Decimal(0);
      }
    }

    const idToInvite = new Map<number, string>([[userId, viewerInviteCode]]);
    for (const u of cohort) {
      idToInvite.set(u.id, u.inviteCode);
    }

    const withMetrics = cohort.map((u) => {
      const m = mallByFrom[u.id] ?? new Prisma.Decimal(0);
      const unclaimed = mallUnByFrom[u.id] ?? new Prisma.Decimal(0);
      const claimed = m.minus(unclaimed);
      return {
        fromUserId: u.id,
        parentInviteCode: idToInvite.get(u.parentId) ?? viewerInviteCode,
        depth: u.depth,
        username: u.username,
        inviteCode: u.inviteCode,
        affiliateTier: u.affiliateTier ?? null,
        totalCommissionFromThisUser: m.toString(),
        // claimedAt=null → 可领取；国库 payout 后再标记 claimedAt
        unclaimedCommissionFromThisUser: unclaimed.toString(),
        legacyUnclaimableCommissionFromThisUser: '0',
        claimedCommissionFromThisUser: claimed.gt(0) ? claimed.toString() : '0',
        _sortUnclaimed: unclaimed,
        _hasUnclaimed: unclaimed.gt(0),
        _sortInvite: u.inviteCode,
      };
    });

    withMetrics.sort((a, b) => {
      if (a._hasUnclaimed !== b._hasUnclaimed) {
        return a._hasUnclaimed ? -1 : 1;
      }
      if (!a._sortUnclaimed.equals(b._sortUnclaimed)) {
        return a._sortUnclaimed.gt(b._sortUnclaimed) ? -1 : 1;
      }
      return a._sortInvite.localeCompare(b._sortInvite);
    });

    const page = withMetrics.slice(offset, offset + limit).map((row) => {
      const { _sortUnclaimed: _su, _hasUnclaimed: _hu, _sortInvite: _si, ...rest } = row;
      void _su;
      void _hu;
      void _si;
      return rest;
    });

    success(res, {
      scope,
      total: totalInScope,
      returned: page.length,
      truncated: scope === 'subtree' ? truncated : false,
      cohortCapped,
      maxDepth: scope === 'subtree' ? maxDepth : null,
      maxNodes: scope === 'subtree' ? maxNodes : null,
      downlines: page,
    });
  } catch (err) {
    next(err);
  }
});

export const walletRouter = router;
