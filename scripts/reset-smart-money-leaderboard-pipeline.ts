/**
 * 清零 Smart Money 跟单排行榜管道数据（冷启动）。
 *
 * Usage:
 *   CONFIRM_RESET=YES npx tsx scripts/reset-smart-money-leaderboard-pipeline.ts
 *   CONFIRM_RESET=YES npx tsx scripts/reset-smart-money-leaderboard-pipeline.ts --dry-run
 *
 * 不清用户跟单订阅等业务表。
 */
import '../src/loadEnv';
import { prisma } from '../src/db';

const DRY_RUN = process.argv.includes('--dry-run');

async function countAll() {
  const [leaderboard, scoreCache, raw, cursor] = await Promise.all([
    prisma.smartMoneyLeaderboardRow.count(),
    prisma.smartMoneyScoreCache.count(),
    prisma.smartMoneyRawAddress.count(),
    prisma.smartMoneyPipelineCursor.count(),
  ]);
  return { leaderboard, scoreCache, raw, cursor };
}

async function main(): Promise<void> {
  if (process.env.CONFIRM_RESET !== 'YES') {
    console.error('[reset] refused: set CONFIRM_RESET=YES to proceed');
    process.exitCode = 1;
    return;
  }

  const before = await countAll();
  console.log('[reset] before', before, DRY_RUN ? '(dry-run)' : '');

  if (DRY_RUN) {
    console.log('[reset] dry-run complete; no writes');
    return;
  }

  const deletedLeaderboard = await prisma.smartMoneyLeaderboardRow.deleteMany({});
  const deletedScoreCache = await prisma.smartMoneyScoreCache.deleteMany({});
  const deletedRaw = await prisma.smartMoneyRawAddress.deleteMany({});

  await prisma.smartMoneyPipelineCursor.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      lightRoundRobinCounter: BigInt(0),
      deepRoundRobinCounter: BigInt(0),
      lastLightTickAt: null,
      lastDeepTickAt: null,
    },
    update: {
      lightRoundRobinCounter: BigInt(0),
      deepRoundRobinCounter: BigInt(0),
      lastLightTickAt: null,
      lastDeepTickAt: null,
    },
  });

  const after = await countAll();
  console.log('[reset] deleted', {
    leaderboard: deletedLeaderboard.count,
    scoreCache: deletedScoreCache.count,
    raw: deletedRaw.count,
  });
  console.log('[reset] after', after);
  console.log('[reset] done — restart crons and run discovery sync to refill Raw');
}

main()
  .catch((error) => {
    console.error('[reset] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
