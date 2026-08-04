/**
 * Backfill copyabilityScore / displayScore for existing CopyPool leaderboard rows.
 *
 * Usage:
 *   npx tsx scripts/backfill-smart-money-copyability.ts
 *   npx tsx scripts/backfill-smart-money-copyability.ts --limit=50
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';
import { refreshSmartMoneyCopyabilityForWallet } from '../src/services/smartMoney/smartMoneyCopyability';
import { recomputeSmartMoneyLeaderboardRanks } from '../src/services/smartMoney/smartMoneyLeaderboardWriter';

function parseLimitArg(): number | null {
  const arg = process.argv.find((entry) => entry.startsWith('--limit='));
  if (!arg) return null;
  const parsed = Number(arg.split('=')[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

async function main(): Promise<void> {
  if (!CONFIG.smartMoneyCopyabilityEnabled) {
    console.warn(
      '[backfill-copyability] SMART_MONEY_COPYABILITY_ENABLED is false — scores will only set displayScore=smartMoneyScore'
    );
  }

  const limit = parseLimitArg();
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    orderBy: [{ rank: 'asc' }, { lastScoredAt: 'desc' }],
    ...(limit != null ? { take: limit } : {}),
    select: { wallet: true, score: true, inCopyPool: true },
  });

  console.log(`[backfill-copyability] refreshing ${rows.length} CopyPool rows`);
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await refreshSmartMoneyCopyabilityForWallet({
        wallet: row.wallet,
        smartMoneyScore: Number(row.score),
        inCopyPool: row.inCopyPool,
      });
      succeeded += 1;
      if (succeeded % 10 === 0) {
        console.log(`[backfill-copyability] progress ${succeeded}/${rows.length}`);
      }
    } catch (error) {
      failed += 1;
      console.warn(`[backfill-copyability] failed wallet=${row.wallet}`, error);
    }
  }

  await recomputeSmartMoneyLeaderboardRanks();
  console.log(`[backfill-copyability] done succeeded=${succeeded} failed=${failed}`);
}

main()
  .catch((error) => {
    console.error('[backfill-copyability] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
