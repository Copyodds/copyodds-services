/**
 * v4.1 只读影子评分：基于已落库 explain/窗口列比较现有 CopyPool。
 *
 * Usage:
 *   npx tsx scripts/shadow-smart-money-v41.ts
 *   npx tsx scripts/shadow-smart-money-v41.ts --json
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import {
  SMART_MONEY_SCORE_V40_WEIGHTS,
  computeSignedPnlFactor,
} from '../src/services/smartMoney/smartMoneyScoreV40';

type Explain = {
  v40?: { factors?: Record<string, unknown>; penalties?: { P_hft?: unknown } };
  resolvedMetrics?: { totalVolume?: unknown };
  displayProfile?: {
    trades30d?: unknown;
    pnlWindowMetrics?: {
      pnl7d?: { returnRatio?: unknown; coverageRatio?: unknown };
      pnl30d?: { returnRatio?: unknown; coverageRatio?: unknown };
      pnl1y?: {
        pnlUsd?: unknown;
        actualWindowDays?: unknown;
        returnRatio?: unknown;
        maxDrawdownRatio?: unknown;
      };
    };
  };
};

const HARD_FLAGS = new Set([
  'BLACKLISTED',
  'NEGATIVE_TOTAL_PNL',
  'HEDGED_PAIR_EXPOSURE',
  'HIGH_TRADE_FREQUENCY',
]);

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function factor(factors: Record<string, unknown>, key: string, fallback = 50): number {
  return finite(factors[key]) ?? fallback;
}

function shadowScore(explain: Explain): number | null {
  const factors = explain.v40?.factors;
  const windows = explain.displayProfile?.pnlWindowMetrics;
  if (!factors || !windows) return null;
  const w = SMART_MONEY_SCORE_V40_WEIGHTS;
  const pnl7 = computeSignedPnlFactor(
    finite(windows.pnl7d?.returnRatio),
    finite(windows.pnl7d?.coverageRatio)
  );
  const pnl30 = computeSignedPnlFactor(
    finite(windows.pnl30d?.returnRatio),
    finite(windows.pnl30d?.coverageRatio)
  );
  const raw =
    w.base * factor(factors, 'S_base') +
    w.roi * factor(factors, 'S_roi') +
    w.recent_pnl * pnl7 +
    w.pnl_30d * pnl30 +
    w.total_pnl * factor(factors, 'S_total_pnl') +
    w.sharpe * factor(factors, 'S_sharpe') +
    w.mdd * factor(factors, 'S_mdd') +
    w.win_rate * factor(factors, 'S_win_rate') +
    w.profit_factor * factor(factors, 'S_profit_factor') +
    w.concentration * factor(factors, 'S_concentration') +
    w.copyability * factor(factors, 'S_copyability', 45) +
    w.activity_freq * factor(factors, 'S_activity_freq', 40) +
    w.consistency * factor(factors, 'S_consistency') +
    w.distribution * factor(factors, 'S_distribution', 45);
  return Math.round(Math.max(0, Math.min(100, raw - (finite(explain.v40?.penalties?.P_hft) ?? 0))) * 100) / 100;
}

async function main(): Promise<void> {
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    select: {
      wallet: true,
      rank: true,
      inCopyPool: true,
      riskFlags: true,
      scoreExplain: true,
    },
  });
  const results = rows.map((row) => {
    const explain = (row.scoreExplain ?? {}) as Explain;
    const window = explain.displayProfile?.pnlWindowMetrics?.pnl1y;
    const score = shadowScore(explain);
    const pnl1y = finite(window?.pnlUsd);
    const days = finite(window?.actualWindowDays);
    const return1y = finite(window?.returnRatio);
    const mdd1y = finite(window?.maxDrawdownRatio);
    const trades30d = finite(explain.displayProfile?.trades30d);
    const volume = finite(explain.resolvedMetrics?.totalVolume);
    const known =
      score != null &&
      pnl1y != null &&
      days != null &&
      return1y != null &&
      mdd1y != null &&
      trades30d != null &&
      volume != null;
    const eligible =
      known &&
      pnl1y > 1_000 &&
      days >= 90 &&
      return1y >= 0.01 &&
      mdd1y <= 0.35 &&
      mdd1y <= return1y &&
      trades30d >= 2 &&
      volume > 100_000 &&
      score >= 40 &&
      !row.riskFlags.some((flag) => HARD_FLAGS.has(flag));
    return { wallet: row.wallet, oldRank: row.rank, oldPool: row.inCopyPool, score, known, eligible };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    fullyKnown: results.filter((row) => row.known).length,
    currentPool: results.filter((row) => row.oldPool).length,
    shadowPool: results.filter((row) => row.eligible).length,
    retained: results.filter((row) => row.oldPool && row.eligible).length,
    shadowEntrants: results.filter((row) => !row.oldPool && row.eligible).length,
    shadowExits: results.filter((row) => row.oldPool && !row.eligible).length,
    topShadow: results
      .filter((row) => row.eligible)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, 100),
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `[smart-money-shadow-v41] total=${report.total} known=${report.fullyKnown} current=${report.currentPool} shadow=${report.shadowPool} retained=${report.retained} entrants=${report.shadowEntrants} exits=${report.shadowExits}`
    );
  }
}

main()
  .catch((error) => {
    console.error('[smart-money-shadow-v41] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
