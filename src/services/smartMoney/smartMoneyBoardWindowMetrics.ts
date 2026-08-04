/**
 * 榜单近窗指标：1W 曲线近期盈利、ALL 截窗 1Y 盈利等。
 * 供评分入库 displayProfile 与 L1 门复用。
 * 回撤：窗内峰权益 MDD（与 canonical 一致），不再用美元回撤÷当前本金。
 */
import type { PolymarketProfileFetchResult } from '../polymarket/polymarketProfile';
import { CONFIG } from '../../config/env';
import {
  computePeakEquityMaxDrawdown,
  sanitizeMaxDrawdownRatio,
} from './smartMoneyCanonicalBoardMetrics.js';

function toFiniteNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 指定 period 的 PORTFOLIO_PNL 曲线按时间排序后的数值序列 */
export function pickPortfolioPnlValues(
  profile: PolymarketProfileFetchResult,
  period: '1D' | '1W' | '1M' | 'ALL'
): { values: number[]; timestamps: Date[] } {
  const points = profile.curves
    .filter(
      (point) => point.period === period && point.curveType.startsWith('PORTFOLIO_PNL')
    )
    .map((point) => ({
      ts: point.ts instanceof Date ? point.ts : new Date(point.ts),
      value: toFiniteNumber(point.value),
    }))
    .filter((point): point is { ts: Date; value: number } => point.value != null)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return {
    values: points.map((p) => p.value),
    timestamps: points.map((p) => p.ts),
  };
}

/** 曲线末 − 初（窗口盈亏变化） */
export function computeCurveWindowPnlChange(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  return Math.round((last - first) * 10000) / 10000;
}

export type SmartMoneyPnlWindowMetric = {
  days: 7 | 30 | 365;
  pnlUsd: number | null;
  actualWindowDays: number | null;
  coverageRatio: number;
  maxDrawdownUsd: number | null;
  returnRatio: number | null;
  maxDrawdownRatio: number | null;
};

/**
 * ALL/短窗共用：截取 now−days 起的累计 PnL 子序列（含 cutoff 前最后一点作起点）。
 * 与 MDD / 1Y PnL 同源，供夏普等代理指标复用。
 */
export function slicePortfolioPnlWindowValues(
  values: number[],
  timestamps: Date[],
  days: 7 | 30 | 365,
  nowMs: number
): { values: number[]; timestamps: Date[] } {
  if (values.length < 2 || timestamps.length < 2 || values.length !== timestamps.length) {
    return { values: [], timestamps: [] };
  }
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  let startIdx = 0;
  for (let index = 0; index < timestamps.length; index += 1) {
    if (timestamps[index]!.getTime() <= cutoff) startIdx = index;
    else break;
  }
  return {
    values: values.slice(startIdx),
    timestamps: timestamps.slice(startIdx),
  };
}

function computeWindowMetric(
  values: number[],
  timestamps: Date[],
  days: 7 | 30 | 365,
  principalUsd: number | null,
  nowMs: number
): SmartMoneyPnlWindowMetric {
  if (values.length < 2 || timestamps.length < 2) {
    return {
      days,
      pnlUsd: null,
      actualWindowDays: null,
      coverageRatio: 0,
      maxDrawdownUsd: null,
      returnRatio: null,
      maxDrawdownRatio: null,
    };
  }
  const sliced = slicePortfolioPnlWindowValues(values, timestamps, days, nowMs);
  const windowValues = sliced.values;
  const windowTimestamps = sliced.timestamps;
  if (windowValues.length < 2) {
    return {
      days,
      pnlUsd: null,
      actualWindowDays: null,
      coverageRatio: 0,
      maxDrawdownUsd: null,
      returnRatio: null,
      maxDrawdownRatio: null,
    };
  }
  const pnlUsd = computeCurveWindowPnlChange(windowValues);
  const actualWindowDays = Math.max(
    1,
    Math.round(
      (windowTimestamps[windowTimestamps.length - 1]!.getTime() -
        windowTimestamps[0]!.getTime()) /
        (24 * 60 * 60 * 1000)
    )
  );
  const peakDd = computePeakEquityMaxDrawdown(windowValues);
  const sanitizedDd = sanitizeMaxDrawdownRatio(
    peakDd.maxDrawdownPercent,
    CONFIG.smartMoneyMddSaturation
  );
  const validPrincipal =
    principalUsd != null && Number.isFinite(principalUsd) && principalUsd > 0
      ? principalUsd
      : null;
  return {
    days,
    pnlUsd,
    actualWindowDays,
    coverageRatio: Math.min(1, actualWindowDays / days),
    maxDrawdownUsd: peakDd.maxDrawdownUsd,
    returnRatio: validPrincipal != null && pnlUsd != null ? pnlUsd / validPrincipal : null,
    /** 窗内 (Peak−Equity)/Peak；无可靠峰值时 null（展示「-」） */
    maxDrawdownRatio: sanitizedDd.value,
  };
}

