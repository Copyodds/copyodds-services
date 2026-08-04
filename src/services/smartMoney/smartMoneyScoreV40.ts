/**
 * Smart Money 综合分 v4.0（设计 §6）
 * 各因子 0–100 归一后加权；P_hft 单独扣减；copyability 只在此公式计入一次。
 */
import { CONFIG } from '../../config/env';

/** 设计 §6.3 推荐权重（总和 = 1.0） */
export const SMART_MONEY_SCORE_V40_WEIGHTS = {
  base: 0.05,
  roi: 0.12,
  recent_pnl: 0.09,
  pnl_30d: 0.05,
  total_pnl: 0.07,
  sharpe: 0.08,
  mdd: 0.08,
  win_rate: 0.08,
  profit_factor: 0.06,
  concentration: 0.03,
  copyability: 0.15,
  activity_freq: 0.06,
  consistency: 0.05,
  distribution: 0.03,
} as const;

export type SmartMoneyScoreV40Weights = typeof SMART_MONEY_SCORE_V40_WEIGHTS;

/** 缺仿真样本时的明确默认分（写入 scoreExplain，非静默） */
export const SMART_MONEY_COPYABILITY_MISSING_DEFAULT = 45;

export type SmartMoneyScoreV40Input = {
  dataConfidence: number;
  sampleSize: number;
  totalReturn: number | null;
  sharpeRatio: number | null;
  maxDrawdownPercent: number | null;
  winRate: number | null;
  profitFactor: number | null;
  maxSpikeRatio: number | null;
  copyabilityScore: number | null;
  /** 近 7 日 PnL（USD） */
  recentPnl7d?: number | null;
  /** 近 30 日 PnL（USD） */
  recentPnl30d?: number | null;
  /** 同窗本金归一收益；正负对称，避免绝对美元偏向大户 */
  recentReturn7d?: number | null;
  recentReturn30d?: number | null;
  recentCoverage7d?: number | null;
  recentCoverage30d?: number | null;
  /** 约 1Y / 生涯窗口总盈利（USD） */
  totalPnl1y?: number | null;
  /** 近 7 日成交笔数；用于 §6.2 频率曲线 */
  trades7d?: number | null;
  /** @deprecated 兼容旧调用；优先用 trades7d 分段曲线 */
  activityScore?: number;
  consistencyScore: number;
  highReturnMarketShare: number | null;
  top1MarketPnlShare: number | null;
  volumeFreshRatio?: number | null;
  tradesPerDay1D: number | null;
  hasHighTradeFrequencyFlag: boolean;
};

