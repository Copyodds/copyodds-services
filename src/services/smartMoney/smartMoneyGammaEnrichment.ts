import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { evaluateTier2Enhanced } from './smartMoneyTierGate';
import {
  buildClosedMarketReturnDistribution,
  fetchPositionPnlContext,
} from './smartMoneyPositionStats';
import { buildSmartMoneyMarketLiquidityProfile } from './smartMoneyMarketLiquidity';
import { loadSmartMoneyScoreResult } from './smartMoneyScoreResultLoader';
import { syncSmartMoneyCopyPool } from './smartMoneyCopyPool';
import { transitionPipelineStage } from './smartMoneyPipeline';
import { refreshSmartMoneyCopyabilityForWallet } from './smartMoneyCopyability';
import { markSmartMoneyRanksDirty } from './smartMoneyLeaderboardWriter';

export type GammaEnrichmentResult = {
  wallet: string;
  success: boolean;
  tier2EnhancedPassed: boolean;
  inCopyPool: boolean;
  failReason: string | null;
};

export async function countPendingGammaEnrichment(): Promise<number> {
  const retryBefore = new Date(Date.now() - CONFIG.smartMoneyGammaEnrichmentMinRetryMs);
  return prisma.smartMoneyScoreCache.count({
    where: {
      tier2CorePassedAt: { not: null },
      tier2EnhancedPassedAt: null,
      updatedAt: { lt: retryBefore },
    },
  });
}

export async function pickGammaEnrichmentBatch(
  limit = CONFIG.smartMoneyGammaEnrichmentBatchSize
): Promise<string[]> {
  const retryBefore = new Date(Date.now() - CONFIG.smartMoneyGammaEnrichmentMinRetryMs);
  const rows = await prisma.smartMoneyScoreCache.findMany({
    where: {
      tier2CorePassedAt: { not: null },
      tier2EnhancedPassedAt: null,
      updatedAt: { lt: retryBefore },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { wallet: true },
  });
  return rows.map((row) => row.wallet);
}

export async function runGammaEnrichmentForWallet(wallet: string): Promise<GammaEnrichmentResult> {
  const now = new Date();
  try {
    const scoreResult = await loadSmartMoneyScoreResult(wallet);
    if (!scoreResult) {
      await prisma.smartMoneyScoreCache.updateMany({
        where: { wallet },
        data: { updatedAt: now },
      });
      return {
        wallet,
        success: false,
        tier2EnhancedPassed: false,
        inCopyPool: false,
        failReason: 'NO_SCORE_RESULT',
      };
    }

    const positionContext = await fetchPositionPnlContext(wallet);
    const closedMarketReturnDistribution = buildClosedMarketReturnDistribution(
      positionContext.closedRows
    );
    const marketLiquidityProfile = await buildSmartMoneyMarketLiquidityProfile({
      openRows: positionContext.openRows,
      closedRows: positionContext.closedRows,
      minMarketVolumeUsd: CONFIG.smartMoneyMinMarketVolumeUsd,
    }).catch(() => null);

    const tier2e = evaluateTier2Enhanced({
      closedMarketReturnDistribution,
      marketLiquidityProfile,
    });

    const mergedExplain = {
      ...scoreResult.scoreExplain,
      marketLiquidityProfile,
      closedMarketReturnDistribution,
      gammaEnrichmentAt: now.toISOString(),
    };
    scoreResult.scoreExplain = mergedExplain;

    await prisma.smartMoneyScoreCache.update({
      where: { wallet },
      data: {
        scoreExplain: mergedExplain as Prisma.InputJsonValue,
        updatedAt: now,
        ...(tier2e.passed ? { tier2EnhancedPassedAt: now } : {}),
      },
    });

    // T2E 成败都交给 sync：REQUIRE_TIER2E=false 时分够仍可入池
    const copyPool = await syncSmartMoneyCopyPool({
      scoreResult,
      tier2EnhancedPassed: tier2e.passed,
      closedMarketReturnDistribution,
      marketLiquidityProfile,
    });

    if (copyPool.inCopyPool) {
      await transitionPipelineStage(wallet, 'COPY_POOL', {
        tier2EnhancedPassedAt: tier2e.passed ? now : null,
        tierFailReason: tier2e.passed ? null : tier2e.failReason,
      });
    } else if (copyPool.exitReason === 'INACTIVE' || copyPool.exitReason === 'HARD_FLAG') {
      // sync 已写入 ELIMINATED / 出池，勿再盖成 SCORED
    } else {
      await transitionPipelineStage(wallet, 'SCORED', {
        tier2EnhancedPassedAt: tier2e.passed ? now : null,
        tierFailReason: tier2e.passed ? null : tier2e.failReason,
      });
    }

    await refreshSmartMoneyCopyabilityForWallet({
      wallet,
      smartMoneyScore: scoreResult.score,
      inCopyPool: copyPool.inCopyPool,
    }).catch(() => undefined);

    if (copyPool.inCopyPool || copyPool.exited) {
      markSmartMoneyRanksDirty();
    }

    return {
      wallet,
      success: true,
      tier2EnhancedPassed: tier2e.passed,
      inCopyPool: copyPool.inCopyPool,
      failReason: tier2e.passed ? null : tier2e.failReason,
    };
  } catch (error) {
    await prisma.smartMoneyScoreCache.updateMany({
      where: { wallet },
      data: { updatedAt: now },
    });
    const message = error instanceof Error ? error.message : String(error);
    return {
      wallet,
      success: false,
      tier2EnhancedPassed: false,
      inCopyPool: false,
      failReason: message,
    };
  }
}

export async function runSmartMoneyGammaEnrichmentBatch(
  trigger = 'manual'
): Promise<{
  trigger: string;
  picked: number;
  tier2EnhancedPassed: number;
  enteredCopyPool: number;
  failed: number;
} | null> {
  if (!CONFIG.smartMoneyGammaEnrichmentEnabled) {
    return null;
  }

  const wallets = await pickGammaEnrichmentBatch();
  const results: GammaEnrichmentResult[] = [];
  for (const wallet of wallets) {
    results.push(await runGammaEnrichmentForWallet(wallet));
  }

  const summary = {
    trigger,
    picked: results.length,
    tier2EnhancedPassed: results.filter((row) => row.tier2EnhancedPassed).length,
    enteredCopyPool: results.filter((row) => row.inCopyPool).length,
    failed: results.filter((row) => !row.success).length,
  };

  if (results.length > 0) {
    console.log('[smart-money-gamma] enrichment batch finished', summary);
  }

  return summary;
}