/**
 * 同一累计 PnL 曲线、同一本金下的 7D/30D/1Y 指标。
 * 7D 用 1W；30D 有独立 1M 则用 1M，否则 ALL 截窗（入榜 Enrich 补齐前的过渡）；1Y 用 ALL。
 */
export function computeBoardPnlWindowMetrics(
  profile: PolymarketProfileFetchResult,
  principalUsd: number | null,
  nowMs = Date.now()
): { pnl7d: SmartMoneyPnlWindowMetric; pnl30d: SmartMoneyPnlWindowMetric; pnl1y: SmartMoneyPnlWindowMetric } {
  const week = pickPortfolioPnlValues(profile, '1W');
  const month = pickPortfolioPnlValues(profile, '1M');
  const all = pickPortfolioPnlValues(profile, 'ALL');
  const monthOrAll =
    month.values.length >= 2
      ? { values: month.values, timestamps: month.timestamps, windowDays: 30 as const }
      : { values: all.values, timestamps: all.timestamps, windowDays: 30 as const };
  return {
    pnl7d: computeWindowMetric(week.values, week.timestamps, 7, principalUsd, nowMs),
    pnl30d: computeWindowMetric(
      monthOrAll.values,
      monthOrAll.timestamps,
      monthOrAll.windowDays,
      principalUsd,
      nowMs
    ),
    pnl1y: computeWindowMetric(all.values, all.timestamps, 365, principalUsd, nowMs),
  };
}

/** 近 7 日盈利：优先 1W 曲线 */
export function computeRecentPnl7d(profile: PolymarketProfileFetchResult): number | null {
  const { values } = pickPortfolioPnlValues(profile, '1W');
  return computeCurveWindowPnlChange(values);
}

/**
 * 近 1 年盈亏：在 ALL 曲线上截 now−365d 起的变化；
 * 历史不足一年则用曲线首点，并返回实际窗口天数。
 */
export function computeTotalPnl1y(profile: PolymarketProfileFetchResult, nowMs = Date.now()): {
  totalPnl1y: number | null;
  pnlWindowDays: number | null;
} {
  const { values, timestamps } = pickPortfolioPnlValues(profile, 'ALL');
  if (values.length < 2 || timestamps.length < 2) {
    return { totalPnl1y: null, pnlWindowDays: null };
  }
  const cutoff = nowMs - 365 * 24 * 60 * 60 * 1000;
  let startIdx = 0;
  for (let i = 0; i < timestamps.length; i += 1) {
    if (timestamps[i]!.getTime() >= cutoff) {
      startIdx = i;
      break;
    }
    startIdx = i;
  }
  // 若全部点都在 cutoff 之后，startIdx=0；若有更早点，取最后一个 < cutoff 的点作起点
  if (timestamps[0]!.getTime() < cutoff) {
    startIdx = 0;
    for (let i = 0; i < timestamps.length; i += 1) {
      if (timestamps[i]!.getTime() <= cutoff) startIdx = i;
      else break;
    }
  }
  const startVal = values[startIdx]!;
  const endVal = values[values.length - 1]!;
  const windowMs = timestamps[timestamps.length - 1]!.getTime() - timestamps[startIdx]!.getTime();
  const pnlWindowDays = Math.max(1, Math.round(windowMs / (24 * 60 * 60 * 1000)));
  return {
    totalPnl1y: Math.round((endVal - startVal) * 10000) / 10000,
    pnlWindowDays,
  };
}
