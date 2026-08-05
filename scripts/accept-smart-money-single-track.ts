/**
 * 本地无库验收脚本（静态 DoD + 可选远程 HTTP）。
 *
 * Usage:
 *   npx tsx scripts/accept-smart-money-single-track.ts
 *   SMOKE_BASE_URL=https://your-api.example.com npx tsx scripts/accept-smart-money-single-track.ts --http
 *   COPY_INTERNAL_SECRET=... SMOKE_BASE_URL=... npx tsx scripts/accept-smart-money-single-track.ts --http
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`[accept] ${ok ? 'OK' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function assertFileContains(rel: string, needle: string, name: string): void {
  const path = join(process.cwd(), rel);
  if (!existsSync(path)) {
    record(name, false, `missing file ${rel}`);
    return;
  }
  const text = readFileSync(path, 'utf8');
  record(name, text.includes(needle), `file=${rel}`);
}

function assertFileNotContains(rel: string, needle: string, name: string): void {
  const path = join(process.cwd(), rel);
  if (!existsSync(path)) {
    record(name, false, `missing file ${rel}`);
    return;
  }
  const text = readFileSync(path, 'utf8');
  record(name, !text.includes(needle), `file=${rel}`);
}

function runStaticChecks(): void {
  record('cwd looks like polymarket-backend', existsSync(join(process.cwd(), 'src/services/smartMoney')));

  assertFileContains(
    'src/services/smartMoney/smartMoneyCachedQuery.ts',
    'inCopyPool: true',
    'cached where uses inCopyPool'
  );
  assertFileNotContains(
    'src/services/smartMoney/smartMoneyCachedQuery.ts',
    'legacy_active_eligible',
    'no legacy_active_eligible in cached query'
  );
  assertFileNotContains(
    'src/config/env.ts',
    'smartMoneyPipelineEnabled',
    'PIPELINE_ENABLED removed from env'
  );
  assertFileNotContains(
    'src/jobs/registerServerCrons.ts',
    'runSmartMoneyFetchBatch',
    'cron does not call crawl fetch batch'
  );
  assertFileContains(
    'src/jobs/registerServerCrons.ts',
    'runSmartMoneyPipelineLightBatch',
    'cron schedules light batch'
  );
  assertFileContains(
    'src/jobs/registerServerCrons.ts',
    'runSmartMoneyPipelineDeepBatch',
    'cron schedules deep batch'
  );
  assertFileContains(
    'src/services/smartMoney/smartMoneyCopyPool.ts',
    'smartMoneyCopyPoolEnterScore',
    'CopyPool enter uses enter score config'
  );
  assertFileNotContains(
    'src/services/smartMoney/smartMoneyCopyPool.ts',
    'scoreResult.eligible',
    'CopyPool enter does not use eligible'
  );
  assertFileContains(
    'src/services/smartMoney/smartMoneyFetchScheduler.ts',
    'pickCopyPoolStaleRefresh',
    'deep batch reserves CopyPool refresh'
  );
  assertFileContains(
    'src/services/smartMoney/smartMoneyCopyPoolRescoreChannels.ts',
    'pickCopyPoolRescoreSlots',
    'dual_channel rescore slots module'
  );
  assertFileContains(
    'src/services/smartMoney/smartMoneyClosedIncremental.ts',
    'refreshClosedGateIncremental',
    'closed incremental refresh'
  );
  assertFileContains(
    'src/jobs/registerServerCrons.ts',
    'smart-money-copy-pool-sla-cron',
    'cron schedules TopN SLA check'
  );
  assertFileContains(
    'src/config/env.ts',
    "SMART_MONEY_CLOSED_GATE_MAX_PAGES ?? 30",
    'Gate max pages default 30'
  );
  assertFileContains(
    'src/services/smartMoney/smartMoneyApproxRank.ts',
    'assignApproximateRankIfMissing',
    'approx rank on enter'
  );
  record(
    'reset script exists',
    existsSync(join(process.cwd(), 'scripts/reset-smart-money-leaderboard-pipeline.ts'))
  );
  record(
    'profile crawler deleted',
    !existsSync(join(process.cwd(), 'src/services/smartMoney/smartMoneyProfileCrawler.ts'))
  );
  record(
    'seed-to-copy-pool backfill deleted',
    !existsSync(join(process.cwd(), 'scripts/backfill-smart-money-pipeline.ts'))
  );
}

async function fetchJson(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
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
  const base = (process.env.SMOKE_BASE_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    throw new Error('请设置 SMOKE_BASE_URL（例如 https://your-api.example.com）');
  }
  const apiKey = process.env.API_KEY ?? process.env.SMOKE_API_KEY ?? '';
  const secret = process.env.COPY_INTERNAL_SECRET ?? '';

  const health = await fetchJson(`${base}/api/health`);
  record(
    'remote /api/health',
    health.status === 200 && (health.body as any)?.code === 0,
    `status=${health.status}`
  );

  const cachedUrl = new URL(`${base}/api/polymarket/smart-money/cached`);
  cachedUrl.searchParams.set('limit', '20');
  cachedUrl.searchParams.set('includeCopyability', 'true');
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;

  const cached = await fetchJson(cachedUrl.toString(), headers);
  const data = (cached.body as any)?.data;
  record(
    'remote /smart-money/cached',
    cached.status === 200 && (cached.body as any)?.code === 0,
    `status=${cached.status} total=${data?.total ?? '?'}`
  );

  if (data?.items?.length) {
    const allInPool = data.items.every((row: any) => row.inCopyPool === true);
    record('cached items all inCopyPool', allInPool, `n=${data.items.length}`);

    const scores = data.items
      .map((row: any) => (row.displayScore != null ? Number(row.displayScore) : null))
      .filter((n: number | null): n is number => n != null && Number.isFinite(n));
    let mono = true;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i]! > scores[i - 1]!) {
        mono = false;
        break;
      }
    }
    record(
      'TopN displayScore non-increasing (when present)',
      scores.length === 0 || mono,
      `withDisplay=${scores.length}`
    );
    record(
      'response omits dual displayMode (or fixed)',
      data.displayMode == null || data.displayMode === 'copy_pool',
      `displayMode=${data.displayMode ?? 'absent'}`
    );
  } else {
    record('cached items present', false, 'empty — may be cleared or not deployed');
  }

  if (!secret) {
    record('pipeline/stats skipped', true, 'set COPY_INTERNAL_SECRET to check');
    return;
  }
  const stats = await fetchJson(`${base}/api/internal/smart-money/pipeline/stats`, {
    'x-internal-secret': secret,
  });
  const sdata = (stats.body as any)?.data;
  record(
    'remote pipeline/stats',
    stats.status === 200 && (stats.body as any)?.code === 0,
    `status=${stats.status}`
  );
  if (sdata) {
    record('stats has stages', sdata.stages != null, JSON.stringify(sdata.stages ?? {}));
    record('stats has copyPoolApiTotal', 'copyPoolApiTotal' in sdata, String(sdata.copyPoolApiTotal));
    record(
      'stats has scoreCacheTotal (new code)',
      'scoreCacheTotal' in sdata,
      String(sdata.scoreCacheTotal)
    );
  }
}

async function main(): Promise<void> {
  const http = process.argv.includes('--http');
  console.log('[accept] smart-money single-track acceptance', {
    mode: http ? 'static+http' : 'static',
    note: 'no local DATABASE_URL required for static mode',
  });
  runStaticChecks();
  if (http) {
    await runHttpChecks();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`[accept] summary ok=${checks.length - failed.length} fail=${failed.length}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[accept] fatal', error);
  process.exitCode = 1;
});
