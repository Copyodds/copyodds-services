/**
 * Smart Money 新门槛影子统计（只读）。
 *
 * Usage:
 *   npx tsx scripts/analyze-smart-money-rule-impact.ts
 *   npx tsx scripts/analyze-smart-money-rule-impact.ts --json
 */
import '../src/loadEnv';
import { prisma } from '../src/db';

type Explain = {
  displayProfile?: {
    recentPnl7d?: unknown;
    recentPnl30d?: unknown;
    totalPnl1y?: unknown;
    pnlWindowDays?: unknown;
    trades30d?: unknown;
  };
  resolvedMetrics?: { totalVolume?: unknown };
};

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function percent(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 10_000) / 100 : 0;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    select: {
      wallet: true,
      inCopyPool: true,
      holdingsValue: true,
      totalPnl: true,
      recentPnl7d: true,
      totalPnl1y: true,
      pnlWindowDays: true,
      scoreExplain: true,
    },
  });

  const counters = {
    total: rows.length,
    currentCopyPool: 0,
    holdingsKnown: 0,
    holdingsAbove20k: 0,
    pnl1yKnown: 0,
    pnl1yAbove1k: 0,
    pnlWindowAtLeast90d: 0,
    trades30dKnown: 0,
    trades30dAtLeast2: 0,
    lifetimeVolumeKnown: 0,
    lifetimeVolumeAbove100k: 0,
    recentPnl7dKnown: 0,
    recentPnl7dPositive: 0,
    proposedCoreKnown: 0,
    proposedCorePassed: 0,
  };

  for (const row of rows) {
    const explain = (row.scoreExplain ?? {}) as Explain;
    const display = explain.displayProfile ?? {};
    const holdings = finite(row.holdingsValue);
    const pnl1y = finite(row.totalPnl1y) ?? finite(display.totalPnl1y);
    const windowDays = row.pnlWindowDays ?? finite(display.pnlWindowDays);
    const trades30d = finite(display.trades30d);
    const totalVolume = finite(explain.resolvedMetrics?.totalVolume);
    const pnl7d = finite(row.recentPnl7d) ?? finite(display.recentPnl7d);

    if (row.inCopyPool) counters.currentCopyPool += 1;
    if (holdings != null) counters.holdingsKnown += 1;
    if (holdings != null && holdings > 20_000) counters.holdingsAbove20k += 1;
    if (pnl1y != null) counters.pnl1yKnown += 1;
    if (pnl1y != null && pnl1y > 1_000) counters.pnl1yAbove1k += 1;
    if (windowDays != null && windowDays >= 90) counters.pnlWindowAtLeast90d += 1;
    if (trades30d != null) counters.trades30dKnown += 1;
    if (trades30d != null && trades30d >= 2) counters.trades30dAtLeast2 += 1;
    if (totalVolume != null) counters.lifetimeVolumeKnown += 1;
    if (totalVolume != null && totalVolume > 100_000) counters.lifetimeVolumeAbove100k += 1;
    if (pnl7d != null) counters.recentPnl7dKnown += 1;
    if (pnl7d != null && pnl7d > 0) counters.recentPnl7dPositive += 1;

    const coreKnown =
      pnl1y != null && windowDays != null && trades30d != null && totalVolume != null;
    if (coreKnown) counters.proposedCoreKnown += 1;
    if (
      coreKnown &&
      pnl1y > 1_000 &&
      windowDays >= 90 &&
      trades30d >= 2 &&
      totalVolume > 100_000
    ) {
      counters.proposedCorePassed += 1;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    counters,
    rates: Object.fromEntries(
      Object.entries(counters)
        .filter(([key]) => key !== 'total')
        .map(([key, value]) => [key, percent(value, counters.total)])
    ),
    notes: [
      'This script is read-only.',
      'Unknown values are reported separately and never treated as zero.',
      'Run after a v4.1 shadow rescore to populate 30d fields.',
    ],
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[smart-money-impact] rows=${counters.total}`);
    for (const [key, value] of Object.entries(counters)) {
      if (key === 'total') continue;
      console.log(`[smart-money-impact] ${key}=${value} (${percent(value, counters.total)}%)`);
    }
  }
}

main()
  .catch((error) => {
    console.error('[smart-money-impact] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
