/**
 * Backfill LeaderTrade / CopyTradeRow market titles from Polymarket Gamma.
 *
 * Dry-run (default):
 *   npx tsx scripts/backfill-leader-trade-market-titles.ts
 *
 * Execute updates:
 *   npx tsx scripts/backfill-leader-trade-market-titles.ts --execute
 *
 * Options:
 *   --limit=500        Max leader trades to scan (default 500)
 *   --batch=25         Gamma batch size (default 25, max 25)
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import {
  fetchMarketMetadataForClobTokenIds,
  type PolymarketTokenMarketMetadata,
} from '../src/services/polymarket/markets';
import {
  GAMMA_MARKET_METADATA_TIMEOUT_MS,
  pickMarketTitleFromMetadata,
} from '../src/copyTrading/services/leaderTradeMarketMetadata';

type Args = {
  execute: boolean;
  limit: number;
  batch: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { execute: false, limit: 500, batch: 25 };
  for (const arg of argv) {
    if (arg === '--execute') {
      out.execute = true;
      continue;
    }
    const [key, value] = arg.split('=', 2);
    if (key === '--limit' && value != null) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      continue;
    }
    if (key === '--batch' && value != null) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.batch = Math.min(25, Math.floor(n));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await prisma.leaderTrade.findMany({
    where: {
      OR: [{ marketTitle: null }, { marketTitle: '' }, { outcome: null }, { outcome: '' }],
    },
    select: { id: true, tokenId: true, marketTitle: true, outcome: true },
    orderBy: { createdAt: 'desc' },
    take: args.limit,
  });

  const eligible = rows.filter((row) => /^\d+$/.test(row.tokenId.trim()));
  console.log('[backfill-leader-trade-market-titles] scan', {
    execute: args.execute,
    scanned: rows.length,
    eligible: eligible.length,
    limit: args.limit,
  });

  if (!eligible.length) {
    await prisma.$disconnect();
    return;
  }

  let updatedLeaderTrades = 0;
  let updatedCopyRows = 0;

  for (let i = 0; i < eligible.length; i += args.batch) {
    const chunk = eligible.slice(i, i + args.batch);
    const tokenIds = chunk.map((row) => row.tokenId.trim());
    const metaMap = await fetchMarketMetadataForClobTokenIds(tokenIds, {
      forceRefresh: true,
      timeoutMs: GAMMA_MARKET_METADATA_TIMEOUT_MS,
    }).catch(() => new Map<string, PolymarketTokenMarketMetadata>());

    for (const row of chunk) {
      const meta = metaMap.get(row.tokenId.trim());
      const marketTitle = row.marketTitle?.trim() || pickMarketTitleFromMetadata(meta);
      const outcome = row.outcome?.trim() || meta?.outcome?.trim() || null;
      if (!marketTitle && !outcome) continue;

      console.log('[backfill-leader-trade-market-titles] candidate', {
        leaderTradeId: row.id,
        tokenId: row.tokenId,
        marketTitle,
        outcome,
        execute: args.execute,
      });

      if (!args.execute) continue;

      await prisma.leaderTrade.update({
        where: { id: row.id },
        data: {
          ...(marketTitle ? { marketTitle } : {}),
          ...(outcome ? { outcome } : {}),
        },
      });
      updatedLeaderTrades += 1;

      if (marketTitle) {
        const copyTitle = await prisma.copyTradeRow.updateMany({
          where: { leaderTradeId: row.id, OR: [{ marketTitle: null }, { marketTitle: '' }] },
          data: { marketTitle },
        });
        updatedCopyRows += copyTitle.count;
      }
      if (outcome) {
        const copyOutcome = await prisma.copyTradeRow.updateMany({
          where: { leaderTradeId: row.id, OR: [{ outcome: null }, { outcome: '' }] },
          data: { outcome },
        });
        updatedCopyRows += copyOutcome.count;
      }
    }
  }

  console.log('[backfill-leader-trade-market-titles] done', {
    execute: args.execute,
    updatedLeaderTrades,
    updatedCopyRows,
  });

  await prisma.$disconnect();
}

void main().catch((err) => {
  console.error('[backfill-leader-trade-market-titles] fatal', err);
  process.exit(1);
});
