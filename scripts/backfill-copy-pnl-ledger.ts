/**
 * 一次性从历史 lot_close / 无 lot 的 copy_trade 回填 UserSettings 盈亏账本。
 * 用法：node --env-file=.env --import tsx scripts/backfill-copy-pnl-ledger.ts
 * 可选：BACKFILL_USER_IDS=18,19  BACKFILL_LIMIT=50
 */
import { prisma } from '../src/db';
import { rebuildCopyPnlSummaryFromAggregatesForUser } from '../src/copyTrading/services/copyPnlSummaryLedger';

async function main() {
  const idsEnv = (process.env.BACKFILL_USER_IDS ?? '').trim();
  const limit = Math.min(500, Math.max(1, Number(process.env.BACKFILL_LIMIT ?? 100) || 100));

  let userIds: number[] = [];
  if (idsEnv) {
    userIds = idsEnv
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } else {
    const [fromLots, fromTrades] = await Promise.all([
      prisma.copyPositionLotClose.findMany({
        distinct: ['userId'],
        select: { userId: true },
        take: limit,
      }),
      prisma.copyTradeRow.findMany({
        where: { realizedPnlUsd: { not: null } },
        distinct: ['userId'],
        select: { userId: true },
        take: limit,
      }),
    ]);
    userIds = [...new Set([...fromLots.map((r) => r.userId), ...fromTrades.map((r) => r.userId)])]
      .sort((a, b) => a - b)
      .slice(0, limit);
  }

  console.log(`[backfill-copy-pnl-ledger] rebuilding ${userIds.length} users...`);
  for (const userId of userIds) {
    try {
      await rebuildCopyPnlSummaryFromAggregatesForUser(userId);
      console.log(`[backfill-copy-pnl-ledger] user=${userId} ok`);
    } catch (err) {
      console.warn(`[backfill-copy-pnl-ledger] user=${userId} failed`, err);
    }
  }
  console.log('[backfill-copy-pnl-ledger] done');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
