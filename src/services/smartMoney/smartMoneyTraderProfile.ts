/**
 * 组装 Edge + TraderScore + Type + Tier + Card（评分链路挂载点）
 */
import type { DataApiPosition } from '../polymarket/polymarketData';
import { computeSmartMoneyEdge, type SmartMoneyEdgeResult } from './smartMoneyEdge';
import { computeTraderScore, type TraderScoreResult } from './smartMoneyTraderScore';
import {
  classifySmartMoneyTraderType,
  type SmartMoneyTraderTypeResult,
} from './smartMoneyTraderType';
import { resolveSmartMoneyTier, type SmartMoneyTierResult } from './smartMoneyTier';
import { buildSmartMoneyTraderCard, type SmartMoneyTraderCard } from './smartMoneyTraderCard';

export type AssembleTraderProfileInput = {
  closedRows: DataApiPosition[] | null | undefined;
  /** Enrich 重算时传入已存 Edge，避免 closedRows 为空时冲掉预测能力分 */
  edgePreset?: SmartMoneyEdgeResult | null;
  totalReturn: number | null;
  profitFactor: number | null;
  /** 统一主胜率：近 SMART_MONEY_PNL_WINDOW_DAYS 已平仓市场（TraderScore / 展示） */
  winRate: number | null;
  /** 已平仓胜率（分层假满分降档 / 卡片风险提示；通常与 winRate 同值） */
  closedWinRate?: number | null;
  closedMarketCount: number | null;
  copyabilityScore: number | null;
  activeDays: number | null;
  maxDrawdownPercent: number | null;
  consistencyScore: number | null;
  top1MarketPnlShare: number | null;
  tradesPerDay1D: number | null;
  trades7d: number | null;
  medianHoldingSec: number | null;
  riskFlags: string[];
  extremeOddsShare?: number | null;
  dominantCategory?: string | null;
  /** 累计成交额；过小则档位 ≤C */
  totalVolumeUsd?: number | null;
  pnl1yUsd?: number | null;
  pnl30dUsd?: number | null;
  pnl7dUsd?: number | null;
  medianNotionalUsd?: number | null;
  mddUnmeasurable?: boolean;
  maxDrawdownUsd?: number | null;
  totalPnlUsd?: number | null;
  mdd7dPercent?: number | null;
  mdd30dPercent?: number | null;
  mddAllPercent?: number | null;
  drawdownRecovered?: boolean | null;
};

export type AssembledTraderProfile = {
  edge: SmartMoneyEdgeResult;
  traderScore: TraderScoreResult;
  traderType: SmartMoneyTraderTypeResult;
  tier: SmartMoneyTierResult;
  card: SmartMoneyTraderCard;
  activeDays: number | null;
  maxWinTradeUsd: number | null;
  maxLossTradeUsd: number | null;
};

function computeExtremeOddsShare(closedRows: DataApiPosition[] | null | undefined): number | null {
  const rows = closedRows ?? [];
  let counted = 0;
  let extreme = 0;
  for (const row of rows) {
    const avg = Number(row.avgPrice);
    if (!Number.isFinite(avg) || avg <= 0 || avg >= 1) continue;
    counted += 1;
    if (avg >= 0.9 || avg <= 0.1) extreme += 1;
  }
  if (counted === 0) return null;
  return Math.round((extreme / counted) * 1000) / 1000;
}

