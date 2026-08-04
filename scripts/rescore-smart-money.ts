/**
 * 聪明钱重评分：支持 scope、--fast（仅本地重算）、--strict（关闭粘性，不达标下榜）。
 *
 * Usage:
 *   npm run rescore:smart-money:strict           # 重爬 Top2000 + 强制下榜不合格（推荐清榜）
 *   npm run rescore:smart-money:top              # 重爬 + 重评（保留粘性）
 *   npm run rescore:smart-money -- --scope=top --strict --dry-run
 *
 * --strict:
 *   1) 先按现有 riskFlags 清掉不合格（eligible=false, rank=null）
 *   2) 重爬时关闭粘性，评分不合格直接下榜
 *   3) 结束后再 purge 一次 + recompute rank
 */
import '../src/loadEnv';
import type { Prisma } from '../src/generated/prisma/client';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';
import { runDeepAnalyzeForWallet } from '../src/services/smartMoney/smartMoneyDeepAnalyze';
import { ingestSmartMoneyRawAddresses } from '../src/services/smartMoney/smartMoneyRawIngest';
import {
  purgeIneligibleSmartMoneyLeaderboardRows,
  recomputeSmartMoneyLeaderboardRanks,
} from '../src/services/smartMoney/smartMoneyLeaderboardWriter';
import { smartMoneyCachedDisplayWhere } from '../src/services/smartMoney/smartMoneyLeaderboardSticky';
import { rescoreSmartMoneyLeaderboardScoresFromCache } from '../src/services/smartMoney/smartMoneyScoreCacheRescore';

type Scope = 'top' | 'display' | 'ranked' | 'eligible' | 'leaderboard' | 'active';

function parseArgs(): {
  scope: Scope;
  limit: number | null;
  concurrency: number;
  dryRun: boolean;
  fast: boolean;
  strict: boolean;
} {
  const args = process.argv.slice(2);
  let scope: Scope = 'display';
  let limit: number | null = null;
  let concurrency = CONFIG.smartMoneyFetchConcurrency;
  let concurrencyExplicit = false;
  let dryRun = false;
  let fast = false;
  let strict = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--fast') {
      fast = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg.startsWith('--scope=')) {
      const value = arg.slice('--scope='.length);
      if (
        value === 'top' ||
        value === 'display' ||
        value === 'ranked' ||
        value === 'eligible' ||
        value === 'leaderboard' ||
        value === 'active'
      ) {
        scope = value;
      } else {
        throw new Error(
          `Invalid --scope=${value}; use top | display | ranked | eligible | leaderboard | active`
        );
      }
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --limit=${arg.slice('--limit='.length)}`);
      }
      limit = Math.floor(parsed);
      continue;
    }
    if (arg.startsWith('--concurrency=')) {
      const parsed = Number(arg.slice('--concurrency='.length));
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --concurrency=${arg.slice('--concurrency='.length)}`);
      }
      concurrency = Math.floor(parsed);
      concurrencyExplicit = true;
      continue;
    }
  }

  // strict Deep 会并行写多条长事务；默认 12 易触发 Prisma "Unable to start a transaction"。
  if (strict && !fast && !concurrencyExplicit) {
    concurrency = Math.min(concurrency, 3);
  }

  return { scope, limit, concurrency, dryRun, fast, strict };
}

function resolveTake(scope: Scope, limit: number | null): number {
  if (limit != null) return limit;
  if (scope === 'top') return CONFIG.smartMoneyTopLimit;
  return Number.MAX_SAFE_INTEGER;
}

async function loadTopCompetingWallets(take: number, _strict: boolean): Promise<string[]> {
  void _strict;
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    select: { wallet: true },
    orderBy: [{ score: 'desc' }, { lastScoredAt: 'desc' }, { wallet: 'asc' }],
    take,
  });
  return rows.map((row) => row.wallet);
}

