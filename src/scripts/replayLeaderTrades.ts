/**
 * 重放：为未处理或需补派发的 LeaderTrade 直接 dispatch（不经 BullMQ）
 * 用法:
 *   本地: npx tsx src/scripts/replayLeaderTrades.ts [--unprocessed-only]
 *   服务器(deploy): npm run replay:leader-trades [-- --unprocessed-only]
 */
import '../loadEnv';
import { prisma } from '../db';
import { dispatchLeaderTrade } from '../copyTrading/services/dispatchLeaderTrade';
import { shouldRedispatchLeaderTrade } from '../copyTrading/services/leaderTradeDispatchGate';

async function main() {
  const unprocessedOnly = process.argv.includes('--unprocessed-only');

  const rows = await prisma.leaderTrade.findMany({
    where: unprocessedOnly ? { processed: false } : {},
    orderBy: { createdAt: 'asc' },
    take: 5000,
  });

  let n = 0;
  for (const lt of rows) {
    if (unprocessedOnly || !lt.processed || (await shouldRedispatchLeaderTrade(lt.id))) {
      await dispatchLeaderTrade(lt.id, 'manual');
      n++;
    }
  }
  console.log(`[replay] dispatched ${n} leader trade(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
