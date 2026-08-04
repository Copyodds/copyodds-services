/**
 * 扫描聪明钱榜展示/有 rank 的地址，检出 Yes+No 对冲刷量并立即下榜。
 *
 * Usage:
 *   pnpm run demote:hedged-smart-money:dev -- --dry-run
 *   pnpm run demote:hedged-smart-money:dev
 *   pnpm run demote:hedged-smart-money:dev -- --scope=ranked --concurrency=8
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';
import { fetchDataApiPositions } from '../src/services/polymarket/polymarketData';
import {
  detectHedgedPairExposure,
  HEDGED_PAIR_SHARE_THRESHOLD,
} from '../src/services/smartMoney/smartMoneyPositionStats';
import {
  recomputeSmartMoneyLeaderboardRanks,
} from '../src/services/smartMoney/smartMoneyLeaderboardWriter';
import { smartMoneyCachedDisplayWhere } from '../src/services/smartMoney/smartMoneyLeaderboardSticky';

type Scope = 'display' | 'ranked' | 'eligible';

function parseArgs(): {
  scope: Scope;
  concurrency: number;
  dryRun: boolean;
  limit: number | null;
} {
  const args = process.argv.slice(2);
  let scope: Scope = 'display';
  let concurrency = Math.min(8, CONFIG.smartMoneyFetchConcurrency || 6);
  let dryRun = false;
  let limit: number | null = null;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('--scope=')) {
      const value = arg.slice('--scope='.length);
      if (value === 'display' || value === 'ranked' || value === 'eligible') {
        scope = value;
      } else {
        throw new Error(`Invalid --scope=${value}; use display | ranked | eligible`);
      }
      continue;
    }
    if (arg.startsWith('--concurrency=')) {
      const parsed = Number(arg.slice('--concurrency='.length));
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --concurrency`);
      }
      concurrency = Math.floor(parsed);
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --limit`);
      }
      limit = Math.floor(parsed);
    }
  }

  return { scope, concurrency, dryRun, limit };
}

function scopeWhere(scope: Scope) {
  if (scope === 'display') return smartMoneyCachedDisplayWhere();
  if (scope === 'ranked') return { rank: { not: null, lte: CONFIG.smartMoneyTopLimit } };
  return { eligible: true };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!, index);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

async function demoteHedgedWallet(wallet: string, hedgedPairShare: number): Promise<void> {
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: { riskFlags: true, scoreExplain: true },
  });
  if (!row) return;

  const riskFlags = row.riskFlags.includes('HEDGED_PAIR_EXPOSURE')
    ? row.riskFlags
    : [...row.riskFlags, 'HEDGED_PAIR_EXPOSURE'];

  const prevExplain =
    row.scoreExplain && typeof row.scoreExplain === 'object' && !Array.isArray(row.scoreExplain)
      ? (row.scoreExplain as Record<string, unknown>)
      : {};

  await prisma.smartMoneyLeaderboardRow.update({
    where: { wallet },
    data: {
      eligible: false,
      rank: null,
      riskFlags,
      scoreExplain: {
        ...prevExplain,
        hedgedPairExposure: {
          ...(typeof prevExplain.hedgedPairExposure === 'object' && prevExplain.hedgedPairExposure
            ? (prevExplain.hedgedPairExposure as Record<string, unknown>)
            : {}),
          hedgedPairShare,
          demotedAt: new Date().toISOString(),
          demotedBy: 'demote-hedged-smart-money',
        },
      },
    },
  });
}

async function main(): Promise<void> {
  const { scope, concurrency, dryRun, limit } = parseArgs();
  const where = scopeWhere(scope);
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where,
    select: { wallet: true, rank: true, displayName: true, riskFlags: true },
    orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { score: 'desc' }],
    ...(limit != null ? { take: limit } : {}),
  });

  console.log('[demote-hedged-smart-money] plan', {
    scope,
    walletCount: rows.length,
    concurrency,
    threshold: HEDGED_PAIR_SHARE_THRESHOLD,
    dryRun,
  });

  type Hit = {
    wallet: string;
    rank: number | null;
    displayName: string | null;
    hedgedPairShare: number;
    hedgedMarketCount: number;
  };
  const hits: Hit[] = [];
  let scanned = 0;
  let fetchErrors = 0;

  await mapPool(rows, concurrency, async (row) => {
    try {
      if (row.riskFlags.includes('HEDGED_PAIR_EXPOSURE')) {
        hits.push({
          wallet: row.wallet,
          rank: row.rank,
          displayName: row.displayName,
          hedgedPairShare: 1,
          hedgedMarketCount: -1,
        });
        return;
      }
      const positions = await fetchDataApiPositions(row.wallet, { limit: 500, skipCache: true });
      const exposure = detectHedgedPairExposure(positions);
      scanned += 1;
      if (
        exposure.hedgedPairShare != null &&
        exposure.hedgedPairShare >= HEDGED_PAIR_SHARE_THRESHOLD
      ) {
        hits.push({
          wallet: row.wallet,
          rank: row.rank,
          displayName: row.displayName,
          hedgedPairShare: exposure.hedgedPairShare,
          hedgedMarketCount: exposure.hedgedMarketCount,
        });
      }
    } catch (err) {
      fetchErrors += 1;
      console.warn('[demote-hedged-smart-money] fetch failed', {
        wallet: row.wallet,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  hits.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
  console.log('[demote-hedged-smart-money] hits', {
    scanned,
    fetchErrors,
    hitCount: hits.length,
  });
  for (const hit of hits.slice(0, 50)) {
    console.log(
      `  #${hit.rank ?? '-'} ${hit.displayName ?? ''} ${hit.wallet} share=${hit.hedgedPairShare} markets=${hit.hedgedMarketCount}`
    );
  }
  if (hits.length > 50) {
    console.log(`  ... and ${hits.length - 50} more`);
  }

  if (dryRun) {
    console.log('[demote-hedged-smart-money] dry-run done (no writes)');
    return;
  }

  for (const hit of hits) {
    await demoteHedgedWallet(hit.wallet, hit.hedgedPairShare);
  }

  const rankStats = await recomputeSmartMoneyLeaderboardRanks();
  console.log('[demote-hedged-smart-money] done', {
    demoted: hits.length,
    topCount: rankStats.topCount,
    rankedCount: rankStats.observability.rankedCount,
    cachedApiTotal: rankStats.observability.cachedApiTotal,
  });
}

main()
  .catch((error) => {
    console.error('[demote-hedged-smart-money] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
