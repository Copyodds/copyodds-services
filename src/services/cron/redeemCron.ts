import { fetchDataApiPositionsForWalletPair, type DataApiPosition } from '../polymarket/polymarketData';
import {
  REDEEM_RECONCILE_CRON_CHAIN_CONCURRENCY,
  REDEEM_RECONCILE_CRON_MAX_ROWS,
  reconcileMisstatedExpiredExecutionsForUser,
  reconcileMisstatedRedeemExecutionsForUser,
  reconcileUnsettledOpenCopyLotsForUser,
  redeemRedeemableOpenLotsForUser,
  REDEEM_LEADER_ADDRESSES,
} from '../../copyTrading/services/copyRedeemSettlement';
import { autoSettleExpiredWorthlessPositions } from '../../copyTrading/services/copyExpiredWorthlessSettlement';
import {
  claimDuePositionScanTargets,
  markUserPositionScanError,
  markUserPositionScanResult,
  type PositionScanTarget,
} from '../polymarket/positionScanState';
import { isWorthlessRedeemablePosition } from '../polymarket/positionVisibility';
import { mapPool } from '../../copyTrading/services/mapPool';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';

let sweepRunning = false;
let reconcileSweepRunning = false;
const REDEEM_RECONCILE_USER_BATCH = 12;

type PreparedScan = {
  target: PositionScanTarget;
  redeemAddress: string;
  positions: DataApiPosition[];
  hasRedeemable: boolean;
};

/** 仅赢面可赎回优先扫描；输面（价值≈0）走归零结算，不占 redeem 优先队列。 */
function hasWinningRedeemablePosition(positions: DataApiPosition[]): boolean {
  return positions.some(
    (p) =>
      p.redeemable === true &&
      Number(p.size ?? 0) > 0 &&
      !isWorthlessRedeemablePosition(p)
  );
}

function redeemAddressFor(target: PositionScanTarget): string {
  const { custodial, deposit } = target;
  return deposit && deposit.toLowerCase() !== custodial.toLowerCase() ? deposit : custodial;
}

async function processPreparedUser(prepared: PreparedScan): Promise<void> {
  const { target, redeemAddress, positions, hasRedeemable } = prepared;
  const userId = target.userId;

  // 先归零输面，再兑付赢面，避免对 $0 redeemable 误打 Relayer。
  try {
    await autoSettleExpiredWorthlessPositions(userId, positions).catch((e) => {
      console.warn('[redeem-cron] auto-settle expired worthless failed', {
        userId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  } catch (e) {
    console.warn('[redeem-cron] auto-settle expired worthless failed', {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  let anyTxRedeemed = false;
  if (hasRedeemable) {
    const result = await redeemRedeemableOpenLotsForUser({
      userId,
      redeemAddress,
      positions,
      logPrefix: '[redeem-cron]',
    });
    anyTxRedeemed = result.anyTxRedeemed;
  }

  const openLotCount = await prisma.copyPositionLot.count({
    where: { userId, remainingSize: { gt: 0 } },
  });

  // 使用默认扫描间隔；失败仓位由 autoRedeemFailureGuard 在 3 次后停止自动兑换。
  // 账本仍有 open lot 时保持 15 分钟扫描（即使 Data API 已不下发该仓）。
  await markUserPositionScanResult({
    userId,
    hasOpenPosition: openLotCount > 0 || positions.some((p) => Number(p.size ?? 0) > 0),
    redeemed: anyTxRedeemed,
  });

  try {
    await reconcileUnsettledOpenCopyLotsForUser(userId, positions, redeemAddress, {
      maxRows: REDEEM_RECONCILE_CRON_MAX_ROWS,
    });
    await reconcileMisstatedExpiredExecutionsForUser(userId, positions, redeemAddress, {
      maxRows: REDEEM_RECONCILE_CRON_MAX_ROWS,
      chainConcurrency: REDEEM_RECONCILE_CRON_CHAIN_CONCURRENCY,
    });
    await reconcileMisstatedRedeemExecutionsForUser(userId, redeemAddress, {
      maxRows: REDEEM_RECONCILE_CRON_MAX_ROWS,
      chainConcurrency: REDEEM_RECONCILE_CRON_CHAIN_CONCURRENCY,
    });
  } catch (e) {
    console.warn('[redeem-cron] redeem execution reconcile failed', {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * 扫描到期的 active 用户持仓，
 * 对 Data API 标记 redeemable 的仓位尝试链上 redeem（幂等）。
 *
 * claim → 有限并发拉仓 → redeemable 用户优先处理。
 */
export async function runAutoRedeemSweep(): Promise<void> {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const batchSize = CONFIG.redeemSweepBatchSize;
    const concurrency = CONFIG.redeemSweepUserConcurrency;
    const targets = await claimDuePositionScanTargets({ take: batchSize });
    if (!targets.length) return;

    const fetchResults = await mapPool(targets, concurrency, async (target) => {
      const redeemAddress = redeemAddressFor(target);
      try {
        const positions = await fetchDataApiPositionsForWalletPair(
          { custodial: target.custodial, deposit: target.deposit },
          { sizeThreshold: 0, limit: 500 }
        );
        return {
          ok: true as const,
          prepared: {
            target,
            redeemAddress,
            positions,
            hasRedeemable: hasWinningRedeemablePosition(positions),
          },
        };
      } catch (e) {
        console.warn('[redeem-cron] positions fetch failed', target.userId, e);
        await markUserPositionScanError({
          userId: target.userId,
          error: e instanceof Error ? e.message : String(e),
        });
        return { ok: false as const };
      }
    });

    const prepared = fetchResults
      .filter((r): r is { ok: true; prepared: PreparedScan } => r.ok)
      .map((r) => r.prepared);
    const redeemable = prepared.filter((p) => p.hasRedeemable);
    const rest = prepared.filter((p) => !p.hasRedeemable);

    console.log('[redeem-cron] batch claimed', {
      claimed: targets.length,
      fetched: prepared.length,
      redeemable: redeemable.length,
      concurrency,
    });

    // redeemable 优先：先消化可赎回用户，再处理其余对账/结算。
    await mapPool(redeemable, concurrency, (item) => processPreparedUser(item));
    await mapPool(rest, concurrency, (item) => processPreparedUser(item));
  } finally {
    sweepRunning = false;
  }
}

/**
 * 对有 redeem 成交记录的用户分批做对账（不依赖持仓扫描队列）。
 */
export async function runRedeemExecutionReconcileSweep(): Promise<void> {
  if (reconcileSweepRunning) return;
  reconcileSweepRunning = true;
  try {
    const rows = await prisma.copyExecution.findMany({
      where: {
        leaderAddress: { in: [...REDEEM_LEADER_ADDRESSES] },
        side: 'SELL',
        status: 'filled',
      },
      select: { followerUserId: true },
      distinct: ['followerUserId'],
      take: REDEEM_RECONCILE_USER_BATCH,
      orderBy: { followerUserId: 'asc' },
    });

    const concurrency = CONFIG.redeemSweepUserConcurrency;
    await mapPool(rows, concurrency, async (row) => {
      const userId = row.followerUserId;
      try {
        await reconcileMisstatedRedeemExecutionsForUser(userId, null, {
          maxRows: REDEEM_RECONCILE_CRON_MAX_ROWS,
          chainConcurrency: REDEEM_RECONCILE_CRON_CHAIN_CONCURRENCY,
        });
      } catch (e) {
        console.warn('[redeem-reconcile-cron] failed', {
          userId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
  } finally {
    reconcileSweepRunning = false;
  }
}
