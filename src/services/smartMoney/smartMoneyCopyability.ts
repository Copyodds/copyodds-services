import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  fetchDataApiTradesInWindow,
  normalizeTradeTimestampMs,
  type DataApiTrade,
} from '../polymarket/polymarketTrades';
import { computeDisplayScore } from './smartMoneyDisplayScore';
import {
  assembleSmartMoneyTraderProfile,
  traderProfileToExplain,
} from './smartMoneyTraderProfile';
import {
  buildDefaultCopyabilitySimOptions,
  simulateCopyabilityFromTrades,
  simulateCopyabilityMultiScenario,
  type CopyabilityExplain,
} from './smartMoneyCopyabilitySim';
import {
  buildCopyabilityCompositeExplain,
  closedReturnDistFromExplain,
  composeCopyabilityScore,
} from './smartMoneyCopyMedianScore';
import { isRankModelActive } from './smartMoneyRankModel';
import { refreshSmartMoneyRankScoreForWallet } from './smartMoneyRankRefresh';
import { stampSmartMoneyDisplayRevision } from './smartMoneyDisplayAuthority';
import {
  clearSmartMoneyReadCaches,
  syncSmartMoneyScoreCacheDisplayFromLeaderboard,
} from './smartMoneyScoreCache';
import type { ClosedMarketReturnDistribution } from './smartMoneyPositionStats';

export type {
  CopyabilityExplain,
  CopyabilityRoundTrip,
  CopyabilitySimOptions,
  CopyabilitySimResult,
} from './smartMoneyCopyabilitySim';

export {
  buildDefaultCopyabilitySimOptions,
  computeCopyabilityScore,
  effectiveCopySlippageBps,
  extractHedgedConditionIdsFromExposure,
  simulateCopyabilityFromTrades,
} from './smartMoneyCopyabilitySim';

export { computeDisplayScore } from './smartMoneyDisplayScore';

