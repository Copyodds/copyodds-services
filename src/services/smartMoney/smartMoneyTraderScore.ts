/**
 * TraderScore（产品主分）
 * - legacy：现网五因子（影子期默认展示/入出池）
 * - next：克制演进（§10）— 盈利三层 + 回撤健康 + 权重调整
 * 切主：SMART_MONEY_TRADER_SCORE_NEXT_AS_PRIMARY=true
 */
import { CONFIG } from '../../config/env';
import { EDGE_MIN_SAMPLE_FOR_SA } from './smartMoneyEdge';

/** 演进权重（§10.3） */
export const TRADER_SCORE_WEIGHTS = {
  edge: 0.25,
  profitability: 0.3,
  copyability: 0.2,
  drawdownHealth: 0.15,
  survivalConsistency: 0.1,
} as const;

/** 现网五因子（影子期主分） */
export const TRADER_SCORE_LEGACY_WEIGHTS = {
  edge: 0.25,
  returnQuality: 0.2,
  winRate: 0.15,
  copyability: 0.25,
  stability: 0.15,
} as const;

export type TraderScoreInput = {
  edgeScore: number;
  edgeSampleN: number;
  totalReturn: number | null;
  profitFactor: number | null;
  winRate: number | null;
  closedMarketCount: number | null;
  copyabilityScore: number | null;
  copyabilityMissing: boolean;
  activeDays: number | null;
  maxDrawdownPercent: number | null;
  consistencyScore: number | null;
  top1MarketPnlShare: number | null;
  hasHighTradeFrequencyFlag: boolean;
  /** 软罚：200~500 日均或 24h 尖峰超硬线 */
  hasElevatedTradeFrequencyFlag?: boolean;
  hasHedgedPairFlag: boolean;
  hasBlacklistedFlag: boolean;
  extremeOddsShare: number | null;
  pnl30dUsd?: number | null;
  pnl7dUsd?: number | null;
  /** ALL/1Y 窗净盈（近窗动量） */
  pnl1yUsd?: number | null;
  medianNotionalUsd?: number | null;
  /** 同窗美元 MDD（路径层：MDD$≥总盈亏$） */
  maxDrawdownUsd?: number | null;
  totalPnlUsd?: number | null;
  /** 三窗 MDD%（回撤健康；缺则回落 maxDrawdownPercent） */
  mdd7dPercent?: number | null;
  mdd30dPercent?: number | null;
  mddAllPercent?: number | null;
  /** 是否已修复远古回撤（重新站上峰值） */
  drawdownRecovered?: boolean | null;
};

export type TraderScorePenaltyItem = {
  code:
    | 'HEDGED_PAIR'
    | 'HIGH_TRADE_FREQUENCY'
    | 'ELEVATED_TRADE_FREQUENCY'
    | 'TOP1_CONCENTRATION_HIGH'
    | 'TOP1_CONCENTRATION_MID'
    | 'EXTREME_ODDS'
    | 'THIN_SAMPLE_HIGH_RETURN';
  points: number;
  /** 用户可读：扣在哪里 / 为什么 */
  labelZh: string;
};

