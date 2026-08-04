/**
 * 删除从未向 Polymarket 发单的「资金/Gas 不足 skipped」跟单执行行。
 *
 * 本地: npx tsx scripts/cleanup-funding-skipped-copy-trades.ts [--dry-run] [--user-id=1] [--limit=5000]
 * 打包: npm run cleanup:funding-skipped-copy-trades
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { CopyTradeStatus } from '../src/generated/prisma/enums';
import { COPY_BUY_FUNDING_WARNING_CODES } from '../src/copyTrading/services/copyFundingMonitor';

const FUNDING_SKIP_ERROR_CODES = [...COPY_BUY_FUNDING_WARNING_CODES];

function parseArgs(argv: string[]): { dryRun: boolean; userId?: number; limit: number } {
  let dryRun = false;
  let userId: number | undefined;
  let limit = 5000;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--user-id=')) {
      const n = Number(arg.slice('--user-id='.length));
      if (Number.isInteger(n) && n > 0) userId = n;
    } else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (Number.isInteger(n) && n > 0) limit = n;
    }
  }
  return { dryRun, userId, limit };
}

async function filterRowsWithoutLotLinks(rowIds: string[]): Promise<string[]> {
  if (rowIds.length === 0) return [];

  const [buyLots, lotCloses] = await Promise.all([
    prisma.copyPositionLot.findMany({
      where: { buyCopyTradeRowId: { in: rowIds } },
      select: { buyCopyTradeRowId: true },
    }),
    prisma.copyPositionLotClose.findMany({
      where: {
        OR: [{ sellCopyTradeRowId: { in: rowIds } }, { buyCopyTradeRowId: { in: rowIds } }],
      },
      select: { sellCopyTradeRowId: true, buyCopyTradeRowId: true },
    }),
  ]);

  const blocked = new Set<string>();
  for (const lot of buyLots) blocked.add(lot.buyCopyTradeRowId);
  for (const close of lotCloses) {
    blocked.add(close.sellCopyTradeRowId);
    blocked.add(close.buyCopyTradeRowId);
  }

  return rowIds.filter((id) => !blocked.has(id));
}

async function main() {
  const { dryRun, userId, limit } = parseArgs(process.argv.slice(2));

  const candidates = await prisma.copyTradeRow.findMany({
    where: {
      status: CopyTradeStatus.skipped,
      errorCode: { in: FUNDING_SKIP_ERROR_CODES },
      OR: [{ polymarketOrderId: null }, { polymarketOrderId: '' }],
      ...(userId != null ? { userId } : {}),
    },
    select: {
      id: true,
      userId: true,
      subscriptionId: true,
      errorCode: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const deletableIds = await filterRowsWithoutLotLinks(candidates.map((row) => row.id));
  const skippedDueToLots = candidates.length - deletableIds.length;

  console.log('[cleanup-funding-skipped-copy-trades] scan', {
    dryRun,
    userId: userId ?? 'all',
    candidateCount: candidates.length,
    deletableCount: deletableIds.length,
    skippedDueToLotLinks: skippedDueToLots,
    errorCodes: FUNDING_SKIP_ERROR_CODES,
  });

  if (deletableIds.length === 0) {
    console.log('[cleanup-funding-skipped-copy-trades] nothing to delete');
    return;
  }

  if (dryRun) {
    console.log('[cleanup-funding-skipped-copy-trades] sample ids', deletableIds.slice(0, 20));
    return;
  }

  const batchSize = 200;
  let deleted = 0;
  for (let i = 0; i < deletableIds.length; i += batchSize) {
    const batch = deletableIds.slice(i, i + batchSize);
    const result = await prisma.copyTradeRow.deleteMany({ where: { id: { in: batch } } });
    deleted += result.count;
  }

  console.log('[cleanup-funding-skipped-copy-trades] deleted', { deleted });
}

main()
  .catch((error) => {
    console.error('[cleanup-funding-skipped-copy-trades] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
