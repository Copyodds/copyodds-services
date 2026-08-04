/**
 * 聪明钱跟单榜漏斗诊断：定位 Raw / ScoreCache / CopyPool /cached 缺口。
 *
 * Usage:
 *   npm run diagnose:smart-money
 *   npm run diagnose:smart-money:dev
 *
 * 口径：对外榜 = inCopyPool；不再用 eligible/activeCandidate 解释榜单。
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';
import { smartMoneyCachedDisplayWhere } from '../src/services/smartMoney/smartMoneyLeaderboardSticky';
import { getSmartMoneyLeaderboardObservability } from '../src/services/smartMoney/smartMoneyLeaderboardWriter';

function bar(label: string, count: number, max: number): string {
  const width = 40;
  const ratio = max > 0 ? Math.min(1, count / max) : 0;
  const filled = Math.round(ratio * width);
  return `${label.padEnd(36)} ${String(count).padStart(5)}  ${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

async function countActiveObservedWithoutLeaderboardRow(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "ObservedTrader" ot
    WHERE ot."candidateActive" = true
      AND ot."enabled" = true
      AND ot."blacklisted" = false
      AND NOT EXISTS (
        SELECT 1 FROM "SmartMoneyLeaderboardRow" sm WHERE sm."wallet" = ot."wallet"
      )
  `;
  return Number(rows[0]?.count ?? 0);
}

async function countExternalLeaderboardRows(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};

  const ptPeriods = await prisma.predictingTopLeaderboardRow.groupBy({
    by: ['period'],
    _max: { syncVersion: true },
  });
  for (const row of ptPeriods) {
    const syncVersion = row._max.syncVersion;
    if (syncVersion == null) continue;
    const count = await prisma.predictingTopLeaderboardRow.count({
      where: { period: row.period, syncVersion },
    });
    out[`predictingTop.${row.period}`] = count;
  }

  const paPeriods = await prisma.polymarketAnalyticsLeaderboardRow.groupBy({
    by: ['period'],
    _max: { syncVersion: true },
  });
  for (const row of paPeriods) {
    const syncVersion = row._max.syncVersion;
    if (syncVersion == null) continue;
    const count = await prisma.polymarketAnalyticsLeaderboardRow.count({
      where: { period: row.period, syncVersion },
    });
    out[`polymarketAnalytics.${row.period}`] = count;
  }

  return out;
}

async function main(): Promise<void> {
  const freshSince = new Date(Date.now() - CONFIG.smartMoneyScoreFreshnessMs);
  const apiWhere = smartMoneyCachedDisplayWhere();

  const [
    externalCounts,
    observability,
    predictingTopWallets,
    analyticsWallets,
    activeObserved,
    activeNeverFetched,
    activeFetched,
    leaderboardTotal,
    withActiveCandidate,
    withEligible,
    withFreshFetch,
    withRank,
    apiTotal,
    activeWithoutRow,
    activeWithoutFetch,
    activeIneligible,
    eligibleActiveNoRank,
    staleEligible,
    ineligibleFlags,
    blockScanAccumulating,
    blockScanQualified,
    blockScanPromoted,
    blockScanScored,
    blockScanPendingScore,
  ] = await Promise.all([
    countExternalLeaderboardRows(),
    getSmartMoneyLeaderboardObservability(),
    prisma.predictingTopLeaderboardRow.findMany({
      where: {
        period: 'ALL',
        syncVersion: (
          await prisma.predictingTopLeaderboardRow.aggregate({
            where: { period: 'ALL' },
            _max: { syncVersion: true },
          })
        )._max.syncVersion ?? -1,
      },
      select: { wallet: true },
      distinct: ['wallet'],
    }),
    prisma.polymarketAnalyticsLeaderboardRow.findMany({
      where: {
        period: 'ALL',
        syncVersion: (
          await prisma.polymarketAnalyticsLeaderboardRow.aggregate({
            where: { period: 'ALL' },
            _max: { syncVersion: true },
          })
        )._max.syncVersion ?? -1,
      },
      select: { wallet: true },
      distinct: ['wallet'],
    }),
    prisma.observedTrader.count({
      where: { candidateActive: true, enabled: true, blacklisted: false },
    }),
    prisma.observedTrader.count({
      where: {
        candidateActive: true,
        enabled: true,
        blacklisted: false,
        lastFetchedAt: null,
      },
    }),
    prisma.observedTrader.count({
      where: {
        candidateActive: true,
        enabled: true,
        blacklisted: false,
        lastFetchedAt: { not: null },
      },
    }),
    prisma.smartMoneyLeaderboardRow.count(),
    prisma.smartMoneyLeaderboardRow.count({ where: { activeCandidate: true } }),
    prisma.smartMoneyLeaderboardRow.count({ where: { activeCandidate: true, eligible: true } }),
    prisma.smartMoneyLeaderboardRow.count({
      where: { activeCandidate: true, eligible: true, sourceFetchedAt: { gte: freshSince } },
    }),
    prisma.smartMoneyLeaderboardRow.count({
      where: {
        activeCandidate: true,
        eligible: true,
        sourceFetchedAt: { gte: freshSince },
        rank: { not: null },
      },
    }),
    prisma.smartMoneyLeaderboardRow.count({ where: apiWhere }),
    countActiveObservedWithoutLeaderboardRow(),
    prisma.observedTrader.count({
      where: {
        candidateActive: true,
        enabled: true,
        blacklisted: false,
        lastFetchedAt: null,
      },
    }),
    prisma.smartMoneyLeaderboardRow.count({
      where: { activeCandidate: true, eligible: false },
    }),
    prisma.smartMoneyLeaderboardRow.count({
      where: {
        activeCandidate: true,
        eligible: true,
        sourceFetchedAt: { gte: freshSince },
        rank: null,
      },
    }),
    prisma.smartMoneyLeaderboardRow.count({
      where: {
        eligible: true,
        OR: [{ sourceFetchedAt: null }, { sourceFetchedAt: { lt: freshSince } }],
      },
    }),
    prisma.smartMoneyLeaderboardRow.findMany({
      where: { activeCandidate: true, eligible: false },
      select: { riskFlags: true },
      take: 5000,
    }),
    prisma.blockScanDiscoveredTrader.count({ where: { status: 'ACCUMULATING' } }),
    prisma.blockScanDiscoveredTrader.count({ where: { status: 'PROMOTED' } }),
    prisma.blockScanDiscoveredTrader.count({ where: { status: 'PROMOTED', promotedAt: { not: null } } }),
    prisma.blockScanDiscoveredTrader.count({ where: { status: 'SCORED' } }),
    prisma.observedTrader.count({
      where: {
        candidateOrigin: 'BLOCK_SCAN',
        candidateActive: true,
        lastFetchedAt: null,
      },
    }),
  ]);

  const ptSet = new Set(predictingTopWallets.map((r) => r.wallet.toLowerCase()));
  const paSet = new Set(analyticsWallets.map((r) => r.wallet.toLowerCase()));
  let overlap = 0;
  for (const w of ptSet) {
    if (paSet.has(w)) overlap += 1;
  }
  const unionEstimate = ptSet.size + paSet.size - overlap;

  const flagCounts: Record<string, number> = {};
  for (const row of ineligibleFlags) {
    for (const flag of row.riskFlags) {
      flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
    }
  }
  const topFlags = Object.entries(flagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  console.log('=== Smart Money 漏斗诊断 ===');
  console.log('time:', new Date().toISOString());
  console.log('scoreVersion:', CONFIG.smartMoneyScoreVersion);
  console.log('analyticsApiKey:', CONFIG.polymarketAnalyticsApiKey ? 'set' : 'MISSING');
  console.log('freshSince:', freshSince.toISOString(), `(${CONFIG.smartMoneyScoreFreshnessMs / 86400000}d)`);
  console.log('topLimit:', CONFIG.smartMoneyTopLimit);
  console.log('bootstrapTarget:', CONFIG.smartMoneyBootstrapTargetCount);
  console.log('');

  console.log('--- 1. 第三方榜缓存（已同步进库）---');
  for (const [key, count] of Object.entries(externalCounts).sort()) {
    console.log(`  ${key.padEnd(28)} ${count}`);
  }
  console.log(`  unique wallets (PT ALL):        ${ptSet.size}`);
  console.log(`  unique wallets (PA ALL):        ${paSet.size}`);
  console.log(`  overlap PT∩PA:                  ${overlap}`);
  console.log(`  union estimate:                 ${unionEstimate}`);
  console.log('');

  console.log('--- 2. 候选池 ObservedTrader ---');
  console.log(`  activeObserved:                 ${activeObserved}`);
  console.log(`  never fetched:                  ${activeNeverFetched}`);
  console.log(`  fetched at least once:          ${activeFetched}`);
  console.log(`  active but no leaderboard row:  ${activeWithoutRow}`);
  console.log('');

  console.log('--- 2b. 扫块发现 BlockScanDiscoveredTrader ---');
  console.log(`  accumulating:                   ${blockScanAccumulating}`);
  console.log(`  promoted (pending score):       ${blockScanQualified}`);
  console.log(`  promoted with promotedAt:       ${blockScanPromoted}`);
  console.log(`  scored:                         ${blockScanScored}`);
  console.log(`  pending first score:            ${blockScanPendingScore}`);
  console.log(`  observability pending:        ${observability.blockScanDiscoveryPendingCount}`);
  console.log('');

  console.log('--- 3. SmartMoneyLeaderboardRow 漏斗（对应 /cached API）---');
  const steps = [
    ['leaderboard rows (all)', leaderboardTotal],
    ['+ activeCandidate', withActiveCandidate],
    ['+ eligible', withEligible],
    ['+ fresh sourceFetchedAt', withFreshFetch],
    ['+ rank assigned', withRank],
    ['= API total (UI 显示, 粘性展示)', apiTotal],
  ] as const;
  const max = Math.max(unionEstimate, leaderboardTotal, 1);
  for (const [label, count] of steps) {
    console.log(bar(label, count, max));
  }
  console.log('');

  console.log('--- 4. 卡点拆解 ---');
  console.log(`  eligible but stale/missing fetch: ${staleEligible}`);
  console.log(`  active + ineligible:            ${activeIneligible}`);
  console.log(`  active+eligible+fresh but no rank: ${eligibleActiveNoRank}`);
  console.log(`  bootstrap remaining:            ${observability.bootstrapRemainingCount}`);
  console.log(`  displayableCount (rank only):   ${observability.displayableCount}`);
  console.log(`  cachedApiTotal (UI total):      ${observability.cachedApiTotal}`);
  console.log('');

  const categoryLabels = [
    'POLITICS',
    'SPORTS',
    'CRYPTO',
    'CULTURE',
    'MENTIONS',
    'WEATHER',
    'ECONOMICS',
    'TECH',
    'FINANCE',
  ] as const;
  const categoryCounts = await Promise.all(
    categoryLabels.map((category) =>
      prisma.smartMoneyLeaderboardRow.count({
        where: { ...apiWhere, candidateCategories: { has: category } },
      })
    )
  );
  console.log('--- 4b. 分类筛选可展示数（与 UI category 参数一致）---');
  for (const [index, category] of categoryLabels.entries()) {
    console.log(`  ${category.padEnd(12)} ${String(categoryCounts[index]).padStart(5)}`);
  }
  console.log('');

  if (topFlags.length > 0) {
    console.log('--- 5. active 候选里 ineligible 常见 flags ---');
    for (const [flag, count] of topFlags) {
      console.log(`  ${flag.padEnd(32)} ${count}`);
    }
    console.log('');
  }

  console.log('--- 6. 结论提示 ---');
  if (!CONFIG.polymarketAnalyticsApiKey) {
    console.log('  [!] POLYMARKET_ANALYTICS_API_KEY 未配置，只有 predicting.top 供数。');
  }
  if (apiTotal < 50 && activeNeverFetched > 50) {
    console.log(
      `  [根因] 候选池有 ${activeObserved} 人，但 ${activeNeverFetched} 人尚未抓取评分；页面只展示已完成 pipeline 的钱包。`
    );
    console.log('  [修复] npm run rescore:smart-money -- --scope=active --concurrency=4');
    console.log('         或 POST /api/polymarket/smart-money/admin/run-pipeline');
  } else if (apiTotal < 50 && withActiveCandidate < unionEstimate * 0.3) {
    console.log(
      '  [根因] 大量历史榜行 activeCandidate=false（去掉官方榜后旧地址被踢出候选池）。'
    );
    console.log('  [修复] 等对活跃候选 bootstrap 补抓，勿用 --scope=eligible 重算历史地址。');
  } else if (apiTotal < 50 && activeIneligible > withEligible) {
    console.log('  [根因] 多数活跃候选被 v2.2 eligible 规则挡掉，见上方 risk flags。');
  } else {
    console.log('  [状态] 漏斗基本正常，继续等待 cron bootstrap 或加大 active rescore 批次。');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
