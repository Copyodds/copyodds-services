/**
 * Backfill rankScore / copierFeedback / ML displayScore for CopyPool rows.
 *
 * Usage:
 *   npx tsx scripts/backfill-smart-money-rank.ts
 *   npx tsx scripts/backfill-smart-money-rank.ts --limit=50
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { refreshSmartMoneyRankScoreForWallet } from '../src/services/smartMoney/smartMoneyRankRefresh';
import { recomputeSmartMoneyLeaderboardRanks } from '../src/services/smartMoney/smartMoneyLeaderboardWriter';
import { isRankModelActive } from '../src/services/smartMoney/smartMoneyRankModel';

function parseLimitArg(): number | null {
  const arg = process.argv.find((entry) => entry.startsWith('--limit='));
  if (!arg) return null;
  const parsed = Number(arg.split('=')[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

async function main(): Promise<void> {
  if (!isRankModelActive()) {
    console.warn(
      '[backfill-rank] SMART_MONEY_RANK_MODEL_ENABLED and SMART_MONEY_COPYABILITY_ENABLED must both be true'
    );
    process.exitCode = 1;
    return;
  }

  const limit = parseLimitArg();
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    orderBy: [{ rank: 'asc' }, { lastScoredAt: 'desc' }],
    ...(limit != null ? { take: limit } : {}),
    select: { wallet: true },
  });

  console.log(`[backfill-rank] refreshing ${rows.length} CopyPool rows`);
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await refreshSmartMoneyRankScoreForWallet(row.wallet);
      succeeded += 1;
      if (succeeded % 10 === 0) {
        console.log(`[backfill-rank] progress ${succeeded}/${rows.length}`);
      }
    } catch (error) {
      failed += 1;
      console.warn(`[backfill-rank] failed wallet=${row.wallet}`, error);
    }
  }

  await recomputeSmartMoneyLeaderboardRanks();
  console.log(`[backfill-rank] done succeeded=${succeeded} failed=${failed}`);
}

main()
  .catch((error) => {
    console.error('[backfill-rank] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
