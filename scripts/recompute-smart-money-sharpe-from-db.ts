/**
 * 仅用 DB 中 TraderCurvePoint(PORTFOLIO_PNL_ALL) 重算 local ALL×1Y 夏普，
 * 写回 SmartMoneyLeaderboardRow.externalSharpeRatio。不拉上游、不 Deep。
 *
 * Usage:
 *   npx tsx scripts/recompute-smart-money-sharpe-from-db.ts
 *   npx tsx scripts/recompute-smart-money-sharpe-from-db.ts --scope=eligible
 *   npx tsx scripts/recompute-smart-money-sharpe-from-db.ts --dry-run --limit=20
 */
import { prisma } from '../src/db';
import { computeLocalSharpeLikeAll1yFromPoints } from '../src/services/smartMoney/smartMoneyScorer';
import { recomputeSmartMoneyLeaderboardRanks } from '../src/services/smartMoney/smartMoneyLeaderboardWriter';

type Scope = 'eligible' | 'ranked' | 'display' | 'all-scored';

function parseArgs(): { scope: Scope; limit: number | null; dryRun: boolean; ranks: boolean } {
  const args = process.argv.slice(2);
  let scope: Scope = 'eligible';
  let limit: number | null = null;
  let dryRun = false;
  let ranks = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--ranks') ranks = true;
    else if (a.startsWith('--scope=')) scope = a.slice('--scope='.length) as Scope;
    else if (a === '--scope') scope = args[++i] as Scope;
    else if (a.startsWith('--limit=')) limit = Number(a.slice('--limit='.length));
    else if (a === '--limit') limit = Number(args[++i]);
  }
  return { scope, limit, dryRun, ranks };
}

function roundSharpe(value: number): number {
  return Math.round(value * 10000) / 10000;
}

async function loadWallets(scope: Scope, limit: number | null): Promise<string[]> {
  if (scope === 'all-scored') {
    // score is non-null Decimal on every row — "all scored" = all leaderboard rows
    const rows = await prisma.smartMoneyLeaderboardRow.findMany({
      select: { wallet: true },
      orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { score: 'desc' }],
      ...(limit != null ? { take: limit } : {}),
    });
    return rows.map((r) => r.wallet);
  }
  const where =
    scope === 'ranked'
      ? { inCopyPool: true, rank: { not: null } }
      : scope === 'display'
        ? { inCopyPool: true, rank: { lte: 200 } }
        : { inCopyPool: true };
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where,
    select: { wallet: true },
    orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { score: 'desc' }],
    ...(limit != null ? { take: limit } : {}),
  });
  return rows.map((r) => r.wallet);
}

async function loadAllCurvePoints(wallet: string): Promise<Array<{ ts: Date; value: number }>> {
  const snapshot = await prisma.traderProfileSnapshot.findFirst({
    where: { wallet },
    orderBy: [{ snapshotAt: 'desc' }, { id: 'desc' }],
    select: { snapshotAt: true },
  });

  let rows =
    snapshot == null
      ? await prisma.traderCurvePoint.findMany({
          where: { wallet, curveType: 'PORTFOLIO_PNL_ALL' },
          orderBy: { ts: 'asc' },
          select: { ts: true, value: true },
        })
      : await prisma.traderCurvePoint.findMany({
          where: { wallet, curveType: 'PORTFOLIO_PNL_ALL', snapshotAt: snapshot.snapshotAt },
          orderBy: { ts: 'asc' },
          select: { ts: true, value: true },
        });

  if (rows.length < 2 && snapshot != null) {
    rows = await prisma.traderCurvePoint.findMany({
      where: { wallet, curveType: 'PORTFOLIO_PNL_ALL' },
      orderBy: { ts: 'asc' },
      select: { ts: true, value: true },
    });
  }

  return rows
    .map((r) => ({ ts: r.ts, value: Number(r.value) }))
    .filter((r) => Number.isFinite(r.value));
}

async function main(): Promise<void> {
  const { scope, limit, dryRun, ranks } = parseArgs();
  const startedAt = Date.now();
  const wallets = await loadWallets(scope, limit);
  console.log('[recompute-sharpe-from-db] plan', {
    scope,
    walletCount: wallets.length,
    dryRun,
    ranks,
  });

  let updated = 0;
  let unchanged = 0;
  let nullSharpe = 0;
  let noCurve = 0;
  const samples: Array<{
    wallet: string;
    before: string | null;
    after: string | null;
    delta: number | null;
  }> = [];

  for (let i = 0; i < wallets.length; i += 1) {
    const wallet = wallets[i];
    const beforeRow = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet },
      select: { externalSharpeRatio: true },
    });
    const before =
      beforeRow?.externalSharpeRatio == null ? null : Number(beforeRow.externalSharpeRatio);

    const points = await loadAllCurvePoints(wallet);
    if (points.length < 2) {
      noCurve += 1;
      if (samples.length < 15) {
        samples.push({
          wallet,
          before: before == null ? null : String(before),
          after: null,
          delta: null,
        });
      }
      continue;
    }

    const raw = computeLocalSharpeLikeAll1yFromPoints(points);
    const after = raw == null ? null : roundSharpe(raw);
    if (after == null) nullSharpe += 1;

    const changed =
      (before == null && after != null) ||
      (before != null && after == null) ||
      (before != null && after != null && Math.abs(before - after) > 1e-9);

    if (samples.length < 20 && changed) {
      samples.push({
        wallet,
        before: before == null ? null : String(before),
        after: after == null ? null : String(after),
        delta: before != null && after != null ? after - before : null,
      });
    }

    if (!changed) {
      unchanged += 1;
    } else if (!dryRun) {
      await prisma.smartMoneyLeaderboardRow.update({
        where: { wallet },
        data: {
          externalSharpeRatio: after == null ? null : after,
        },
      });
      updated += 1;
    } else {
      updated += 1;
    }

    if ((i + 1) % 50 === 0 || i + 1 === wallets.length) {
      console.log('[recompute-sharpe-from-db] progress', {
        processed: i + 1,
        total: wallets.length,
        updated,
        unchanged,
        nullSharpe,
        noCurve,
      });
    }
  }

  if (!dryRun && ranks) {
    const rankStats = await recomputeSmartMoneyLeaderboardRanks();
    console.log('[recompute-sharpe-from-db] ranks', {
      topCount: rankStats.topCount,
      rankedCount: rankStats.observability.rankedCount,
    });
  }

  console.log('[recompute-sharpe-from-db] samples (changed)', samples);
  console.log('[recompute-sharpe-from-db] finished', {
    scope,
    walletCount: wallets.length,
    updated,
    unchanged,
    nullSharpe,
    noCurve,
    dryRun,
    elapsedMs: Date.now() - startedAt,
  });
}

main()
  .catch((error) => {
    console.error('[recompute-sharpe-from-db] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
