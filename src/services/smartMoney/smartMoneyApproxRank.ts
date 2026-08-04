/**
 * 入池后同步写近似 rank，缩短「刚入榜 rank=null」空窗；正式 flush 会覆盖。
 * 排序口径对齐 §15：档位优先 + TraderScore（可回落 score）。
 */
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { recordApproxRankAssignedMetric } from './smartMoneyCopyPoolRescoreMetrics';

function tierSortRank(tier: string | null | undefined): number {
  switch ((tier ?? '').toUpperCase()) {
    case 'S':
      return 0;
    case 'A':
      return 1;
    case 'B':
      return 2;
    case 'C':
      return 3;
    case 'D':
      return 4;
    default:
      return 5;
  }
}

function metricScore(input: {
  traderScore?: number | null;
  score: number;
}): number {
  if (CONFIG.smartMoneyTraderScoreAsPrimary && input.traderScore != null && Number.isFinite(input.traderScore)) {
    return input.traderScore;
  }
  return input.score;
}

/**
 * 在已有正式 rank 的榜行中，按排序键估算插入名次（1-based）。
 * 若无法估算（无人在榜）返回 1。
 */
export async function estimateApproximateLeaderboardRank(input: {
  wallet: string;
  score: number;
  traderScore?: number | null;
  tier?: string | null;
}): Promise<number> {
  const wallet = input.wallet.trim().toLowerCase();
  const myTier = tierSortRank(input.tier);
  const myScore = metricScore(input);

  const ranked = await prisma.smartMoneyLeaderboardRow.findMany({
    where: {
      inCopyPool: true,
      rank: { not: null },
      wallet: { not: wallet },
    },
    select: {
      rank: true,
      score: true,
      traderScore: true,
      tier: true,
    },
    orderBy: { rank: 'asc' },
    take: Math.min(CONFIG.smartMoneyTopLimit + 200, 5000),
  });

  if (ranked.length === 0) return 1;

  for (const row of ranked) {
    const rowTier = tierSortRank(row.tier);
    if (myTier < rowTier) {
      return Math.max(1, row.rank ?? 1);
    }
    if (myTier > rowTier) continue;
    const rowScore = metricScore({
      traderScore: row.traderScore != null ? Number(row.traderScore) : null,
      score: Number(row.score),
    });
    if (myScore > rowScore) {
      return Math.max(1, row.rank ?? 1);
    }
  }

  const last = ranked[ranked.length - 1]!;
  return Math.min((last.rank ?? ranked.length) + 1, CONFIG.smartMoneyTopLimit);
}

/**
 * 仅当当前 rank 为空时写入近似 rank；正式 recompute 会覆盖。
 */
export async function assignApproximateRankIfMissing(input: {
  wallet: string;
  score: number;
  traderScore?: number | null;
  tier?: string | null;
}): Promise<number | null> {
  if (!CONFIG.smartMoneyCopyPoolApproxRankEnabled) return null;

  const wallet = input.wallet.trim().toLowerCase();
  const existing = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: { rank: true, inCopyPool: true },
  });
  if (!existing?.inCopyPool) return null;
  if (existing.rank != null && existing.rank > 0) return existing.rank;

  const approx = Math.max(
    1,
    Math.min(CONFIG.smartMoneyTopLimit, await estimateApproximateLeaderboardRank(input))
  );
  await prisma.smartMoneyLeaderboardRow.update({
    where: { wallet },
    data: { rank: approx },
  });
  recordApproxRankAssignedMetric();
  return approx;
}