export type TraderScoreResult = {
  /** 当前主分（由 nextAsPrimary 开关决定） */
  traderScore: number;
  /** 演进公式分（影子对照） */
  traderScoreNext: number;
  /** 旧五因子分 */
  traderScoreLegacy: number;
  raw: number;
  factors: {
    edge: number;
    profitability: number;
    copyability: number;
    drawdownHealth: number;
    survivalConsistency: number;
    /** legacy 对照 */
    returnQuality?: number;
    winRate?: number;
    stability?: number;
  };
  penalty: number;
  /** 综合特征扣分明细（分数条旁「为什么扣」） */
  penaltyItems: TraderScorePenaltyItem[];
  windowAdjust: number;
  weights: typeof TRADER_SCORE_WEIGHTS | typeof TRADER_SCORE_LEGACY_WEIGHTS;
  copyabilityMissing: boolean;
  edgeSampleInsufficient: boolean;
  formula: 'legacy' | 'next';
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function lin(x: number | null, lo: number, hi: number, missing = 45): number {
  if (x == null || !Number.isFinite(x)) return missing;
  return clamp(((x - lo) / Math.max(hi - lo, 1e-9)) * 100, 0, 100);
}

function invLin(x: number | null, lo: number, hi: number, missing = 50): number {
  if (x == null || !Number.isFinite(x)) return missing;
  return clamp(((hi - x) / Math.max(hi - lo, 1e-9)) * 100, 0, 100);
}

/** n=3~7 强收缩：相对中性 50 的偏离 × n/(n+K) */
function shrinkEdgeScore(edgeScore: number, sampleN: number): number {
  const n = Math.max(0, sampleN);
  if (n >= EDGE_MIN_SAMPLE_FOR_SA) return clamp(edgeScore, 0, 100);
  const k = 12;
  const shrink = n / (n + k);
  return roundScore(50 + (clamp(edgeScore, 0, 100) - 50) * shrink);
}

function shrinkWinRate(winRate: number | null, closedMarketCount: number | null): number {
  if (winRate == null || !Number.isFinite(winRate)) return 45;
  const n = Math.max(0, closedMarketCount ?? 0);
  const shrink = n / (n + 15);
  const centered = 50 + 50 * shrink * ((clamp(winRate, 0, 1) - 0.5) * 2);
  return clamp(centered, 0, 100);
}

function computeReturnQuality(totalReturn: number | null, profitFactor: number | null): number {
  const roi =
    totalReturn != null && totalReturn < 0 ? 0 : lin(totalReturn, 0, 0.5, 35);
  const pf =
    profitFactor != null && profitFactor < 1
      ? 0
      : lin(profitFactor, 1, 2.5, 40);
  return roundScore(roi * 0.55 + pf * 0.45);
}

function computeStability(input: {
  activeDays: number | null;
  consistencyScore: number | null;
  maxDrawdownPercent: number | null;
}): number {
  const survival = lin(input.activeDays, 30, 365, 40);
  const consistency = clamp(input.consistencyScore ?? 45, 0, 100);
  const mddSoft = invLin(input.maxDrawdownPercent, 0, 0.6, 55);
  return roundScore(survival * 0.4 + consistency * 0.35 + mddSoft * 0.25);
}

/** 盈利能力三层（§10.4 B）；路径层独占 MDD$≥PnL$ */
function computeProfitability(input: TraderScoreInput): number {
  const careerRq = computeReturnQuality(input.totalReturn, input.profitFactor);
  const wr = shrinkWinRate(input.winRate, input.closedMarketCount);
  const career = roundScore(careerRq * 0.8 + wr * 0.2);

  const scoreWindow = (pnl: number | null | undefined, missing: number): number => {
    if (pnl == null || !Number.isFinite(pnl)) return missing;
    if (pnl === 0) return 50;
    const mag = Math.min(40, Math.log1p(Math.abs(pnl)) * 4);
    return clamp(50 + (pnl > 0 ? mag : -mag), 0, 100);
  };
  const wAll = scoreWindow(input.pnl1yUsd ?? input.totalPnlUsd, 48);
  const w30 = scoreWindow(input.pnl30dUsd, 48);
  const w7 = scoreWindow(input.pnl7dUsd, 50);
  let momentum = roundScore(wAll * 0.2 + w30 * 0.35 + w7 * 0.45);
  const neg30 = input.pnl30dUsd != null && input.pnl30dUsd < 0;
  const neg7 = input.pnl7dUsd != null && input.pnl7dUsd < 0;
  if (neg30 && neg7) momentum = roundScore(momentum * 0.7);

  let path = 100;
  const dd = input.maxDrawdownUsd;
  const pnl = input.totalPnlUsd ?? input.pnl1yUsd;
  if (dd != null && pnl != null && Number.isFinite(dd) && Number.isFinite(pnl) && !(dd < pnl)) {
    path = 40; // 关系重扣：×0.4 等价于路径分降至 40 再进加权
  }

  return roundScore(career * 0.45 + momentum * 0.4 + path * 0.15);
}

function mddPenalty(mdd: number | null, missingPen = 20): number {
  if (mdd == null || !Number.isFinite(mdd)) return missingPen;
  if (mdd <= 0) return 0;
  if (mdd >= 0.7) return 55 + ((mdd - 0.7) / 0.3) * 25;
  if (mdd >= 0.4) return 25 + ((mdd - 0.4) / 0.3) * 30;
  return (mdd / 0.4) * 25;
}

/** 回撤健康：三窗 MDD + unrecovered；首发无水下占比（C10.3） */
function computeDrawdownHealth(input: TraderScoreInput): number {
  const all = input.mddAllPercent ?? input.maxDrawdownPercent;
  const m7 = input.mdd7dPercent ?? null;
  const m30 = input.mdd30dPercent ?? null;
  const pen7 = mddPenalty(m7, 18);
  const pen30 = mddPenalty(m30, 20);
  let penAll = mddPenalty(all, 22);
  if (input.drawdownRecovered === true) {
    penAll *= 0.35;
  }
  return roundScore(clamp(100 - (0.45 * pen7 + 0.35 * pen30 + 0.2 * penAll), 0, 100));
}

function computeSurvivalConsistency(input: TraderScoreInput): number {
  const survival = lin(input.activeDays, 30, 365, 40);
  const consistency = clamp(input.consistencyScore ?? 45, 0, 100);
  return roundScore(survival * 0.55 + consistency * 0.45);
}

function computeGamblingPenalty(input: TraderScoreInput): {
  total: number;
  items: TraderScorePenaltyItem[];
} {
  const items: TraderScorePenaltyItem[] = [];
  // C10.5：黑名单硬拒绝，不再软罚 +30
  if (input.hasHedgedPairFlag) {
    items.push({
      code: 'HEDGED_PAIR',
      points: 12,
      labelZh: '存在对冲对敞口，收益可复制性与方向性偏弱',
    });
  }
  if (input.hasHighTradeFrequencyFlag) {
    items.push({
      code: 'HIGH_TRADE_FREQUENCY',
      points: 15,
      labelZh: '交易频率过高（疑似做市/刷量），普通跟单难以同步',
    });
  } else if (input.hasElevatedTradeFrequencyFlag) {
    items.push({
      code: 'ELEVATED_TRADE_FREQUENCY',
      points: 8,
      labelZh: '交易频率偏高，跟单滑点与延迟成本更大',
    });
  }
  if (input.top1MarketPnlShare != null && input.top1MarketPnlShare > 0.7) {
    items.push({
      code: 'TOP1_CONCENTRATION_HIGH',
      points: 15,
      labelZh: `收益高度集中（Top1 事件约占 ${Math.round(input.top1MarketPnlShare * 100)}%），可持续性存疑`,
    });
  } else if (input.top1MarketPnlShare != null && input.top1MarketPnlShare > 0.5) {
    items.push({
      code: 'TOP1_CONCENTRATION_MID',
      points: 8,
      labelZh: `收益较集中（Top1 事件约占 ${Math.round(input.top1MarketPnlShare * 100)}%），分散度一般`,
    });
  }
  if (input.extremeOddsShare != null && input.extremeOddsShare > 0.4) {
    items.push({
      code: 'EXTREME_ODDS',
      points: 10,
      labelZh: `极端赔率仓位偏多（约占 ${Math.round(input.extremeOddsShare * 100)}%），波动与博彩特征更强`,
    });
  }
  if (input.edgeSampleN > 0 && input.edgeSampleN < 5 && (input.totalReturn ?? 0) > 0.5) {
    items.push({
      code: 'THIN_SAMPLE_HIGH_RETURN',
      points: 12,
      labelZh: `高回报但已结算样本仅 ${input.edgeSampleN} 个，预测能力证据不足`,
    });
  }
  const total = clamp(
    items.reduce((sum, it) => sum + it.points, 0),
    0,
    30
  );
  return { total, items };
}

export function computeHighMddScorePenalty(maxDrawdownPercent: number | null | undefined): number {
  const threshold = CONFIG.smartMoneyScoreHighMddPct;
  const base = CONFIG.smartMoneyScoreHighMddPenalty;
  const extra = CONFIG.smartMoneyScoreHighMddPenaltyExtra;
  if (threshold <= 0 || (base <= 0 && extra <= 0)) return 0;
  if (maxDrawdownPercent == null || !Number.isFinite(maxDrawdownPercent)) return 0;
  if (maxDrawdownPercent < threshold) return 0;
  const span = Math.max(1e-9, 1 - threshold);
  const t = clamp((maxDrawdownPercent - threshold) / span, 0, 1);
  return base + t * extra;
}

/** legacy 窗口软修正（演进公式主要内化进子分，切主后 windowAdjust≈0） */
function computeWindowAndSizeAdjust(input: TraderScoreInput): number {
  let adj = 0;
  adj -= computeHighMddScorePenalty(input.maxDrawdownPercent);
  const pnl30 = input.pnl30dUsd;
  if (pnl30 != null && Number.isFinite(pnl30) && pnl30 < 0) {
    adj -= CONFIG.smartMoneyScorePnl30dPenalty;
  }
  const pnl7 = input.pnl7dUsd;
  const cap7 = CONFIG.smartMoneyScorePnl7dAbsCap;
  if (pnl7 != null && Number.isFinite(pnl7) && pnl7 !== 0 && cap7 > 0) {
    const mag = Math.min(cap7, Math.log1p(Math.abs(pnl7)) * 1.2);
    adj += pnl7 > 0 ? mag : -mag;
  }
  const median = input.medianNotionalUsd;
  if (
    median != null &&
    Number.isFinite(median) &&
    median >= CONFIG.smartMoneyLargeTradeMedianUsd &&
    CONFIG.smartMoneyScoreLargeTradeBonus > 0
  ) {
    adj += CONFIG.smartMoneyScoreLargeTradeBonus;
  }
  return adj;
}

function computeLegacy(input: TraderScoreInput, edgeFactor: number, copyFactor: number, penalty: number) {
  const factors = {
    edge: roundScore(edgeFactor),
    returnQuality: computeReturnQuality(input.totalReturn, input.profitFactor),
    winRate: roundScore(shrinkWinRate(input.winRate, input.closedMarketCount)),
    copyability: roundScore(copyFactor),
    stability: computeStability({
      activeDays: input.activeDays,
      consistencyScore: input.consistencyScore,
      maxDrawdownPercent: input.maxDrawdownPercent,
    }),
  };
  const w = TRADER_SCORE_LEGACY_WEIGHTS;
  const raw =
    w.edge * factors.edge +
    w.returnQuality * factors.returnQuality +
    w.winRate * factors.winRate +
    w.copyability * factors.copyability +
    w.stability * factors.stability;
  const windowAdjust = computeWindowAndSizeAdjust(input);
  const traderScore = roundScore(clamp(raw - penalty + windowAdjust, 0, 100));
  return { factors, raw: roundScore(raw), windowAdjust, traderScore };
}

function computeNext(input: TraderScoreInput, edgeFactor: number, copyFactor: number, penalty: number) {
  const factors = {
    edge: roundScore(edgeFactor),
    profitability: computeProfitability(input),
    copyability: roundScore(copyFactor),
    drawdownHealth: computeDrawdownHealth(input),
    survivalConsistency: computeSurvivalConsistency(input),
  };
  const w = TRADER_SCORE_WEIGHTS;
  const raw =
    w.edge * factors.edge +
    w.profitability * factors.profitability +
    w.copyability * factors.copyability +
    w.drawdownHealth * factors.drawdownHealth +
    w.survivalConsistency * factors.survivalConsistency;
  // 大额中位软加分保留为轻量 windowAdjust；高 MDD 已由 drawdownHealth 承担，不再叠 computeHighMdd
  let windowAdjust = 0;
  const median = input.medianNotionalUsd;
  if (
    median != null &&
    Number.isFinite(median) &&
    median >= CONFIG.smartMoneyLargeTradeMedianUsd &&
    CONFIG.smartMoneyScoreLargeTradeBonus > 0
  ) {
    windowAdjust += CONFIG.smartMoneyScoreLargeTradeBonus;
  }
  const traderScore = roundScore(clamp(raw - penalty + windowAdjust, 0, 100));
  return { factors, raw: roundScore(raw), windowAdjust, traderScore };
}

export function computeTraderScore(input: TraderScoreInput): TraderScoreResult {
  const edgeSampleInsufficient = input.edgeSampleN < EDGE_MIN_SAMPLE_FOR_SA;
  const edgeFactor = shrinkEdgeScore(input.edgeScore, input.edgeSampleN);

  const copyabilityMissing = input.copyabilityMissing || input.copyabilityScore == null;
  const copyFactor = copyabilityMissing ? 30 : clamp(input.copyabilityScore as number, 0, 100);
  const gambling = computeGamblingPenalty(input);
  const penalty = gambling.total;

  const legacy = computeLegacy(input, edgeFactor, copyFactor, penalty);
  const next = computeNext(input, edgeFactor, copyFactor, penalty);

  const useNext = CONFIG.smartMoneyTraderScoreNextAsPrimary === true;
  const primary = useNext ? next : legacy;

  return {
    traderScore: primary.traderScore,
    traderScoreNext: next.traderScore,
    traderScoreLegacy: legacy.traderScore,
    raw: primary.raw,
    factors: useNext
      ? {
          edge: next.factors.edge,
          profitability: next.factors.profitability,
          copyability: next.factors.copyability,
          drawdownHealth: next.factors.drawdownHealth,
          survivalConsistency: next.factors.survivalConsistency,
          returnQuality: legacy.factors.returnQuality,
          winRate: legacy.factors.winRate,
          stability: legacy.factors.stability,
        }
      : {
          edge: legacy.factors.edge,
          profitability: next.factors.profitability,
          copyability: legacy.factors.copyability,
          drawdownHealth: next.factors.drawdownHealth,
          survivalConsistency: next.factors.survivalConsistency,
          returnQuality: legacy.factors.returnQuality,
          winRate: legacy.factors.winRate,
          stability: legacy.factors.stability,
        },
    penalty: roundScore(penalty),
    penaltyItems: gambling.items,
    windowAdjust: roundScore(primary.windowAdjust),
    weights: useNext ? TRADER_SCORE_WEIGHTS : TRADER_SCORE_LEGACY_WEIGHTS,
    copyabilityMissing,
    edgeSampleInsufficient,
    formula: useNext ? 'next' : 'legacy',
  };
}