async function loadWallets(scope: Scope, take: number, strict: boolean): Promise<string[]> {
  if (scope === 'top') {
    return loadTopCompetingWallets(take, strict);
  }
  if (scope === 'active') {
    const rows = await prisma.smartMoneyRawAddress.findMany({
      where: { dormant: false, pipelineStage: { in: ['RAW', 'QUALIFIED', 'SCORED', 'COPY_POOL'] } },
      select: { wallet: true },
      orderBy: [{ lastSeenAt: 'desc' }],
      ...(take < Number.MAX_SAFE_INTEGER ? { take } : {}),
    });
    return rows.map((row) => row.wallet);
  }

  const where =
    scope === 'display'
      ? smartMoneyCachedDisplayWhere()
      : scope === 'ranked'
        ? { inCopyPool: true, rank: { not: null } }
        : scope === 'eligible'
          ? { inCopyPool: true }
          : { inCopyPool: true };

  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where,
    select: { wallet: true },
    orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { score: 'desc' }],
    ...(take < Number.MAX_SAFE_INTEGER ? { take } : {}),
  });
  return rows.map((row) => row.wallet);
}

async function buildCacheRescoreWalletFilter(
  scope: Scope,
  take: number,
  strict = false
): Promise<Prisma.SmartMoneyLeaderboardRowWhereInput> {
  if (scope === 'top') {
    const wallets = await loadTopCompetingWallets(take, strict);
    return wallets.length > 0 ? { wallet: { in: wallets } } : { wallet: '__none__' };
  }
  const where = buildCacheRescoreWhere(scope);
  return where ?? {};
}

