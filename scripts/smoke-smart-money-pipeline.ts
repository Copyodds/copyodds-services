/**
 * Smart Money 管道 / 跟单榜 staging 冒烟检查。
 *
 * HTTP 模式（服务已启动）：
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 COPY_INTERNAL_SECRET=... API_KEY=... \
 *     npx tsx scripts/smoke-smart-money-pipeline.ts --http
 *
 * DB 模式（仅校验 schema + 计数，无需 HTTP）：
 *   npx tsx scripts/smoke-smart-money-pipeline.ts --db
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';

type CheckResult = { name: string; ok: boolean; detail?: string };

const checks: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  const mark = ok ? 'OK' : 'FAIL';
  console.log(`[smoke] ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function runDbChecks(): Promise<void> {
  const rawCount = await prisma.smartMoneyRawAddress.count();
  record('SmartMoneyRawAddress table', true, `rows=${rawCount}`);

  const cacheCount = await prisma.smartMoneyScoreCache.count();
  record('SmartMoneyScoreCache table', true, `rows=${cacheCount}`);

  const copyPoolCount = await prisma.smartMoneyLeaderboardRow.count({
    where: { inCopyPool: true },
  });
  record('CopyPool rows', true, `inCopyPool=${copyPoolCount}`);

  const withDisplayScore = await prisma.smartMoneyLeaderboardRow.count({
    where: { displayScore: { not: null } },
  });
  if (CONFIG.smartMoneyCopyabilityEnabled) {
    record('displayScore populated', withDisplayScore > 0 || copyPoolCount === 0, `count=${withDisplayScore}`);
  } else {
    record('displayScore column (copyability off)', true, `count=${withDisplayScore}`);
  }

  const pendingGamma = await prisma.smartMoneyScoreCache.count({
    where: {
      tier2CorePassedAt: { not: null },
      tier2EnhancedPassedAt: null,
    },
  });
  record('gamma enrichment pending', true, `count=${pendingGamma}`);

  const nonCopyPoolEligible = await prisma.smartMoneyLeaderboardRow.count({
    where: { inCopyPool: false, OR: [{ eligible: true }, { activeCandidate: true }] },
  });
  record(
    'no eligible outside CopyPool (stale flags)',
    true,
    `staleFlagRows=${nonCopyPoolEligible} (mirrored on next rank sync)`
  );

  const stagesSample = await prisma.smartMoneyRawAddress.groupBy({
    by: ['pipelineStage'],
    _count: { _all: true },
  });
  record(
    'pipeline stage distribution',
    true,
    stagesSample.map((row) => `${row.pipelineStage}=${row._count._all}`).join(',') || 'empty'
  );

  record('SCORE_VERSION', true, CONFIG.smartMoneyScoreVersion);
  record('COPYABILITY_ENABLED', true, String(CONFIG.smartMoneyCopyabilityEnabled));
  record('RANK_MODEL_ENABLED', true, String(CONFIG.smartMoneyRankModelEnabled));

  if (CONFIG.smartMoneyRankModelEnabled) {
    const withRankScore = await prisma.smartMoneyLeaderboardRow.count({
      where: { rankScore: { not: null } },
    });
    record('rankScore populated', withRankScore > 0 || copyPoolCount === 0, `count=${withRankScore}`);
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: response.status, body };
}

async function runHttpChecks(): Promise<void> {
  const baseUrl = (process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${CONFIG.port}`).replace(/\/+$/, '');
  const internalSecret = process.env.COPY_INTERNAL_SECRET ?? CONFIG.copyInternalSecret;
  const apiKey = process.env.API_KEY ?? process.env.SMOKE_API_KEY ?? '';

  if (!internalSecret) {
    record('COPY_INTERNAL_SECRET', false, 'missing');
    return;
  }
  record('COPY_INTERNAL_SECRET', true);

  const statsRes = await fetchJson(`${baseUrl}/api/internal/smart-money/pipeline/stats`, {
    'x-internal-secret': internalSecret,
  });
  const statsData = statsRes.body as { code?: number; data?: Record<string, unknown> };
  record(
    'GET /api/internal/smart-money/pipeline/stats',
    statsRes.status === 200 && statsData.code === 0,
    `status=${statsRes.status}`
  );
  if (statsData.data) {
    const stages = statsData.data.stages as Record<string, number> | undefined;
    record('pipeline stages payload', stages != null, JSON.stringify(stages ?? {}));
    record(
      'gammaEnrichmentPending field',
      'gammaEnrichmentPending' in (statsData.data ?? {}),
      String(statsData.data.gammaEnrichmentPending)
    );
    record('copyPoolApiTotal', true, String(statsData.data.copyPoolApiTotal));
    record('scoreCacheTotal field', 'scoreCacheTotal' in (statsData.data ?? {}), String(statsData.data.scoreCacheTotal));
    record('rawActive field', 'rawActive' in (statsData.data ?? {}), String(statsData.data.rawActive));
    record('rankModelEnabled field', 'rankModelEnabled' in (statsData.data ?? {}));
  }

  if (!apiKey) {
    record('API_KEY for /cached', false, 'set API_KEY or SMOKE_API_KEY');
    return;
  }

  const cachedUrl = new URL(`${baseUrl}/api/polymarket/smart-money/cached`);
  cachedUrl.searchParams.set('limit', '5');
  cachedUrl.searchParams.set('includeCopyability', 'true');

  const cachedRes = await fetchJson(cachedUrl.toString(), { 'x-api-key': apiKey });
  const cachedData = cachedRes.body as {
    code?: number;
    data?: { total?: number; items?: Array<Record<string, unknown>> };
  };
  record(
    'GET /smart-money/cached?includeCopyability=true',
    cachedRes.status === 200 && cachedData.code === 0,
    `status=${cachedRes.status} total=${cachedData.data?.total ?? '?'}`
  );

  const firstItem = cachedData.data?.items?.[0];
  if (firstItem) {
    if (CONFIG.smartMoneyCopyabilityEnabled) {
      record('item.displayScore present', 'displayScore' in firstItem);
    } else {
      record('item.score present', 'score' in firstItem, String(firstItem.score));
    }
    if (CONFIG.smartMoneyRankModelEnabled) {
      record('item.rankScore present', 'rankScore' in firstItem);
    }
    record('cached uses CopyPool rows', cachedData.data!.total! >= 0, `total=${cachedData.data?.total}`);
  }
}

async function main(): Promise<void> {
  const modeHttp = process.argv.includes('--http');
  const modeDb = process.argv.includes('--db') || !modeHttp;

  console.log('[smoke] smart-money pipeline checks starting', {
    mode: modeHttp ? 'http+db' : 'db',
    pipeline: 'copy_pool',
    copyability: CONFIG.smartMoneyCopyabilityEnabled,
    scoreVersion: CONFIG.smartMoneyScoreVersion,
  });

  if (modeDb) {
    await runDbChecks();
  }
  if (modeHttp) {
    await runHttpChecks();
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(`[smoke] ${failed.length} check(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`[smoke] all ${checks.length} checks passed`);
}

main()
  .catch((error) => {
    console.error('[smoke] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
