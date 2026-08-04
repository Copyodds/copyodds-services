/**
 * 用已写回的 externalSharpeRatio 更新 scoreExplain.v40.factors.S_sharpe，
 * 再同版本 fast 重算 v4 score（不拉上游）。
 *
 * Usage:
 *   npx tsx scripts/rescore-smart-money-score-from-sharpe.ts
 *   npx tsx scripts/rescore-smart-money-score-from-sharpe.ts --dry-run
 */
import { Prisma } from '../src/generated/prisma/client';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';
import { rescoreSmartMoneyLeaderboardScoresFromCache } from '../src/services/smartMoney/smartMoneyScoreCacheRescore';
import { recomputeSmartMoneyLeaderboardRanks } from '../src/services/smartMoney/smartMoneyLeaderboardWriter';
import { clearSmartMoneyReadCaches } from '../src/services/smartMoney/smartMoneyScoreCache';
import { computeDisplayScore } from '../src/services/smartMoney/smartMoneyDisplayScore';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 与 smartMoneyScoreV40.lin 一致：S_sharpe = lin(sharpe, -0.5, 2.5, 40) */
function sharpeFactor(sharpe: number | null): number {
  if (sharpe == null || !Number.isFinite(sharpe)) return 40;
  return roundScore(clamp(((sharpe - -0.5) / Math.max(2.5 - -0.5, 1e-9)) * 100, 0, 100));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const startedAt = Date.now();

  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    select: {
      wallet: true,
      score: true,
      traderScore: true,
      copyabilityScore: true,
      displayScore: true,
      externalSharpeRatio: true,
      scoreExplain: true,
      scoreVersion: true,
    },
    orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }],
  });

  console.log('[rescore-from-sharpe] plan', {
    walletCount: rows.length,
    scoreVersion: CONFIG.smartMoneyScoreVersion,
    dryRun,
  });

  let patched = 0;
  let unchanged = 0;
  let skippedNoExplain = 0;
  const samples: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const explain = asRecord(row.scoreExplain);
    if (explain == null) {
      skippedNoExplain += 1;
      continue;
    }
    const v40 = asRecord(explain.v40) ?? {};
    const factors = asRecord(v40.factors) ?? {};
    const sharpe = finite(row.externalSharpeRatio);
    const nextS = sharpeFactor(sharpe);
    const prevS = finite(factors.S_sharpe);

    if (prevS != null && Math.abs(prevS - nextS) < 1e-9) {
      unchanged += 1;
      continue;
    }

    if (samples.length < 15) {
      samples.push({
        wallet: row.wallet,
        sharpe,
        S_sharpe_before: prevS,
        S_sharpe_after: nextS,
        score_before: finite(row.score),
      });
    }

    if (dryRun) {
      patched += 1;
      continue;
    }

    const nextExplain: Record<string, unknown> = {
      ...explain,
      version: CONFIG.smartMoneyScoreVersion,
      v40: {
        ...v40,
        factors: {
          ...factors,
          S_sharpe: nextS,
        },
      },
    };

    // 同步 explain 内展示字段（若存在）
    const resolved = asRecord(explain.resolvedMetrics);
    if (resolved != null) {
      nextExplain.resolvedMetrics = {
        ...resolved,
        sharpeRatio: sharpe,
        externalSharpeRatio: sharpe,
      };
    }
    const display = asRecord(explain.displayProfile);
    if (display != null) {
      nextExplain.displayProfile = {
        ...display,
        sharpeRatio: sharpe,
        externalSharpeRatio: sharpe,
      };
    }

    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet: row.wallet },
      data: {
        scoreExplain: nextExplain as Prisma.InputJsonValue,
        scoreVersion: CONFIG.smartMoneyScoreVersion,
      },
    });

    // ScoreCache 同步 explain，避免详情读到旧 S_sharpe
    await prisma.smartMoneyScoreCache
      .updateMany({
        where: { wallet: row.wallet },
        data: {
          scoreExplain: nextExplain as Prisma.InputJsonValue,
          scoreVersion: CONFIG.smartMoneyScoreVersion,
          updatedAt: new Date(),
        },
      })
      .catch(() => undefined);

    patched += 1;
  }

  console.log('[rescore-from-sharpe] patch samples', samples);
  console.log('[rescore-from-sharpe] patch done', {
    patched,
    unchanged,
    skippedNoExplain,
    dryRun,
  });

  if (dryRun) {
    console.log('[rescore-from-sharpe] dry-run exit');
    return;
  }

  const stats = await rescoreSmartMoneyLeaderboardScoresFromCache({
    where: { inCopyPool: true },
  });
  console.log('[rescore-from-sharpe] cache rescore', stats);

  // displayScore 随 traderScore 主分；顺带刷新（若配置切换）
  const pool = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    select: {
      wallet: true,
      score: true,
      traderScore: true,
      copyabilityScore: true,
      displayScore: true,
    },
  });
  let displayUpdated = 0;
  for (const row of pool) {
    const next = computeDisplayScore(
      finite(row.copyabilityScore),
      Number(row.score),
      finite(row.traderScore)
    );
    if (finite(row.displayScore) != null && Math.abs(Number(row.displayScore) - next) < 1e-9) {
      continue;
    }
    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet: row.wallet },
      data: { displayScore: new Prisma.Decimal(next.toFixed(8)) },
    });
    displayUpdated += 1;
  }
  console.log('[rescore-from-sharpe] displayScore updated', displayUpdated);

  const ranks = await recomputeSmartMoneyLeaderboardRanks();
  await clearSmartMoneyReadCaches();

  console.log('[rescore-from-sharpe] finished', {
    patched,
    scoreUpdated: stats.updated,
    purgedBelowExit: stats.purgedBelowExit,
    topCount: ranks.topCount,
    rankedCount: ranks.observability.rankedCount,
    elapsedMs: Date.now() - startedAt,
  });
}

main()
  .catch((error) => {
    console.error('[rescore-from-sharpe] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
