/**
 * 一次性：把 CopyPool 榜行的 scoreExplain / score 回写到 ScoreCache，
 * 修复历史「copyability 只改榜、不改 Cache」造成的分叉。
 *
 * 用法（在 polymarket-backend 目录）:
 *   node --env-file=.env --import tsx scripts/sync-score-cache-from-leaderboard.ts
 *   node --env-file=.env --import tsx scripts/sync-score-cache-from-leaderboard.ts --limit=50
 */
import { prisma } from '../src/db';
import { syncSmartMoneyScoreCacheDisplayFromLeaderboard } from '../src/services/smartMoney/smartMoneyScoreCache';

async function main(): Promise<void> {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg != null ? Math.max(1, Number(limitArg.slice('--limit='.length)) || 0) : null;

  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    select: { wallet: true },
    orderBy: [{ rank: 'asc' }, { wallet: 'asc' }],
    ...(limit != null ? { take: limit } : {}),
  });

  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    try {
      const synced = await syncSmartMoneyScoreCacheDisplayFromLeaderboard(row.wallet);
      if (synced) ok += 1;
      else fail += 1;
    } catch (err) {
      fail += 1;
      console.error('sync fail', row.wallet, err);
    }
  }

  console.log(JSON.stringify({ total: rows.length, ok, fail }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
