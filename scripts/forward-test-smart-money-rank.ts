/**
 * 月度离线 forward test：比较 Phase 2 / Phase 3 排序与真实 copier ROI 的相关性。
 *
 * Usage:
 *   npx tsx scripts/forward-test-smart-money-rank.ts
 *   npx tsx scripts/forward-test-smart-money-rank.ts --json
 *   npx tsx scripts/forward-test-smart-money-rank.ts --limit=100
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';
import type { CopierFeedbackSnapshot } from '../src/services/smartMoney/smartMoneyCopierFeedbackMetrics';
import { aggregateCopierFeedbackForWallets } from '../src/services/smartMoney/smartMoneyCopierFeedback';
import {
  runRankForwardTest,
  type RankForwardTestRow,
} from '../src/services/smartMoney/smartMoneyRankForwardTest';

function parseLimitArg(): number | null {
  const arg = process.argv.find((entry) => entry.startsWith('--limit='));
  if (!arg) return null;
  const parsed = Number(arg.split('=')[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function parseFeedback(value: unknown): CopierFeedbackSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as CopierFeedbackSnapshot;
  return snapshot.version === 'v1' ? snapshot : null;
}

async function main(): Promise<void> {
  const limit = parseLimitArg();
  const asJson = process.argv.includes('--json');

  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    orderBy: [{ rank: 'asc' }, { lastScoredAt: 'desc' }],
    ...(limit != null ? { take: limit } : {}),
    select: {
      wallet: true,
      score: true,
      pnlQuality: true,
      activityScore: true,
      consistencyScore: true,
      externalQualityScore: true,
      copyabilityScore: true,
      rankScore: true,
      copierFeedback: true,
    },
  });

  const wallets = rows.map((row) => row.wallet);
  const [feedbackMap, rawAddresses] = await Promise.all([
    aggregateCopierFeedbackForWallets(wallets, CONFIG.smartMoneyCopierFeedbackLookbackDays),
    prisma.smartMoneyRawAddress.findMany({
      where: { wallet: { in: wallets } },
      select: { wallet: true, tier2EnhancedPassedAt: true },
    }),
  ]);
  const tier2ByWallet = new Map(
    rawAddresses.map((row) => [row.wallet, row.tier2EnhancedPassedAt != null])
  );

  const testRows: RankForwardTestRow[] = rows.map((row) => {
    const feedback =
      feedbackMap.get(row.wallet.toLowerCase()) ?? parseFeedback(row.copierFeedback);
    return {
      wallet: row.wallet,
      smartMoneyScore: Number(row.score),
      copyabilityScore: row.copyabilityScore != null ? Number(row.copyabilityScore) : null,
      rankScore: row.rankScore != null ? Number(row.rankScore) : null,
      copierRoi: feedback?.copierRoi ?? null,
      tier2Enhanced: tier2ByWallet.get(row.wallet) ?? false,
      feedback,
      rowFeatures: {
        score: Number(row.score),
        pnlQuality: Number(row.pnlQuality),
        activityScore: Number(row.activityScore),
        consistencyScore: Number(row.consistencyScore),
        externalQualityScore: Number(row.externalQualityScore),
        copyabilityScore: row.copyabilityScore != null ? Number(row.copyabilityScore) : null,
      },
    };
  });

  const report = runRankForwardTest(testRows, undefined, {
    phase2Copy: CONFIG.smartMoneyDisplayScoreCopyWeight,
    phase2Smart: CONFIG.smartMoneyDisplayScoreSmartWeight,
    phase3Rank: CONFIG.smartMoneyDisplayScoreRankWeight,
    phase3Copy: CONFIG.smartMoneyDisplayScoreCopyWeightMl,
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('[forward-test] smart-money rank variants');
  console.log(`[forward-test] copyPoolRows=${rows.length} lookbackDays=${CONFIG.smartMoneyCopierFeedbackLookbackDays}`);
  for (const variant of report.variants) {
    console.log(
      `[forward-test] ${variant.variant} labeled=${variant.labeledCount} spearman=${variant.spearmanRho ?? 'n/a'} spread=${variant.spreadTopBottom ?? 'n/a'} topDecile=${variant.topDecileMeanRoi ?? 'n/a'} bottomDecile=${variant.bottomDecileMeanRoi ?? 'n/a'}`
    );
  }
  console.log(`[forward-test] winner=${report.winner ?? 'n/a'}`);
}

main()
  .catch((error) => {
    console.error('[forward-test] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
