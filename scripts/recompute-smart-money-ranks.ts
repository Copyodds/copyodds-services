/**
 * 仅重算聪明钱榜排名（恢复 eligible 后若 recompute 超时失败可单独执行）。
 *
 * Usage:
 *   npm run recompute:smart-money
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';
import {
  countCachedApiSmartMoneyLeaderboardRows,
  recomputeSmartMoneyLeaderboardRanks,
} from '../src/services/smartMoney/smartMoneyLeaderboardWriter';

async function main(): Promise<void> {
  const beforeTotal = await countCachedApiSmartMoneyLeaderboardRows();
  const beforeEligible = await prisma.smartMoneyLeaderboardRow.count({ where: { eligible: true } });
  const beforeRanked = await prisma.smartMoneyLeaderboardRow.count({
    where: { rank: { not: null, lte: CONFIG.smartMoneyTopLimit } },
  });

  console.log('[recompute-smart-money] before', {
    cachedApiTotal: beforeTotal,
    eligible: beforeEligible,
    ranked: beforeRanked,
  });

  const rankStats = await recomputeSmartMoneyLeaderboardRanks();
  const afterTotal = await countCachedApiSmartMoneyLeaderboardRows();

  console.log('[recompute-smart-money] done', {
    topCount: rankStats.topCount,
    clearedCount: rankStats.clearedCount,
    cachedApiTotal: afterTotal,
    eligibleCount: rankStats.observability.eligibleCount,
    rankedCount: rankStats.observability.rankedCount,
  });
}

main()
  .catch((error) => {
    console.error('[recompute-smart-money] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
