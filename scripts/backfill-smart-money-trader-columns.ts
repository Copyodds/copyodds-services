/**
 * 从 scoreExplain.traderProfile（或弱重算）回填 CopyPool 的 traderScore/tier 列。
 * 不打上游 HTTP。用法（服务器）：
 *   node --env-file=.env dist/scripts/backfill-smart-money-trader-columns.js
 *   node --env-file=.env dist/scripts/backfill-smart-money-trader-columns.js --force-recompute
 */
import '../src/loadEnv';
import { Prisma } from '../src/generated/prisma/client';
import { prisma } from '../src/db';
import { assembleSmartMoneyTraderProfile, traderProfileToExplain } from '../src/services/smartMoney/smartMoneyTraderProfile';
import { computeDisplayScore } from '../src/services/smartMoney/smartMoneyDisplayScore';
import { recomputeSmartMoneyLeaderboardRanks } from '../src/services/smartMoney/smartMoneyLeaderboardWriter';

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const forceRecompute = process.argv.includes('--force-recompute');
  const dryRun = process.argv.includes('--dry-run');

  const before = await prisma.$queryRaw<
    Array<{
      in_pool: bigint;
      has_trader: bigint;
      has_tier: bigint;
      sa: bigint;
      explain_has_profile: bigint;
    }>
  >`
    SELECT
      count(*) FILTER (WHERE "inCopyPool") AS in_pool,
      count(*) FILTER (WHERE "inCopyPool" AND "traderScore" IS NOT NULL) AS has_trader,
      count(*) FILTER (WHERE "inCopyPool" AND tier IS NOT NULL) AS has_tier,
      count(*) FILTER (WHERE "inCopyPool" AND tier IN ('S','A')) AS sa,
      count(*) FILTER (
        WHERE "inCopyPool"
          AND ("scoreExplain"->'traderProfile') IS NOT NULL
      ) AS explain_has_profile
    FROM "SmartMoneyLeaderboardRow"
  `;
  console.log('[backfill-trader-columns] before', {
    inPool: Number(before[0]?.in_pool ?? 0),
    hasTrader: Number(before[0]?.has_trader ?? 0),
    hasTier: Number(before[0]?.has_tier ?? 0),
    sa: Number(before[0]?.sa ?? 0),
    explainHasProfile: Number(before[0]?.explain_has_profile ?? 0),
    forceRecompute,
    dryRun,
  });

  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: {
      inCopyPool: true,
      ...(forceRecompute
        ? {}
        : {
            OR: [{ traderScore: null }, { tier: null }],
          }),
    },
    select: {
      wallet: true,
      score: true,
      copyabilityScore: true,
      consistencyScore: true,
      maxDrawdownPercent: true,
      externalTotalReturn: true,
      externalWinRate: true,
      riskFlags: true,
      trades7d: true,
      activeDays: true,
      recentPnl7d: true,
      recentPnl30d: true,
      scoreExplain: true,
      traderScore: true,
      tier: true,
    },
  });

  let fromExplain = 0;
  let fromRecompute = 0;
  let skipped = 0;

  for (const row of rows) {
    const explain = asRecord(row.scoreExplain) ?? {};
    const profile = asRecord(explain.traderProfile);
    const display = asRecord(explain.displayProfile);
    const closed = asRecord(explain.closedPositions);

    let traderScore = finite(row.traderScore);
    let tier = row.tier;
    let edgeScore: number | null = null;
    let edgeSampleN: number | null = null;
    let traderType: string | null = null;
    let activeDays = row.activeDays;
    let maxWin: number | null = null;
    let maxLoss: number | null = null;
    let nextExplain = explain;

    const explainScore = finite(asRecord(profile?.traderScore)?.score);
    const explainTier =
      typeof profile?.tier === 'string' && profile.tier.trim() ? profile.tier.trim() : null;

    if (!forceRecompute && (explainScore != null || explainTier != null)) {
      traderScore = traderScore ?? explainScore;
      tier = tier ?? explainTier;
      edgeScore = finite(asRecord(profile?.edge)?.edgeScore);
      edgeSampleN = finite(asRecord(profile?.edge)?.edgeSampleN);
      traderType =
        typeof profile?.traderType === 'string' ? profile.traderType : null;
      activeDays = activeDays ?? finite(profile?.activeDays);
      maxWin = finite(profile?.maxWinTradeUsd);
      maxLoss = finite(profile?.maxLossTradeUsd);
      fromExplain += 1;
    } else {
      // 无 traderProfile 或缺列 / --force-recompute：用已有指标重算（不打上游）
      const edgeFromExplain = asRecord(profile?.edge);
      const edgeScorePreset = finite(edgeFromExplain?.edgeScore);
      const edgePreset =
        edgeScorePreset != null
          ? {
              edgeScore: edgeScorePreset,
              edgeBar: finite(edgeFromExplain?.edgeBar),
              edgeSampleN: Math.max(0, Math.round(finite(edgeFromExplain?.edgeSampleN) ?? 0)),
              positiveEdgeShare: finite(edgeFromExplain?.positiveEdgeShare),
              shrink: finite(edgeFromExplain?.shrink) ?? 1,
              markets: [],
              maxWinTradeUsd: finite(profile?.maxWinTradeUsd),
              maxLossTradeUsd: finite(profile?.maxLossTradeUsd),
            }
          : null;
      const pnlWindows = asRecord(display?.pnlWindowMetrics);
      const assembled = assembleSmartMoneyTraderProfile({
        closedRows: null,
        edgePreset,
        totalReturn:
          finite(pnlWindows && asRecord(pnlWindows.pnl1y)?.returnRatio) ??
          finite(display?.totalReturn1y) ??
          finite(row.externalTotalReturn),
        profitFactor: finite(display?.profitFactor),
        winRate:
          finite(closed?.marketWinRate) ??
          finite(display?.closedWinRate) ??
          finite(display?.winRate) ??
          finite(row.externalWinRate),
        closedWinRate: finite(display?.closedWinRate) ?? finite(closed?.marketWinRate),
        closedMarketCount:
          finite(closed?.decisiveMarkets) ?? finite(closed?.marketCount) ?? null,
        copyabilityScore:
          row.copyabilityScore != null ? Number(row.copyabilityScore) : null,
        activeDays: row.activeDays,
        maxDrawdownPercent:
          row.maxDrawdownPercent != null ? Number(row.maxDrawdownPercent) : null,
        consistencyScore: Number(row.consistencyScore),
        top1MarketPnlShare: finite(closed?.topMarketPnlShare),
        tradesPerDay1D: null,
        trades7d: row.trades7d,
        medianHoldingSec: null,
        riskFlags: row.riskFlags ?? [],
        totalVolumeUsd: finite(asRecord(explain.resolvedMetrics)?.totalVolume),
        pnl1yUsd:
          finite(asRecord(pnlWindows?.pnl1y)?.pnlUsd) ?? finite(display?.totalPnl1y),
        pnl30dUsd:
          finite(row.recentPnl30d) ??
          finite(display?.recentPnl30d) ??
          finite(asRecord(pnlWindows?.pnl30d)?.pnlUsd),
        pnl7dUsd:
          finite(row.recentPnl7d) ??
          finite(display?.recentPnl7d) ??
          finite(asRecord(pnlWindows?.pnl7d)?.pnlUsd),
        medianNotionalUsd: finite(display?.medianNotionalUsd),
        mddUnmeasurable: display?.mddUnmeasurable === true,
        maxDrawdownUsd: finite(display?.maxDrawdownUsd),
        totalPnlUsd:
          finite(asRecord(pnlWindows?.pnl1y)?.pnlUsd) ?? finite(display?.totalPnl1y),
        mdd7dPercent: finite(asRecord(pnlWindows?.pnl7d)?.maxDrawdownRatio),
        mdd30dPercent: finite(asRecord(pnlWindows?.pnl30d)?.maxDrawdownRatio),
        mddAllPercent:
          row.maxDrawdownPercent != null ? Number(row.maxDrawdownPercent) : null,
        drawdownRecovered: display?.drawdownRecovered === true,
      });
      traderScore = assembled.traderScore.traderScore;
      tier = assembled.tier.tier;
      edgeScore = assembled.edge.edgeScore;
      edgeSampleN = assembled.edge.edgeSampleN;
      traderType = assembled.traderType.traderType;
      activeDays = assembled.activeDays;
      maxWin = assembled.maxWinTradeUsd;
      maxLoss = assembled.maxLossTradeUsd;
      nextExplain = {
        ...explain,
        traderProfile: traderProfileToExplain(assembled),
      };
      fromRecompute += 1;
    }

    if (traderScore == null || tier == null) {
      skipped += 1;
      continue;
    }

    if (dryRun) continue;

    const displayScore = computeDisplayScore(
      row.copyabilityScore != null ? Number(row.copyabilityScore) : null,
      Number(row.score),
      traderScore
    );

    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet: row.wallet },
      data: {
        traderScore: new Prisma.Decimal(traderScore.toFixed(8)),
        tier,
        edgeScore: edgeScore != null ? new Prisma.Decimal(edgeScore.toFixed(8)) : undefined,
        edgeSampleN: edgeSampleN != null ? Math.round(edgeSampleN) : undefined,
        traderType: traderType ?? undefined,
        activeDays: activeDays ?? undefined,
        maxWinTradeUsd: maxWin != null ? new Prisma.Decimal(maxWin.toFixed(18)) : undefined,
        maxLossTradeUsd: maxLoss != null ? new Prisma.Decimal(maxLoss.toFixed(18)) : undefined,
        displayScore: new Prisma.Decimal(displayScore.toFixed(8)),
        scoreExplain: nextExplain as Prisma.InputJsonValue,
      },
    });
  }

  console.log('[backfill-trader-columns] wrote', {
    candidates: rows.length,
    fromExplain,
    fromRecompute,
    skipped,
    dryRun,
  });

  if (!dryRun) {
    const ranks = await recomputeSmartMoneyLeaderboardRanks();
    console.log('[backfill-trader-columns] ranks', {
      topCount: ranks.topCount,
      cachedApiTotal: ranks.observability.cachedApiTotal,
    });
  }

  const after = await prisma.$queryRaw<
    Array<{ has_trader: bigint; has_tier: bigint; sa: bigint }>
  >`
    SELECT
      count(*) FILTER (WHERE "inCopyPool" AND "traderScore" IS NOT NULL) AS has_trader,
      count(*) FILTER (WHERE "inCopyPool" AND tier IS NOT NULL) AS has_tier,
      count(*) FILTER (WHERE "inCopyPool" AND tier IN ('S','A')) AS sa
    FROM "SmartMoneyLeaderboardRow"
  `;
  console.log('[backfill-trader-columns] after', {
    hasTrader: Number(after[0]?.has_trader ?? 0),
    hasTier: Number(after[0]?.has_tier ?? 0),
    sa: Number(after[0]?.sa ?? 0),
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
