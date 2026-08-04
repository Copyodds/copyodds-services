import { prisma } from '../../db';
import type { SmartMoneyScoreResult } from './smartMoneyScorer';
import {
  scoreResultFromLeaderboardRow,
  scoreResultFromScoreCache,
} from './smartMoneyScoreResultFromRow';

export {
  scoreResultFromLeaderboardRow,
  scoreResultFromScoreCache,
} from './smartMoneyScoreResultFromRow';

export async function loadSmartMoneyScoreResult(
  wallet: string
): Promise<SmartMoneyScoreResult | null> {
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({ where: { wallet } });
  if (row) return scoreResultFromLeaderboardRow(row);

  const cache = await prisma.smartMoneyScoreCache.findUnique({ where: { wallet } });
  if (!cache) return null;

  const observed = await prisma.observedTrader.findUnique({
    where: { wallet },
    select: {
      sourceRankWeek: true,
      sourceRankMonth: true,
      sourceRankAll: true,
      officialSourceRankWeek: true,
      officialSourceRankMonth: true,
      officialSourceRankAll: true,
      externalSourceRankWeek: true,
      externalSourceRankMonth: true,
      externalSourceRankAll: true,
      candidatePeriods: true,
      candidateCategories: true,
    },
  });

  return scoreResultFromScoreCache(cache, observed);
}
