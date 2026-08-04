import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  copyLeaderDisplayUpdateData,
  normalizeCopyLeaderDisplaySnapshot,
} from '../../copyTrading/services/copyLeaderDisplaySnapshot';
import { aggregateCopierFeedbackForWallets } from './smartMoneyCopierFeedback';
import { COPIER_WASH_SUSPECT_FLAG } from './smartMoneyCopierAntiCheat';
import { computeDisplayScore, computeMlDisplayScore } from './smartMoneyDisplayScore';
import { inferRankScoreFromRow, isRankModelActive } from './smartMoneyRankModel';
import { markSmartMoneyRanksDirty } from './smartMoneyLeaderboardWriter';

let rankRefreshRunning = false;

function mergeCopierWashFlag(flags: string[], washSuspect: boolean): string[] {
  const next = [...flags];
  const index = next.indexOf(COPIER_WASH_SUSPECT_FLAG);
  if (washSuspect && index < 0) next.push(COPIER_WASH_SUSPECT_FLAG);
  if (!washSuspect && index >= 0) next.splice(index, 1);
  return next;
}

export async function refreshSmartMoneyRankScoreForWallet(wallet: string): Promise<{
  rankScore: number | null;
  displayScore: number;
}> {
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet: wallet.toLowerCase() },
    select: {
      wallet: true,
      score: true,
      pnlQuality: true,
      activityScore: true,
      consistencyScore: true,
      externalQualityScore: true,
      copyabilityScore: true,
      inCopyPool: true,
      riskFlags: true,
      displayName: true,
      xUsername: true,
      tier: true,
    },
  });

  if (!row) {
    throw new Error(`leaderboard row not found: ${wallet}`);
  }

  if (!isRankModelActive()) {
    const displayScore = computeDisplayScore(
      row.copyabilityScore != null ? Number(row.copyabilityScore) : null,
      Number(row.score)
    );
    return { rankScore: null, displayScore };
  }

  const [feedbackMap, rawAddress] = await Promise.all([
    aggregateCopierFeedbackForWallets([row.wallet]),
    prisma.smartMoneyRawAddress.findUnique({
      where: { wallet: row.wallet },
      select: { tier2EnhancedPassedAt: true },
    }),
  ]);

  const feedback = feedbackMap.get(row.wallet.toLowerCase()) ?? null;
  const rankScore = inferRankScoreFromRow({
    row,
    feedback,
    tier2Enhanced: rawAddress?.tier2EnhancedPassedAt != null,
  });
  const displayScore = computeMlDisplayScore(
    row.copyabilityScore != null ? Number(row.copyabilityScore) : null,
    rankScore
  );
  const now = new Date();
  const riskFlags = mergeCopierWashFlag(row.riskFlags, feedback?.washSuspect === true);

  await prisma.smartMoneyLeaderboardRow.update({
    where: { wallet: row.wallet },
    data: {
      rankScore: new Prisma.Decimal(rankScore.toFixed(8)),
      rankScoreComputedAt: now,
      copierFeedback: feedback ?? Prisma.JsonNull,
      displayScore: new Prisma.Decimal(displayScore.toFixed(8)),
      riskFlags,
    },
  });

  const displaySnapshot = normalizeCopyLeaderDisplaySnapshot({
    displayName: row.displayName,
    xUsername: row.xUsername,
    tier: row.tier,
  });
  await prisma.copyLeader.updateMany({
    where: { address: row.wallet },
    data: {
      smartMoneyScore: row.score,
      copyabilityScore: row.copyabilityScore,
      ...copyLeaderDisplayUpdateData(displaySnapshot),
    },
  });

  return { rankScore, displayScore };
}

export async function runSmartMoneyRankRefreshBatch(trigger = 'manual'): Promise<{
  trigger: string;
  picked: number;
  refreshed: number;
  skipped: number;
  failed: number;
} | null> {
  if (!isRankModelActive()) {
    console.log('[smart-money-rank] skipped: rank model disabled', { trigger });
    return { trigger, picked: 0, refreshed: 0, skipped: 0, failed: 0 };
  }

  if (rankRefreshRunning) {
    console.warn('[smart-money-rank] batch skipped: already running', { trigger });
    return null;
  }

  rankRefreshRunning = true;
  const batchSize = CONFIG.smartMoneyRankRefreshBatchSize;
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const rows = await prisma.smartMoneyLeaderboardRow.findMany({
      where: { inCopyPool: true },
      orderBy: [
        { rankScoreComputedAt: { sort: 'asc', nulls: 'first' } },
        { lastScoredAt: 'desc' },
      ],
      take: batchSize,
      select: {
        wallet: true,
        score: true,
        pnlQuality: true,
        activityScore: true,
        consistencyScore: true,
        externalQualityScore: true,
        copyabilityScore: true,
        riskFlags: true,
      },
    });

    if (rows.length === 0) {
      return { trigger, picked: 0, refreshed: 0, skipped: 0, failed: 0 };
    }

    const feedbackMap = await aggregateCopierFeedbackForWallets(rows.map((row) => row.wallet));
    const rawAddresses = await prisma.smartMoneyRawAddress.findMany({
      where: { wallet: { in: rows.map((row) => row.wallet) } },
      select: { wallet: true, tier2EnhancedPassedAt: true },
    });
    const tier2EnhancedByWallet = new Map(
      rawAddresses.map((row) => [row.wallet, row.tier2EnhancedPassedAt != null])
    );
    const now = new Date();

    for (const row of rows) {
      try {
        const feedback = feedbackMap.get(row.wallet.toLowerCase()) ?? null;
        const rankScore = inferRankScoreFromRow({
          row,
          feedback,
          tier2Enhanced: tier2EnhancedByWallet.get(row.wallet) ?? false,
        });
        const displayScore = computeMlDisplayScore(
          row.copyabilityScore != null ? Number(row.copyabilityScore) : null,
          rankScore
        );
        const riskFlags = mergeCopierWashFlag(row.riskFlags, feedback?.washSuspect === true);

        await prisma.smartMoneyLeaderboardRow.update({
          where: { wallet: row.wallet },
          data: {
            rankScore: new Prisma.Decimal(rankScore.toFixed(8)),
            rankScoreComputedAt: now,
            copierFeedback: feedback ?? Prisma.JsonNull,
            displayScore: new Prisma.Decimal(displayScore.toFixed(8)),
            riskFlags,
          },
        });
        refreshed += 1;
      } catch (error) {
        failed += 1;
        console.warn('[smart-money-rank] refresh failed', { wallet: row.wallet, error });
      }
    }

    skipped = rows.length - refreshed - failed;
    if (refreshed > 0) {
      markSmartMoneyRanksDirty();
    }

    console.log('[smart-money-rank] batch finished', {
      trigger,
      picked: rows.length,
      refreshed,
      skipped,
      failed,
    });

    return { trigger, picked: rows.length, refreshed, skipped, failed };
  } finally {
    rankRefreshRunning = false;
  }
}
