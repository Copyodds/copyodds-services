/**
 * Deep-Enrich：入榜后异步补 30D(1M) + 1D 曲线，并对冲复核（不占 Deep 热路径）。
 * 曲线失败不踢榜；对冲硬旗 → 移出 CopyPool 并 ELIMINATED。
 * 详情页对 1D 走 TTL 读穿（未过期读库，过期 live 回写）。
 */
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { mapPool } from '../../copyTrading/services/mapPool';
import { buildDisplayEnrichPayload } from './smartMoneyDisplayEnrich';
import {
  ENRICH_PNL_CURVE_PERIODS,
  fetchAndPersistUserPnlCurves,
} from './smartMoneyUserPnlCurves';
import {
  detectHedgedPairExposure,
  HEDGED_PAIR_SHARE_THRESHOLD,
} from './smartMoneyPositionStats';
import { fetchDataApiPositions } from '../polymarket/polymarketData';
import { removeFromCopyPool } from './smartMoneyCopyPool';
import { moveToEliminated } from './smartMoneyEliminated';
import { waitSmartMoneyRequestGap } from './smartMoneyRequestGap';

export type CurveEnrichResult = {
  wallet: string;
  success: boolean;
  periodsFilled: string[];
  hedgeEjected?: boolean;
  error?: string;
};

