import assert from 'node:assert/strict';
import { Prisma } from '../../generated/prisma/client';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

function mockLeaderboardRow(): import('../../generated/prisma/client').SmartMoneyLeaderboardRow {
  const now = new Date('2026-07-13T00:00:00.000Z');
  return {
    id: 1,
    wallet: '0x00000000000000000000000000000000000000ab',
    rank: 3,
    score: new Prisma.Decimal('78.5'),
    pnlQuality: new Prisma.Decimal('70'),
    activityScore: new Prisma.Decimal('55'),
    consistencyScore: new Prisma.Decimal('62'),
    officialCandidateScore: new Prisma.Decimal('0'),
    externalQualityScore: new Prisma.Decimal('58'),
    riskPenalty: new Prisma.Decimal('12'),
    eligible: true,
    riskFlags: ['LOW_HOLDINGS'],
    scoreVersion: 'v3.1',
    sourceFetchedAt: now,
    lastScoredAt: now,
    syncedAt: now,
    displayName: 'Trader A',
    profileSlug: 'trader-a',
    joinedAtText: 'Jan 2024',
    profileImage: null,
    xUsername: null,
    predictionCount: 120,
    holdingsValue: new Prisma.Decimal('5000'),
    totalPnl: new Prisma.Decimal('12000'),
    sourceRankWeek: 12,
    sourceRankMonth: 8,
    sourceRankAll: 5,
    officialSourceRankWeek: 12,
    officialSourceRankMonth: 8,
    officialSourceRankAll: 5,
    externalSourceRankWeek: 15,
    externalSourceRankMonth: 10,
    externalSourceRankAll: 6,
    candidatePeriods: ['WEEK', 'MONTH'],
    candidateCategories: ['OVERALL'],
    activeCandidate: true,
    externalWinRate: new Prisma.Decimal('0.58'),
    externalSharpeRatio: new Prisma.Decimal('1.2'),
    externalTotalReturn: new Prisma.Decimal('0.35'),
    maxDrawdownPercent: new Prisma.Decimal('0.2'),
    externalMetricsPeriod: 'ALL',
    externalMetricsSource: 'PREDICTING_TOP',
    winRateSource: 'PREDICTING_TOP',
    metricsSourceBadge: 'PREDICTING_TOP',
    scoreExplain: {
      components: { profit: 70, consistency: 62 },
      resolvedMetrics: { totalPnl: 12000, totalVolume: 2_000_000 },
      curve: { curveCount: 25, recentCurveStrength: 0.12 },
    },
    inCopyPool: true,
    copyPoolEnteredAt: now,
    copyPoolExitedAt: null,
    copyPoolMissCount: 0,
    copyabilityScore: new Prisma.Decimal('72'),
    displayScore: new Prisma.Decimal('76'),
    copyabilityComputedAt: now,
  };
}

async function main(): Promise<void> {
  const { scoreResultFromLeaderboardRow } = await import('./smartMoneyScoreResultFromRow');
  const result = scoreResultFromLeaderboardRow(mockLeaderboardRow());
  assert.equal(result.wallet, '0x00000000000000000000000000000000000000ab');
  assert.equal(result.score, 78.5);
  assert.equal(result.eligible, true);
  assert.equal(result.scoreVersion, 'v3.1');
  assert.equal(result.riskFlags.includes('LOW_HOLDINGS'), true);
  assert.equal(result.metrics.totalPnl, 12000);
  assert.equal(result.externalMetricsPeriod, 'ALL');
  assert.equal(result.winRateSource, 'PREDICTING_TOP');

  console.log('smartMoneyScoreResultLoader.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