export async function refreshSmartMoneyCopyabilityForWallet(input: {
  wallet: string;
  smartMoneyScore: number;
  inCopyPool: boolean;
  hedgedConditionIds?: ReadonlySet<string>;
  signal?: AbortSignal;
  /** 调用方（如 Deep 评分）已抓取的成交窗口；提供时复用，不再对同窗发第二次请求 */
  tradesWindow?: { trades: DataApiTrade[]; windowEndMs: number };
  /** Deep 已算好的已平仓回报分布；优先于 scoreExplain 缓存 */
  closedMarketReturnDistribution?: ClosedMarketReturnDistribution | null;
}): Promise<{
  copyabilityScore: number | null;
  displayScore: number;
  explain: CopyabilityExplain | null;
}> {
  input.signal?.throwIfAborted();
  if (!CONFIG.smartMoneyCopyabilityEnabled) {
    const existingRow = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet: input.wallet },
      select: { traderScore: true },
    });
    const traderScore =
      existingRow?.traderScore != null ? Number(existingRow.traderScore) : null;
    const displayScore = computeDisplayScore(null, input.smartMoneyScore, traderScore);
    await prisma.smartMoneyLeaderboardRow.updateMany({
      where: { wallet: input.wallet },
      data: {
        displayScore: new Prisma.Decimal(displayScore.toFixed(8)),
      },
    });
    return { copyabilityScore: null, displayScore, explain: null };
  }

  const end = input.tradesWindow?.windowEndMs ?? Date.now();
  const start = end - CONFIG.smartMoneyCopyLookbackDays * 24 * 60 * 60 * 1000;
  let trades: DataApiTrade[] = [];
  if (input.tradesWindow != null) {
    trades = input.tradesWindow.trades.filter((trade) => {
      const tsMs = normalizeTradeTimestampMs(trade.timestamp);
      return tsMs != null && tsMs >= start;
    });
  } else {
    try {
      const fetched = await fetchDataApiTradesInWindow(input.wallet, start, end, {
        signal: input.signal,
      });
      trades = fetched.trades;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      trades = [];
    }
  }
  input.signal?.throwIfAborted();

  const multi = simulateCopyabilityMultiScenario(
    trades,
    { hedgedConditionIds: input.hedgedConditionIds },
    end
  );
  const sim = multi.scenarios.base.sim;
  input.signal?.throwIfAborted();
  const existing = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet: input.wallet },
    select: {
      riskFlags: true,
      scoreExplain: true,
      maxDrawdownPercent: true,
      consistencyScore: true,
      trades7d: true,
      activeDays: true,
      recentPnl7d: true,
      recentPnl30d: true,
    },
  });
  input.signal?.throwIfAborted();

  const priorExplain =
    existing?.scoreExplain && typeof existing.scoreExplain === 'object'
      ? (existing.scoreExplain as Record<string, unknown>)
      : {};
  const closedDist =
    input.closedMarketReturnDistribution ?? closedReturnDistFromExplain(priorExplain);
  const composed = composeCopyabilityScore({
    rtScore: multi.copyabilityScore,
    roundTripCount: sim.roundTripCount,
    closedDist,
  });
  const primaryCopyScore = composed.copyabilityScore;
  const displayProfile =
    priorExplain.displayProfile && typeof priorExplain.displayProfile === 'object'
      ? (priorExplain.displayProfile as Record<string, unknown>)
      : {};
  const closedPositions =
    priorExplain.closedPositions && typeof priorExplain.closedPositions === 'object'
      ? (priorExplain.closedPositions as Record<string, unknown>)
      : {};
  const traderPrior =
    priorExplain.traderProfile && typeof priorExplain.traderProfile === 'object'
      ? (priorExplain.traderProfile as Record<string, unknown>)
      : {};
  const edgePrior =
    traderPrior.edge && typeof traderPrior.edge === 'object'
      ? (traderPrior.edge as Record<string, unknown>)
      : {};

  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /** 三窗必须从 Deep 已写入的 display/榜列带回，否则会缺数绕过 S/A 盈亏封顶 */
  const pnlWindowMetrics =
    displayProfile.pnlWindowMetrics && typeof displayProfile.pnlWindowMetrics === 'object'
      ? (displayProfile.pnlWindowMetrics as {
          pnl1y?: { pnlUsd?: unknown };
          pnl30d?: { pnlUsd?: unknown };
          pnl7d?: { pnlUsd?: unknown };
        })
      : {};
  const pnl1yUsd = num(pnlWindowMetrics.pnl1y?.pnlUsd);
  const pnl30dUsd =
    num(pnlWindowMetrics.pnl30d?.pnlUsd) ??
    num(existing?.recentPnl30d) ??
    num(displayProfile.recentPnl30d);
  const pnl7dUsd =
    num(pnlWindowMetrics.pnl7d?.pnlUsd) ??
    num(existing?.recentPnl7d) ??
    num(displayProfile.recentPnl7d);

  const edgePreset =
    num(edgePrior.edgeScore) != null
      ? {
          edgeScore: num(edgePrior.edgeScore)!,
          edgeBar: num(edgePrior.edgeBar),
          edgeSampleN: Math.round(num(edgePrior.edgeSampleN) ?? 0),
          positiveEdgeShare: num(edgePrior.positiveEdgeShare),
          shrink: num(edgePrior.shrink) ?? 0,
          markets: [],
          maxWinTradeUsd: num(traderPrior.maxWinTradeUsd),
          maxLossTradeUsd: num(traderPrior.maxLossTradeUsd),
        }
      : null;

  const refreshedProfile = assembleSmartMoneyTraderProfile({
    closedRows: [],
    edgePreset,
    totalReturn:
      num(
        (displayProfile.pnlWindowMetrics as { pnl1y?: { returnRatio?: unknown } } | undefined)?.pnl1y
          ?.returnRatio
      ) ?? num(displayProfile.totalReturn1y),
    profitFactor: num(displayProfile.profitFactor),
    winRate:
      num(displayProfile.closedWinRate) ??
      num(closedPositions.marketWinRate),
    closedWinRate: num(displayProfile.closedWinRate) ?? num(closedPositions.marketWinRate),
    closedMarketCount:
      num(closedPositions.decisiveMarkets) ??
      num(closedPositions.marketCount) ??
      edgePreset?.edgeSampleN ??
      null,
    copyabilityScore: primaryCopyScore,
    activeDays: existing?.activeDays ?? num(traderPrior.activeDays),
    maxDrawdownPercent:
      existing?.maxDrawdownPercent != null
        ? Number(existing.maxDrawdownPercent)
        : num(
            (displayProfile.pnlWindowMetrics as { pnl1y?: { maxDrawdownRatio?: unknown } } | undefined)
              ?.pnl1y?.maxDrawdownRatio
          ) ?? num(displayProfile.maxDrawdownPercent),
    consistencyScore:
      existing?.consistencyScore != null ? Number(existing.consistencyScore) : null,
    top1MarketPnlShare: num(closedPositions.topMarketPnlShare),
    tradesPerDay1D: null,
    trades7d: existing?.trades7d ?? null,
    medianHoldingSec: sim.medianHoldingSec,
    riskFlags: existing?.riskFlags ?? [],
    totalVolumeUsd: num(
      (priorExplain.rawMetrics as { totalVolume?: unknown } | undefined)?.totalVolume
    ),
    pnl1yUsd,
    pnl30dUsd,
    pnl7dUsd,
    medianNotionalUsd: num(displayProfile.medianNotionalUsd),
    mddUnmeasurable: displayProfile.mddUnmeasurable === true,
    drawdownRecovered: displayProfile.drawdownRecovered === true,
    maxDrawdownUsd: num(displayProfile.maxDrawdownUsd),
    totalPnlUsd: pnl1yUsd,
    mdd7dPercent: num(
      (displayProfile.pnlWindowMetrics as { pnl7d?: { maxDrawdownRatio?: unknown } } | undefined)
        ?.pnl7d?.maxDrawdownRatio
    ),
    mdd30dPercent: num(
      (displayProfile.pnlWindowMetrics as { pnl30d?: { maxDrawdownRatio?: unknown } } | undefined)
        ?.pnl30d?.maxDrawdownRatio
    ),
    mddAllPercent:
      existing?.maxDrawdownPercent != null
        ? Number(existing.maxDrawdownPercent)
        : num(displayProfile.maxDrawdownPercent),
  });

  const baseOptions = buildDefaultCopyabilitySimOptions({
    hedgedConditionIds: input.hedgedConditionIds,
  });
  const displayScore = computeDisplayScore(
    primaryCopyScore,
    input.smartMoneyScore,
    refreshedProfile.traderScore.traderScore
  );
  const explain: CopyabilityExplain = {
    version: 'v1',
    options: baseOptions,
    metrics: {
      tradeCount: sim.tradeCount,
      replicableTradeCount: sim.replicableTradeCount,
      roundTripCount: sim.roundTripCount,
      replicableTradeShare: sim.replicableTradeShare,
      simulatedRoi: sim.simulatedRoi,
      simulatedWinRate: sim.simulatedWinRate,
      simulatedMaxDrawdown: sim.simulatedMaxDrawdown,
      backtestPnlUsd: sim.backtestPnlUsd,
      copyLossRate: sim.copyLossRate,
      medianHoldingSec: sim.medianHoldingSec,
      avgHoldingSec: sim.avgHoldingSec,
      lastTradeAtMs: sim.lastTradeAtMs,
      sampleWindowDays: sim.sampleWindowDays,
      sampleTradeCount: sim.sampleTradeCount,
      slippageBpsEffective: sim.slippageBpsEffective,
      copyabilityScore: primaryCopyScore,
    },
    lowReplicableShare:
      sim.replicableTradeShare != null &&
      sim.replicableTradeShare < CONFIG.smartMoneyCopyMinReplicableShare,
  };

  const now = new Date();
  const riskFlags = [...(existing?.riskFlags ?? [])];
  const lowReplFlag = 'LOW_REPLICABLE_TRADE_SHARE';
  const flagIndex = riskFlags.indexOf(lowReplFlag);
  if (explain.lowReplicableShare) {
    if (flagIndex < 0) riskFlags.push(lowReplFlag);
  } else if (flagIndex >= 0) {
    riskFlags.splice(flagIndex, 1);
  }

  const lowCopyFlag = 'LOW_COPYABILITY';
  const lowCopyIndex = riskFlags.indexOf(lowCopyFlag);
  const belowCopyabilityFloor =
    Number.isFinite(primaryCopyScore) &&
    primaryCopyScore < CONFIG.smartMoneyCopyPoolMinComposite;
  if (belowCopyabilityFloor || explain.lowReplicableShare) {
    if (lowCopyIndex < 0) riskFlags.push(lowCopyFlag);
  } else if (lowCopyIndex >= 0) {
    riskFlags.splice(lowCopyIndex, 1);
  }

  const traderExplain = traderProfileToExplain(refreshedProfile);
  const compositeExplain = buildCopyabilityCompositeExplain(composed);

  const mergedExplain = stampSmartMoneyDisplayRevision(
    {
      ...priorExplain,
      copyability: {
        ...explain,
        ...compositeExplain,
        multiScenario: {
          score: multi.copyabilityScore,
          weights: multi.weights,
          tight: multi.scenarios.tight.score,
          base: multi.scenarios.base.score,
          stress: multi.scenarios.stress.score,
        },
        options: {
          copyNotionalUsd: baseOptions.copyNotionalUsd,
          copyDelaySec: baseOptions.copyDelaySec,
          slippageBps: baseOptions.slippageBps,
          lookbackDays: baseOptions.lookbackDays,
          excludeHedged: baseOptions.excludeHedged,
          minMarketVolumeUsd: baseOptions.minMarketVolumeUsd,
          hedgedConditionCount: baseOptions.hedgedConditionIds?.size ?? 0,
          lowLiquidityConditionCount: baseOptions.lowLiquidityConditionIds?.size ?? 0,
        },
      },
      displayProfile: {
        ...displayProfile,
        backtestPnlUsd: sim.backtestPnlUsd,
        copyLossRate: sim.copyLossRate,
        medianHoldingSec: sim.medianHoldingSec,
        avgHoldingSec: sim.avgHoldingSec,
        lastTradeAt: sim.lastTradeAtMs != null ? new Date(sim.lastTradeAtMs).toISOString() : null,
        sampleWindowDays: sim.sampleWindowDays,
        sampleTradeCount: sim.sampleTradeCount,
        slippageBpsEffective: sim.slippageBpsEffective,
        copyRtScore: composed.rtScore,
        copyMedianProfitScore: composed.medianProfitScore,
        copyCompositeScore: composed.compositeScore,
      },
      traderProfile: traderExplain,
    },
    now
  );

  await prisma.smartMoneyLeaderboardRow.updateMany({
    where: { wallet: input.wallet },
    data: {
      copyabilityScore: new Prisma.Decimal(primaryCopyScore.toFixed(8)),
      displayScore: new Prisma.Decimal(displayScore.toFixed(8)),
      traderScore: new Prisma.Decimal(refreshedProfile.traderScore.traderScore.toFixed(8)),
      tier: refreshedProfile.tier.tier,
      edgeScore: new Prisma.Decimal(refreshedProfile.edge.edgeScore.toFixed(8)),
      edgeSampleN: refreshedProfile.edge.edgeSampleN,
      traderType: refreshedProfile.traderType.traderType,
      copyabilityComputedAt: now,
      riskFlags,
      scoreExplain: mergedExplain as Prisma.InputJsonValue,
      backtestPnlUsd:
        sim.backtestPnlUsd != null ? new Prisma.Decimal(sim.backtestPnlUsd.toFixed(8)) : null,
      copyLossRate:
        sim.copyLossRate != null ? new Prisma.Decimal(sim.copyLossRate.toFixed(8)) : null,
      slippageBpsEffective: sim.slippageBpsEffective,
    },
  });

  // 派生写双写：榜表展示权威变更后同步 ScoreCache，避免其它读路径再读到旧档位
  await syncSmartMoneyScoreCacheDisplayFromLeaderboard(input.wallet).catch(() => undefined);
  // sync 内部已清缓存；再清一次无害，避免 sync 失败时列表/详情仍命中旧档位
  await clearSmartMoneyReadCaches();

  await prisma.copyLeader.updateMany({
    where: { address: input.wallet.toLowerCase() },
    data: {
      smartMoneyScore: new Prisma.Decimal(input.smartMoneyScore.toFixed(8)),
      copyabilityScore: new Prisma.Decimal(primaryCopyScore.toFixed(8)),
      tier: refreshedProfile.tier.tier,
    },
  });

  if (isRankModelActive()) {
    const rankResult = await refreshSmartMoneyRankScoreForWallet(input.wallet);
    return {
      copyabilityScore: primaryCopyScore,
      displayScore: rankResult.displayScore,
      explain,
    };
  }

  return {
    copyabilityScore: primaryCopyScore,
    displayScore,
    explain,
  };
}