async function maybeEjectHedgedCopyPool(wallet: string): Promise<boolean> {
  try {
    await waitSmartMoneyRequestGap();
    const positions = await fetchDataApiPositions(wallet);
    const exposure = detectHedgedPairExposure(positions);
    if (
      exposure.hedgedPairShare == null ||
      exposure.hedgedPairShare < HEDGED_PAIR_SHARE_THRESHOLD
    ) {
      return false;
    }

    const row = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet },
      select: { riskFlags: true, scoreExplain: true, inCopyPool: true },
    });
    if (!row) return false;

    const riskFlags = row.riskFlags.includes('HEDGED_PAIR_EXPOSURE')
      ? row.riskFlags
      : [...row.riskFlags, 'HEDGED_PAIR_EXPOSURE'];
    const prevExplain =
      row.scoreExplain && typeof row.scoreExplain === 'object' && !Array.isArray(row.scoreExplain)
        ? (row.scoreExplain as Record<string, unknown>)
        : {};

    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet },
      data: {
        riskFlags,
        eligible: false,
        scoreExplain: {
          ...prevExplain,
          hedgedPairExposure: {
            hedgedPairShare: exposure.hedgedPairShare,
            ejectedAt: new Date().toISOString(),
            ejectedBy: 'curve-enrich-hedge',
          },
        } as Prisma.InputJsonValue,
      },
    });

    if (row.inCopyPool) {
      await removeFromCopyPool(wallet).catch(() => undefined);
    }
    await moveToEliminated(wallet, 'COPY_HARD:HEDGED_PAIR_EXPOSURE').catch(() => undefined);
    console.log('[smart-money-curve-enrich] hedge ejected', {
      wallet,
      hedgedPairShare: exposure.hedgedPairShare,
    });
    return true;
  } catch (error) {
    console.warn('[smart-money-curve-enrich] hedge check failed', {
      wallet,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function countPendingCurveEnrichment(): Promise<number> {
  const retryBefore = new Date(Date.now() - CONFIG.smartMoneyCurveEnrichMinRetryMs);
  return prisma.smartMoneyLeaderboardRow.count({
    where: {
      OR: [{ lastCurveEnrichAt: null }, { lastCurveEnrichAt: { lt: retryBefore } }],
      scoreExplain: { not: Prisma.DbNull },
    },
  });
}

export async function pickCurveEnrichmentBatch(
  limit = CONFIG.smartMoneyCurveEnrichBatchSize
): Promise<string[]> {
  const retryBefore = new Date(Date.now() - CONFIG.smartMoneyCurveEnrichMinRetryMs);
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: {
      OR: [{ lastCurveEnrichAt: null }, { lastCurveEnrichAt: { lt: retryBefore } }],
      scoreExplain: { not: Prisma.DbNull },
    },
    orderBy: [{ inCopyPool: 'desc' }, { score: 'desc' }, { lastScoredAt: 'desc' }],
    take: limit,
    select: { wallet: true },
  });
  return rows.map((row) => row.wallet);
}

export async function runCurveEnrichmentForWallet(wallet: string): Promise<CurveEnrichResult> {
  const normalized = wallet.trim().toLowerCase();
  const snapshotAt = new Date();
  try {
    const { periodsFilled } = await fetchAndPersistUserPnlCurves(
      normalized,
      ENRICH_PNL_CURVE_PERIODS,
      { snapshotAt }
    );

    const hedgeEjected = await maybeEjectHedgedCopyPool(normalized);
    if (hedgeEjected) {
      await prisma.smartMoneyLeaderboardRow.updateMany({
        where: { wallet: normalized },
        // 勿动 enrichPending：属 copyability Enrich 车道，Curve 清掉会导致达线户搁浅
        data: { lastCurveEnrichAt: snapshotAt },
      });
      return {
        wallet: normalized,
        success: true,
        periodsFilled,
        hedgeEjected: true,
      };
    }

    const existing = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet: normalized },
      select: { scoreExplain: true },
    });

    let sparkline: Awaited<ReturnType<typeof buildDisplayEnrichPayload>>['sparkline'] = [];
    let biggestWinRecent: number | null = null;
    let recentMarkets: Awaited<ReturnType<typeof buildDisplayEnrichPayload>>['recentMarkets'] = [];
    try {
      const enrich = await buildDisplayEnrichPayload(normalized);
      sparkline = enrich.sparkline;
      biggestWinRecent = enrich.biggestWinRecent;
      recentMarkets = enrich.recentMarkets;
    } catch {
      // E5/E6 失败不阻断曲线 enrich
    }

    const prevExplain =
      existing?.scoreExplain && typeof existing.scoreExplain === 'object'
        ? (existing.scoreExplain as Record<string, unknown>)
        : {};
    const prevDisplay =
      prevExplain.displayProfile && typeof prevExplain.displayProfile === 'object'
        ? (prevExplain.displayProfile as Record<string, unknown>)
        : {};

    const mergedExplain = {
      ...prevExplain,
      curveEnrichAt: snapshotAt.toISOString(),
      curveEnrichPeriods: periodsFilled,
      sparkline,
      recentMarkets,
      displayProfile: {
        ...prevDisplay,
        sparkline,
        biggestWinRecent,
        recentMarkets,
      },
    };

    await prisma.smartMoneyLeaderboardRow.updateMany({
      where: { wallet: normalized },
      data: {
        lastCurveEnrichAt: snapshotAt,
        // 勿清 enrichPending（copyability 晋级队列），避免与 Curve Enrich 车道串扰
        scoreExplain: mergedExplain as Prisma.InputJsonValue,
      },
    });

    return { wallet: normalized, success: true, periodsFilled };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.smartMoneyLeaderboardRow.updateMany({
      where: { wallet: normalized },
      data: { lastCurveEnrichAt: snapshotAt },
    });
    return { wallet: normalized, success: false, periodsFilled: [], error: message };
  }
}

export async function runSmartMoneyCurveEnrichmentBatch(trigger = 'manual'): Promise<{
  trigger: string;
  picked: number;
  succeeded: number;
  failed: number;
  periodsFilled: number;
  hedgeEjected: number;
} | null> {
  if (!CONFIG.smartMoneyCurveEnrichEnabled) {
    return null;
  }

  const wallets = await pickCurveEnrichmentBatch();
  const results = await mapPool(
    wallets,
    Math.min(3, CONFIG.smartMoneyAnalyzeConcurrency),
    (wallet) => runCurveEnrichmentForWallet(wallet)
  );

  const summary = {
    trigger,
    picked: results.length,
    succeeded: results.filter((row) => row.success).length,
    failed: results.filter((row) => !row.success).length,
    periodsFilled: results.reduce((sum, row) => sum + row.periodsFilled.length, 0),
    hedgeEjected: results.filter((row) => row.hedgeEjected).length,
  };

  if (results.length > 0) {
    console.log('[smart-money-curve-enrich] batch finished', summary);
  }
  return summary;
}
