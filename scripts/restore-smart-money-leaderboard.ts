/**
 * 一键恢复聪明钱榜软性不合格地址的入榜资格并重算排名。
 * 硬踢（黑名单/噪声/对冲刷量/确认亏损）不会恢复。
 *
 * Usage:
 *   pnpm run restore:smart-money:dev
 *   pnpm run restore:smart-money:dev -- --dry-run
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';
import {
  countCachedApiSmartMoneyLeaderboardRows,
  recomputeSmartMoneyLeaderboardRanks,
  restoreSmartMoneyLeaderboardEligibility,
} from '../src/services/smartMoney/smartMoneyLeaderboardWriter';

function parseDryRun(): boolean {
  return process.argv.slice(2).includes('--dry-run');
}

async function main(): Promise<void> {
  const dryRun = parseDryRun();
  const beforeTotal = await countCachedApiSmartMoneyLeaderboardRows();
  const beforeEligible = await prisma.smartMoneyLeaderboardRow.count({ where: { eligible: true } });
  const beforeActive = await prisma.smartMoneyLeaderboardRow.count({ where: { activeCandidate: true } });
  const beforeRanked = await prisma.smartMoneyLeaderboardRow.count({
    where: { rank: { not: null, lte: CONFIG.smartMoneyTopLimit } },
  });

  console.log('[restore-smart-money] before', {
    scoreVersion: CONFIG.smartMoneyScoreVersion,
    topLimit: CONFIG.smartMoneyTopLimit,
    cachedApiTotal: beforeTotal,
    eligible: beforeEligible,
    activeCandidate: beforeActive,
    ranked: beforeRanked,
    dryRun,
  });

  if (dryRun) {
    const wouldRestore = await prisma.smartMoneyLeaderboardRow.count({
      where: {
        OR: [{ eligible: false }, { activeCandidate: false }],
        NOT: [
          { riskFlags: { has: 'BLACKLISTED' } },
          { riskFlags: { has: 'NOISE_TAGGED' } },
          { riskFlags: { has: 'HEDGED_PAIR_EXPOSURE' } },
        ],
      },
    });
    console.log('[restore-smart-money] dry-run would touch rows (upper bound):', wouldRestore);
    return;
  }

  const restored = await restoreSmartMoneyLeaderboardEligibility();
  const rankStats = await recomputeSmartMoneyLeaderboardRanks();
  const afterTotal = await countCachedApiSmartMoneyLeaderboardRows();

  console.log('[restore-smart-money] done', {
    restoredRows: restored.restoredRows,
    topCount: rankStats.topCount,
    clearedCount: rankStats.clearedCount,
    cachedApiTotal: afterTotal,
    eligibleCount: rankStats.observability.eligibleCount,
    rankedCount: rankStats.observability.rankedCount,
  });
}

main()
  .catch((error) => {
    console.error('[restore-smart-money] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