export function assembleSmartMoneyTraderProfile(
  input: AssembleTraderProfileInput
): AssembledTraderProfile {
  const extremeOddsShare =
    input.extremeOddsShare ?? computeExtremeOddsShare(input.closedRows);
  const edge =
    input.edgePreset ??
    computeSmartMoneyEdge(input.closedRows);
  const riskFlags = input.riskFlags ?? [];
  const hasHighTradeFrequencyFlag = riskFlags.includes('HIGH_TRADE_FREQUENCY');
  const hasElevatedTradeFrequencyFlag = riskFlags.includes('ELEVATED_TRADE_FREQUENCY');
  const hasHedgedPairFlag = riskFlags.includes('HEDGED_PAIR_EXPOSURE');
  const hasBlacklistedFlag = riskFlags.includes('BLACKLISTED');
  const hasRealizedOpenWinRateGap = riskFlags.includes('REALIZED_OPEN_WIN_RATE_GAP');
  const hasHardRiskFlag =
    hasBlacklistedFlag ||
    hasHedgedPairFlag ||
    hasHighTradeFrequencyFlag ||
    riskFlags.includes('NEGATIVE_TOTAL_PNL');

  const copyabilityMissing =
    input.copyabilityScore == null || !Number.isFinite(input.copyabilityScore);

  const traderScore = computeTraderScore({
    edgeScore: edge.edgeScore,
    edgeSampleN: edge.edgeSampleN,
    totalReturn: input.totalReturn,
    profitFactor: input.profitFactor,
    winRate: input.winRate,
    closedMarketCount: input.closedMarketCount,
    copyabilityScore: input.copyabilityScore,
    copyabilityMissing,
    activeDays: input.activeDays,
    maxDrawdownPercent: input.maxDrawdownPercent,
    consistencyScore: input.consistencyScore,
    top1MarketPnlShare: input.top1MarketPnlShare,
    hasHighTradeFrequencyFlag,
    hasElevatedTradeFrequencyFlag,
    hasHedgedPairFlag,
    hasBlacklistedFlag,
    extremeOddsShare,
    pnl30dUsd: input.pnl30dUsd,
    pnl7dUsd: input.pnl7dUsd,
    pnl1yUsd: input.pnl1yUsd,
    medianNotionalUsd: input.medianNotionalUsd,
    maxDrawdownUsd: input.maxDrawdownUsd,
    totalPnlUsd: input.totalPnlUsd,
    mdd7dPercent: input.mdd7dPercent,
    mdd30dPercent: input.mdd30dPercent,
    mddAllPercent: input.mddAllPercent,
    drawdownRecovered: input.drawdownRecovered,
  });

  const traderType = classifySmartMoneyTraderType({
    edgeScore: edge.edgeScore,
    edgeSampleN: edge.edgeSampleN,
    medianHoldingSec: input.medianHoldingSec,
    tradesPerDay1D: input.tradesPerDay1D,
    trades7d: input.trades7d,
    top1MarketPnlShare: input.top1MarketPnlShare,
    hasHedgedPairFlag,
    hasHighTradeFrequencyFlag,
    extremeOddsShare,
    totalReturn: input.totalReturn,
    maxDrawdownPercent: input.maxDrawdownPercent,
  });

  const tier = resolveSmartMoneyTier({
    traderScore: traderScore.traderScore,
    edgeScore: edge.edgeScore,
    edgeSampleN: edge.edgeSampleN,
    copyabilityMissing,
    copyabilityScore: input.copyabilityScore,
    traderType: traderType.traderType,
    hasHardRiskFlag,
    top1MarketPnlShare: input.top1MarketPnlShare,
    totalVolumeUsd: input.totalVolumeUsd ?? null,
    closedMarketCount: input.closedMarketCount,
    activeDays: input.activeDays,
    closedWinRate: input.closedWinRate ?? null,
    maxDrawdownPercent: input.maxDrawdownPercent,
    hasRealizedOpenWinRateGap,
    pnl1yUsd: input.pnl1yUsd ?? null,
    pnl30dUsd: input.pnl30dUsd ?? null,
    pnl7dUsd: input.pnl7dUsd ?? null,
    medianNotionalUsd: input.medianNotionalUsd ?? null,
    mddUnmeasurable: input.mddUnmeasurable === true,
  });

  const card = buildSmartMoneyTraderCard({
    edge,
    traderScore,
    traderType,
    tier,
    activeDays: input.activeDays,
    totalReturn: input.totalReturn,
    closedWinRate: input.closedWinRate ?? null,
    hasRealizedOpenWinRateGap,
    maxDrawdownPercent: input.maxDrawdownPercent,
    top1MarketPnlShare: input.top1MarketPnlShare,
    dominantCategory: input.dominantCategory ?? null,
  });

  return {
    edge,
    traderScore,
    traderType,
    tier,
    card,
    activeDays: input.activeDays,
    maxWinTradeUsd: edge.maxWinTradeUsd,
    maxLossTradeUsd: edge.maxLossTradeUsd,
  };
}

/** 写入 scoreExplain 的精简块（去掉 markets 明细以控体积） */
export function traderProfileToExplain(profile: AssembledTraderProfile): Record<string, unknown> {
  return {
    version: 'traderScore_v1',
    edge: {
      edgeScore: profile.edge.edgeScore,
      edgeBar: profile.edge.edgeBar,
      edgeSampleN: profile.edge.edgeSampleN,
      positiveEdgeShare: profile.edge.positiveEdgeShare,
      shrink: profile.edge.shrink,
    },
    traderScore: {
      score: profile.traderScore.traderScore,
      scoreNext: profile.traderScore.traderScoreNext,
      scoreLegacy: profile.traderScore.traderScoreLegacy,
      formula: profile.traderScore.formula,
      raw: profile.traderScore.raw,
      factors: profile.traderScore.factors,
      penalty: profile.traderScore.penalty,
      penaltyItems: profile.traderScore.penaltyItems,
      windowAdjust: profile.traderScore.windowAdjust,
      weights: profile.traderScore.weights,
      copyabilityMissing: profile.traderScore.copyabilityMissing,
      edgeSampleInsufficient: profile.traderScore.edgeSampleInsufficient,
    },
    traderType: profile.traderType.traderType,
    traderTypeLabelZh: profile.traderType.labelZh,
    traderTypeReasons: profile.traderType.reasons,
    tier: profile.tier.tier,
    tierLabelZh: profile.tier.labelZh,
    recommendationStars: profile.tier.recommendationStars,
    tierCappedBy: profile.tier.cappedBy,
    card: profile.card,
    activeDays: profile.activeDays,
    maxWinTradeUsd: profile.maxWinTradeUsd,
    maxLossTradeUsd: profile.maxLossTradeUsd,
  };
}