function buildCacheRescoreWhere(scope: Scope): Prisma.SmartMoneyLeaderboardRowWhereInput | undefined {
  if (scope === 'display') return smartMoneyCachedDisplayWhere();
  if (scope === 'ranked') return { inCopyPool: true, rank: { not: null } };
  if (scope === 'eligible') return { inCopyPool: true };
  return { inCopyPool: true };
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const { scope, limit, concurrency, dryRun, fast, strict } = parseArgs();
  const startedAt = Date.now();
  const take = resolveTake(scope, limit);
  const stickyEligibility = !strict;
  void stickyEligibility;

  if (fast) {
    const where = await buildCacheRescoreWalletFilter(scope, take, strict);
    const planned = await prisma.smartMoneyLeaderboardRow.count({ where });
    console.log('[rescore-smart-money] fast plan', {
      scope,
      take: take < Number.MAX_SAFE_INTEGER ? take : null,
      scoreVersion: CONFIG.smartMoneyScoreVersion,
      rowCount: planned,
      dryRun,
      strict,
    });

    if (dryRun) {
      const preview = await prisma.smartMoneyLeaderboardRow.findMany({
        where,
        take: 20,
        select: { wallet: true, rank: true, score: true },
        orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { score: 'desc' }],
      });
      for (const row of preview) {
        console.log('  would rescore from cache', row);
      }
      if (planned > preview.length) {
        console.log(`  ... and ${planned - preview.length} more`);
      }
      return;
    }

    if (strict) {
      const purged = await purgeIneligibleSmartMoneyLeaderboardRows();
      console.log('[rescore-smart-money] pre-purge', purged);
    }
    const stats = await rescoreSmartMoneyLeaderboardScoresFromCache({ where });
    if (strict) {
      const purged = await purgeIneligibleSmartMoneyLeaderboardRows();
      console.log('[rescore-smart-money] post-purge', purged);
    }
    const rankStats = await recomputeSmartMoneyLeaderboardRanks();
    console.log('[rescore-smart-money] fast finished', {
      scope,
      updated: stats.updated,
      skipped: stats.skipped,
      topCount: rankStats.topCount,
      rankedCount: rankStats.observability.rankedCount,
      cachedApiTotal: rankStats.observability.cachedApiTotal,
      elapsed: formatDurationMs(Date.now() - startedAt),
    });
    return;
  }

  let wallets = await loadWallets(scope, take, strict);
  if (limit != null && scope !== 'top') {
    wallets = wallets.slice(0, limit);
  }

  console.log('[rescore-smart-money] plan', {
    scope,
    walletCount: wallets.length,
    concurrency,
    maxTradesPerDay: CONFIG.smartMoneyMaxTradesPerDay,
    dryRun,
    strict,
    mode: 'pipeline-deep',
    hint: strict
      ? 'strict: purge hard-flag rows, Deep analyze, purge again, recompute ranks'
      : scope === 'active'
        ? 'active scope reads RawAddress pipeline stages; prefer --scope=display/top for CopyPool'
        : scope === 'top'
          ? `Deep analyze up to ${take} CopyPool wallets, then recompute ranks`
          : undefined,
  });

  if (wallets.length === 0) {
    console.log('[rescore-smart-money] nothing to rescore');
    return;
  }

  if (dryRun) {
    for (const wallet of wallets.slice(0, 20)) {
      console.log('  would deep-analyze', wallet);
    }
    if (wallets.length > 20) {
      console.log(`  ... and ${wallets.length - 20} more`);
    }
    return;
  }

  if (strict) {
    const purged = await purgeIneligibleSmartMoneyLeaderboardRows();
    console.log('[rescore-smart-money] pre-purge', purged);
  }

  console.log('[rescore-smart-money] deep starting', {
    walletCount: wallets.length,
    concurrency,
    firstWallets: wallets.slice(0, 3),
  });

  let successCount = 0;
  let failureCount = 0;
  let scoreWrittenCount = 0;
  let highFrequencyCount = 0;

  for (let index = 0; index < wallets.length; index += concurrency) {
    const chunk = wallets.slice(index, index + concurrency);
    let results: Awaited<ReturnType<typeof runDeepAnalyzeForWallet>>[] = [];
    try {
      await ingestSmartMoneyRawAddresses(chunk.map((wallet) => ({ wallet, source: 'RESCORE_DEEP' })));
      results = await Promise.all(chunk.map((wallet) => runDeepAnalyzeForWallet(wallet)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[rescore-smart-money] chunk fatal (continuing)', {
        index,
        chunkSize: chunk.length,
        error: message,
      });
      results = chunk.map((wallet) => ({
        wallet,
        success: false,
        scored: false,
        inCopyPool: false,
        error: message,
      }));
    }

    for (const result of results) {
      if (result.success) {
        successCount += 1;
        if (result.scored) scoreWrittenCount += 1;
      } else {
        failureCount += 1;
        console.warn('[rescore-smart-money] deep failed', {
          wallet: result.wallet,
          error: result.error,
        });
      }
    }

    const processed = Math.min(index + chunk.length, wallets.length);
    console.log('[rescore-smart-money] progress', {
      processed,
      total: wallets.length,
      successCount,
      failureCount,
      scoreWrittenCount,
      chunkFailed: results.filter((r) => !r.success).length,
    });
  }

  if (strict) {
    const purged = await purgeIneligibleSmartMoneyLeaderboardRows();
    console.log('[rescore-smart-money] post-purge', purged);
  }

  if (successCount > 0 || strict) {
    const rankStats = await recomputeSmartMoneyLeaderboardRanks();
    highFrequencyCount = await prisma.smartMoneyLeaderboardRow.count({
      where: { riskFlags: { has: 'HIGH_TRADE_FREQUENCY' } },
    });
    console.log('[rescore-smart-money] ranks recomputed', {
      topCount: rankStats.topCount,
      clearedCount: rankStats.clearedCount,
      eligibleCount: rankStats.observability.eligibleCount,
      rankedCount: rankStats.observability.rankedCount,
      cachedApiTotal: rankStats.observability.cachedApiTotal,
      highFrequencyCount,
    });
  }

  console.log('[rescore-smart-money] finished', {
    scope,
    walletCount: wallets.length,
    successCount,
    failureCount,
    scoreWrittenCount,
    highFrequencyCount,
    strict,
    elapsed: formatDurationMs(Date.now() - startedAt),
  });
}

main()
  .catch((error) => {
    console.error('[rescore-smart-money] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });

process.on('unhandledRejection', (reason) => {
  console.error('[rescore-smart-money] unhandledRejection', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[rescore-smart-money] uncaughtException', error);
  process.exitCode = 1;
});
process.on('SIGTERM', () => {
  console.error('[rescore-smart-money] received SIGTERM');
});
process.on('SIGINT', () => {
  console.error('[rescore-smart-money] received SIGINT');
});
