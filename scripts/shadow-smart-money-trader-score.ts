/**
 * TraderScore / Edge 只读影子对比（对照现网 CopyPool 名次）。
 *
 * Usage:
 *   npx tsx scripts/shadow-smart-money-trader-score.ts
 *   npx tsx scripts/shadow-smart-money-trader-score.ts --json
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { assembleSmartMoneyTraderProfile } from '../src/services/smartMoney/smartMoneyTraderProfile';

type Explain = {
  traderProfile?: {
    traderScore?: { score?: unknown };
    tier?: unknown;
    edge?: { edgeScore?: unknown; edgeSampleN?: unknown };
    traderType?: unknown;
  };
  displayProfile?: {
    profitFactor?: unknown;
    winRate?: unknown;
    pnlWindowMetrics?: {
      pnl1y?: { returnRatio?: unknown; maxDrawdownRatio?: unknown };
    };
  };
  closedPositions?: {
    decisiveMarkets?: unknown;
    marketCount?: unknown;
    topMarketPnlShare?: unknown;
    marketWinRate?: unknown;
  };
  v40?: { factors?: { S_copyability?: unknown }; copyabilityMissing?: unknown };
};

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true, rank: { not: null } },
    orderBy: { rank: 'asc' },
    take: 200,
    select: {
      wallet: true,
      rank: true,
      score: true,
      displayScore: true,
      traderScore: true,
      tier: true,
      edgeScore: true,
      traderType: true,
      copyabilityScore: true,
      maxDrawdownPercent: true,
      consistencyScore: true,
      riskFlags: true,
      trades7d: true,
      scoreExplain: true,
      joinedAtText: true,
      activeDays: true,
    },
  });

  const report = rows.map((row) => {
    const explain = (row.scoreExplain ?? {}) as Explain;
    const storedTrader = finite(row.traderScore) ?? finite(explain.traderProfile?.traderScore?.score);
    const storedTier = row.tier ?? (explain.traderProfile?.tier as string | undefined) ?? null;
    return {
      rank: row.rank,
      wallet: row.wallet,
      v40Score: Number(row.score),
      displayScore: row.displayScore != null ? Number(row.displayScore) : null,
      traderScore: storedTrader,
      tier: storedTier,
      edgeScore: finite(row.edgeScore) ?? finite(explain.traderProfile?.edge?.edgeScore),
      traderType: row.traderType ?? explain.traderProfile?.traderType ?? null,
      deltaVsV40:
        storedTrader != null ? Math.round((storedTrader - Number(row.score)) * 100) / 100 : null,
    };
  });

  const withTrader = report.filter((r) => r.traderScore != null);
  const summary = {
    sample: report.length,
    withTraderScore: withTrader.length,
    avgAbsDelta:
      withTrader.length === 0
        ? null
        : Math.round(
            (withTrader.reduce((s, r) => s + Math.abs(r.deltaVsV40 ?? 0), 0) / withTrader.length) *
              100
          ) / 100,
    tierCounts: withTrader.reduce(
      (acc, r) => {
        const t = r.tier ?? '?';
        acc[t] = (acc[t] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    ),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, rows: report }, null, 2));
  } else {
    console.log('[shadow-trader-score] summary', summary);
    for (const row of report.slice(0, 30)) {
      console.log(
        `#${row.rank} ${row.wallet.slice(0, 10)}… v40=${row.v40Score} trader=${row.traderScore} tier=${row.tier} Δ=${row.deltaVsV40}`
      );
    }
  }

  // keep assemble import warm for local dry-run of pure functions
  void assembleSmartMoneyTraderProfile;
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