export type SmartMoneyScoreV40Result = {
  score: number;
  raw: number;
  factors: Record<string, number>;
  penalties: { P_hft: number };
  weights: SmartMoneyScoreV40Weights;
  copyabilityMissing: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function lin(x: number | null, lo: number, hi: number, missing = 0): number {
  if (x == null || !Number.isFinite(x)) return missing;
  return clamp(((x - lo) / Math.max(hi - lo, 1e-9)) * 100, 0, 100);
}

function invLin(x: number | null, lo: number, hi: number, missing = 40): number {
  if (x == null || !Number.isFinite(x)) return missing;
  return clamp(((hi - x) / Math.max(hi - lo, 1e-9)) * 100, 0, 100);
}

function logN(x: number | null, lo: number, hi: number, missing = 0): number {
  if (x == null || !Number.isFinite(x) || x < lo) return missing;
  return clamp(Math.log1p(Math.max(x, 0)) / Math.log1p(hi), 0, 1) * 100;
}

/** 零收益=50，正收益加分、负收益减分；覆盖不足向中性分收缩。 */
export function computeSignedPnlFactor(
  returnRatio: number | null | undefined,
  coverageRatio: number | null | undefined,
  scale = 0.02,
  cap = 0.5
): number {
  if (returnRatio == null || !Number.isFinite(returnRatio)) return 50;
  const coverage = clamp(coverageRatio ?? 0, 0, 1);
  const magnitude =
    Math.log1p(Math.abs(returnRatio) / scale) / Math.log1p(cap / scale);
  const signed = Math.sign(returnRatio) * Math.min(1, magnitude);
  return clamp(50 + 50 * coverage * signed, 0, 100);
}

/**
 * 设计 §6.2：t = trades7d / 7（日均笔数）分段曲线。
 * 0 < t ≤ 50 → 100→70；50–100 → 70→40；100–200 → 40→10；>200 → 0。
 */
export function computeActivityFreqFactor(trades7d: number | null | undefined): number {
  if (trades7d == null || !Number.isFinite(trades7d) || trades7d <= 0) return 40;
  const t = trades7d / 7;
  if (t <= 50) return 100 - (t / 50) * 30;
  if (t <= 100) return 70 - ((t - 50) / 50) * 30;
  if (t <= 200) return 40 - ((t - 100) / 100) * 30;
  return 0;
}

function computeHftPenalty(tradesPerDay1D: number | null, hasFlag: boolean): number {
  const maxPerDay = Math.max(1, CONFIG.smartMoneyMaxTradesPerDay);
  let p = 0;
  if (tradesPerDay1D != null && Number.isFinite(tradesPerDay1D)) {
    const r = tradesPerDay1D / maxPerDay;
    if (r > 1) {
      p = ((Math.min(r, 2.5) - 1) / 1.5) * 20;
    }
  }
  if (hasFlag) p = Math.max(p, 15);
  return clamp(p, 0, 20);
}

export function computeSmartMoneyScoreV40(input: SmartMoneyScoreV40Input): SmartMoneyScoreV40Result {
  const w = SMART_MONEY_SCORE_V40_WEIGHTS;
  const S_base = clamp(
    input.dataConfidence * 0.6 + logN(input.sampleSize, 20, 80, 40) * 0.4,
    0,
    100
  );
  const S_roi =
    input.totalReturn != null && input.totalReturn < 0 ? 0 : lin(input.totalReturn, 0, 0.5, 0);
  const S_recent_pnl = computeSignedPnlFactor(
    input.recentReturn7d,
    input.recentCoverage7d
  );
  const S_pnl_30d = computeSignedPnlFactor(
    input.recentReturn30d,
    input.recentCoverage30d
  );
  const S_total_pnl = logN(input.totalPnl1y ?? null, 100, 500_000, 35);
  const S_sharpe = lin(input.sharpeRatio, -0.5, 2.5, 40);
  const S_mdd = invLin(input.maxDrawdownPercent, 0, 0.6, 40);
  // 设计 §6.1：胜率 10%～70% 线性（与硬门起点对齐）
  const S_win_rate = lin(input.winRate, 0.1, 0.7, 45);
  const S_profit_factor =
    input.profitFactor != null && input.profitFactor < 1
      ? 0
      : lin(input.profitFactor, 1, 2.5, 45);
  const S_concentration = invLin(input.maxSpikeRatio, 0, 0.35, 50);
  const copyabilityMissing =
    input.copyabilityScore == null || !Number.isFinite(input.copyabilityScore);
  const S_copyability = copyabilityMissing
    ? SMART_MONEY_COPYABILITY_MISSING_DEFAULT
    : clamp(input.copyabilityScore as number, 0, 100);
  const S_activity_freq = computeActivityFreqFactor(input.trades7d);
  const S_consistency = clamp(input.consistencyScore, 0, 100);
  const distHigh = lin(input.highReturnMarketShare, 0.15, 0.55, 45);
  const distTop1 = invLin(input.top1MarketPnlShare, 0.2, 0.7, 45);
  const S_distribution = distHigh * 0.55 + distTop1 * 0.45;

  const factors = {
    S_base: roundScore(S_base),
    S_roi: roundScore(S_roi),
    S_recent_pnl: roundScore(S_recent_pnl),
    S_pnl_30d: roundScore(S_pnl_30d),
    S_total_pnl: roundScore(S_total_pnl),
    S_sharpe: roundScore(S_sharpe),
    S_mdd: roundScore(S_mdd),
    S_win_rate: roundScore(S_win_rate),
    S_profit_factor: roundScore(S_profit_factor),
    S_concentration: roundScore(S_concentration),
    S_copyability: roundScore(S_copyability),
    S_activity_freq: roundScore(S_activity_freq),
    /** 兼容旧 explain 键名 */
    S_activity: roundScore(S_activity_freq),
    S_consistency: roundScore(S_consistency),
    S_distribution: roundScore(S_distribution),
  };

  const raw =
    w.base * factors.S_base +
    w.roi * factors.S_roi +
    w.recent_pnl * factors.S_recent_pnl +
    w.pnl_30d * factors.S_pnl_30d +
    w.total_pnl * factors.S_total_pnl +
    w.sharpe * factors.S_sharpe +
    w.mdd * factors.S_mdd +
    w.win_rate * factors.S_win_rate +
    w.profit_factor * factors.S_profit_factor +
    w.concentration * factors.S_concentration +
    w.copyability * factors.S_copyability +
    w.activity_freq * factors.S_activity_freq +
    w.consistency * factors.S_consistency +
    w.distribution * factors.S_distribution;

  const P_hft = computeHftPenalty(input.tradesPerDay1D, input.hasHighTradeFrequencyFlag);
  const score = roundScore(clamp(raw - P_hft, 0, 100));

  return {
    score,
    raw: roundScore(raw),
    factors,
    penalties: { P_hft: roundScore(P_hft) },
    weights: w,
    copyabilityMissing,
  };
}

export function isSmartMoneyScoreV40Active(version = CONFIG.smartMoneyScoreVersion): boolean {
  return version.trim().toLowerCase().startsWith('v4');
}

/** 权重和自检（测试用） */
export function sumSmartMoneyScoreV40Weights(): number {
  return Object.values(SMART_MONEY_SCORE_V40_WEIGHTS).reduce((a, b) => a + b, 0);
}
