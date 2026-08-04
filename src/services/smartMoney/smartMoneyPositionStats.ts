import type { ClosedPositionsFetchMeta, ClosedPositionsFetchResult, DataApiPosition } from '../polymarket/polymarketData';
import {
  CLOSED_POSITIONS_DEFAULT_MAX_PAGES,
  CLOSED_POSITIONS_TOTAL_BUDGET_MS,
  CLOSED_POSITIONS_WINDOW_DAYS,
  extractClosedPositionAtMs,
  fetchDataApiClosedPositions,
  fetchDataApiPositions,
} from '../polymarket/polymarketData';

export type ClosedPositionPnlStats = {
  sampleSize: number;
  marketCount: number;
  decisiveMarkets: number;
  winningMarkets: number;
  /** decisive 亏损市场数（|PnL|≥0.5 且 PnL<0），与 winningMarkets 同口径 */
  losingMarkets: number;
  marketWinRate: number | null;
  topMarketPnlShare: number | null;
  totalRealizedPnl: number | null;
  /** 赢市合计 / |亏市合计| */
  profitFactor: number | null;
  /** 有盈利且总亏损为 0；此时 PF 数学上为正无穷，但展示仍保持 null */
  profitFactorNoLoss: boolean;
};

/** 近窗已平仓中投入（成本）最大的市场/事件 */
export type MaxInvestedClosedMarket = {
  /** 该事件投入成本合计（USD） */
  costBasisUsd: number;
  /** 该事件已实现盈亏合计（USD） */
  realizedPnl: number | null;
  title: string | null;
  conditionId: string | null;
  /** 参与比较的已平仓市场数 */
  sampleSize: number;
};

export type ClosedMarketReturnDistributionBucket = {
  id: string;
  label: string;
  count: number;
  ratio: number | null;
};

export type ClosedMarketReturnDistribution = {
  /** 有成本、可算收益率的已平仓事件数 */
  sampledMarketCount: number;
  /**
   * 平均盈利率：近窗已平仓事件收益率的等权算术平均（每事件一票，不论本金大小）。
   */
  meanReturn: number | null;
  medianReturn: number | null;
  /**
   * 总盈利率：近窗已平仓 Σ已实现盈亏 / Σ投入成本。
   * 本金不足或比率荒谬时为 null（展示「—」），禁止回退成交量。
   */
  totalReturnRatio: number | null;
  /** 近窗已平仓事件已实现盈亏合计（与 totalReturnRatio 同样本） */
  totalRealizedPnl: number | null;
  /** 近窗已平仓事件投入成本合计（占用本金代理） */
  totalCostBasisUsd: number | null;
  buckets: ClosedMarketReturnDistributionBucket[];
};

/** 总盈利率分母下限（与榜单资本 ROI 一致） */
export const MIN_CLOSED_RETURN_COST_USD = 100;
/** 总盈利率绝对值脏数据上限（比率，非百分数） */
export const MAX_CLOSED_TOTAL_RETURN_RATIO = 5;

export type OpenPositionPnlStats = {
  sampleSize: number;
  marketCount: number;
  decisiveMarkets: number;
  winningMarkets: number;
  marketWinRate: number | null;
  underwaterMarketShare: number | null;
  totalUnrealizedPnl: number | null;
  /** 未平仓成本合计（size×avgPrice 等）；供资本回报本金 */
  totalCostBasis: number | null;
};

/** 同一市场 Yes+No 对冲刷量暴露 */
export type HedgedPairExposure = {
  hedgedPairShare: number | null;
  hedgedMarketCount: number;
  hedgedNotional: number;
  totalOpenNotional: number;
};

export type PositionPnlStats = {
  closed: ClosedPositionPnlStats | null;
  open: OpenPositionPnlStats | null;
  /** 已平仓 + 未平仓合并胜率（仅 explain/风控诊断；主展示与评分用 closed） */
  compositeMarketWinRate: number | null;
  /** 未平仓双边对冲占比；无持仓或无法计量时为 null */
  hedgedPairExposure: HedgedPairExposure | null;
};

export type PositionPnlContext = {
  closedRows: DataApiPosition[];
  openRows: DataApiPosition[];
  stats: PositionPnlStats;
  /** closed-positions 请求是否成功（失败时勿把样本当成「真的 0」） */
  closedFetchOk: boolean;
  /** open positions 请求是否成功 */
  openFetchOk: boolean;
  /** closed 失败原因（超时/HTTP/中断），便于 scoreExplain 诊断 */
  closedFetchError?: string | null;
  /** 近一年 closed 采集元信息（工程顶 / 早停 / 截断） */
  closedSample?: ClosedPositionsFetchMeta | null;
};

export const MIN_DECISIVE_MARKETS_FOR_WIN_RATE = 8;
/** 对冲名义 / 未平仓总名义 ≥ 该阈值则视为刷量对冲 */
export const HEDGED_PAIR_SHARE_THRESHOLD = 0.5;
/** 双边 size/名义 min/max 达到该比例才算「较接近」的配对仓 */
export const HEDGED_PAIR_BALANCE_MIN_RATIO = 0.5;
/** 已平仓胜率 / PF / 回报分布的本地时间窗（与 closed 采集窗一致） */
export const SMART_MONEY_PNL_WINDOW_DAYS = CLOSED_POSITIONS_WINDOW_DAYS;
/** Deep 评分路径 closed 翻页硬顶（约 4000 行） */
export const CLOSED_POSITIONS_DEEP_MAX_PAGES = CLOSED_POSITIONS_DEFAULT_MAX_PAGES;

export const EMPTY_OPEN_POSITION_STATS: OpenPositionPnlStats = {
  sampleSize: 0,
  marketCount: 0,
  decisiveMarkets: 0,
  winningMarkets: 0,
  marketWinRate: null,
  underwaterMarketShare: null,
  totalUnrealizedPnl: null,
  totalCostBasis: null,
};

export const EMPTY_HEDGED_PAIR_EXPOSURE: HedgedPairExposure = {
  hedgedPairShare: null,
  hedgedMarketCount: 0,
  hedgedNotional: 0,
  totalOpenNotional: 0,
};

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundMetric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function marketKeyFromRow(row: DataApiPosition, fallbackIndex: number): string {
  if (typeof row.conditionId === 'string' && row.conditionId) return row.conditionId;
  if (typeof row.asset === 'string' && row.asset) return row.asset;
  return `row:${fallbackIndex}`;
}

function extractPnlFromRow(row: DataApiPosition, keys: string[]): number | null {
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    const value = numberFromUnknown(record[key]);
    if (value != null) return value;
  }
  return null;
}

export function filterClosedRowsByRecentDays(
  rows: DataApiPosition[],
  days = SMART_MONEY_PNL_WINDOW_DAYS,
  nowMs = Date.now()
): DataApiPosition[] {
  const thresholdMs = nowMs - days * 24 * 60 * 60 * 1000;
  const withTimestamp = rows.filter((row) => extractClosedPositionAtMs(row) != null);
  // 兼容历史/测试数据：若上游未给任何可解析关闭时间，则退回全量样本避免“全空”。
  if (withTimestamp.length === 0) return rows;
  return withTimestamp.filter((row) => {
    const closedAtMs = extractClosedPositionAtMs(row);
    return closedAtMs != null && closedAtMs >= thresholdMs;
  });
}

function summarizePnlByMarket(
  rows: DataApiPosition[],
  extractPnl: (row: DataApiPosition) => number | null
): {
  sampleSize: number;
  marketCount: number;
  decisiveMarkets: number;
  winningMarkets: number;
  losingMarkets: number;
  marketWinRate: number | null;
  marketPnls: number[];
  totalPnl: number | null;
  profitFactor: number | null;
  profitFactorNoLoss: boolean;
} {
  const pnlByMarket = new Map<string, number>();
  let totalPnl = 0;
  let sampleSize = 0;

  for (const row of rows) {
    const pnl = extractPnl(row);
    if (pnl == null) continue;
    sampleSize += 1;
    totalPnl += pnl;
    const marketKey = marketKeyFromRow(row, sampleSize);
    pnlByMarket.set(marketKey, (pnlByMarket.get(marketKey) ?? 0) + pnl);
  }

  const marketPnls = [...pnlByMarket.values()];
  let winningMarkets = 0;
  let decisiveMarkets = 0;
  let losingMarkets = 0;
  let grossProfit = 0;
  let grossLossAbs = 0;
  for (const pnl of marketPnls) {
    if (pnl > 0) grossProfit += pnl;
    else if (pnl < 0) grossLossAbs += Math.abs(pnl);
    if (Math.abs(pnl) < 0.5) continue;
    decisiveMarkets += 1;
    if (pnl > 0) winningMarkets += 1;
    if (pnl < 0) losingMarkets += 1;
  }

  return {
    sampleSize,
    marketCount: marketPnls.length,
    decisiveMarkets,
    winningMarkets,
    losingMarkets,
    marketWinRate: decisiveMarkets > 0 ? winningMarkets / decisiveMarkets : null,
    marketPnls,
    totalPnl: sampleSize > 0 ? totalPnl : null,
    // 无亏损样本时盈亏比数学上为无穷大，返回 null 由展示层处理（避免占位 99 误导用户）
    profitFactor:
      grossLossAbs > 0
        ? roundMetric(grossProfit / grossLossAbs)
        : null,
    profitFactorNoLoss: grossProfit > 0 && grossLossAbs === 0,
  };
}

/** 按市场汇总已平仓 PnL */
export function summarizeClosedPositionPnlStats(rows: DataApiPosition[]): ClosedPositionPnlStats {
  const recentRows = filterClosedRowsByRecentDays(rows);
  const summary = summarizePnlByMarket(recentRows, (row) =>
    extractPnlFromRow(row, ['realizedPnl', 'pnl', 'cashPnl', 'totalPnl', 'profit'])
  );
  const positivePnls = summary.marketPnls.filter((pnl) => pnl > 0);
  const positiveSum = positivePnls.reduce((sum, pnl) => sum + pnl, 0);
  const topMarketPnlShare =
    positiveSum > 0 && positivePnls.length > 0
      ? Math.max(...positivePnls) / positiveSum
      : null;

  return {
    sampleSize: summary.sampleSize,
    marketCount: summary.marketCount,
    decisiveMarkets: summary.decisiveMarkets,
    winningMarkets: summary.winningMarkets,
    losingMarkets: summary.losingMarkets,
    marketWinRate: summary.marketWinRate,
    topMarketPnlShare,
    totalRealizedPnl: summary.totalPnl,
    profitFactor: summary.profitFactor,
    profitFactorNoLoss: summary.profitFactorNoLoss,
  };
}

type ClosedMarketCostAgg = {
  costBasisUsd: number;
  realizedPnl: number;
  hasPnl: boolean;
  title: string | null;
  conditionId: string;
};

/**
 * 近窗已平仓按市场（conditionId）汇总成本与已实现盈亏。
 * 仅纳入能解析出正成本的行；无成本行不进本金/总回报样本。
 */
export function aggregateClosedMarketsByCost(
  rows: DataApiPosition[],
  days = SMART_MONEY_PNL_WINDOW_DAYS,
  nowMs = Date.now()
): ClosedMarketCostAgg[] {
  const recentRows = filterClosedRowsByRecentDays(rows, days, nowMs);
  const byMarket = new Map<string, ClosedMarketCostAgg>();

  for (let i = 0; i < recentRows.length; i += 1) {
    const row = recentRows[i]!;
    const cost = extractClosedPositionCostBasis(row);
    if (cost == null || !(cost > 0)) continue;
    const marketKey = marketKeyFromRow(row, i);
    const realizedPnl = extractPnlFromRow(row, [
      'realizedPnl',
      'pnl',
      'cashPnl',
      'totalPnl',
      'profit',
    ]);
    const title =
      typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null;
    const existing = byMarket.get(marketKey);
    if (!existing) {
      byMarket.set(marketKey, {
        costBasisUsd: cost,
        realizedPnl: realizedPnl ?? 0,
        hasPnl: realizedPnl != null,
        title,
        conditionId: marketKey.startsWith('row:') ? '' : marketKey,
      });
      continue;
    }
    existing.costBasisUsd += cost;
    if (realizedPnl != null) {
      existing.realizedPnl += realizedPnl;
      existing.hasPnl = true;
    }
    if (!existing.title && title) existing.title = title;
  }

  return [...byMarket.values()];
}

/**
 * 近 SMART_MONEY_PNL_WINDOW_DAYS 已平仓中，按市场（conditionId）汇总投入成本，
 * 取投入最大的事件，并返回该事件已实现盈亏。
 * 单行成本：initialValue ?? totalBought×avgPrice ?? size×avgPrice
 * ??（realizedPnl / 收益率）?? 二元市盈亏反推。
 */
export function findMaxInvestedClosedMarket(
  rows: DataApiPosition[],
  days = SMART_MONEY_PNL_WINDOW_DAYS,
  nowMs = Date.now()
): MaxInvestedClosedMarket | null {
  const markets = aggregateClosedMarketsByCost(rows, days, nowMs);
  if (markets.length === 0) return null;

  let best: ClosedMarketCostAgg | null = null;
  for (const agg of markets) {
    if (best == null || agg.costBasisUsd > best.costBasisUsd) best = agg;
  }
  if (best == null) return null;

  return {
    costBasisUsd: roundMetric(best.costBasisUsd) ?? best.costBasisUsd,
    realizedPnl: best.hasPnl
      ? (roundMetric(best.realizedPnl) ?? best.realizedPnl)
      : null,
    title: best.title,
    conditionId: best.conditionId || null,
    sampleSize: markets.length,
  };
}

function extractClosedPositionCostBasis(row: DataApiPosition): number | null {
  const record = row as Record<string, unknown>;
  const initialValue = numberFromUnknown(record.initialValue);
  if (initialValue != null && initialValue > 0) return initialValue;
  const totalBought = numberFromUnknown(record.totalBought);
  const avgPrice = numberFromUnknown(record.avgPrice);
  if (totalBought != null && totalBought > 0 && avgPrice != null && avgPrice > 0) {
    return totalBought * avgPrice;
  }
  const size = numberFromUnknown(row.size) ?? 0;
  if (size > 0 && avgPrice != null && avgPrice > 0) return size * avgPrice;

  // Data API 常有 percentRealizedPnl / realizedPnl 而无 initialValue：用收益率反推成本
  const realizedPnl = extractPnlFromRow(row, [
    'realizedPnl',
    'pnl',
    'cashPnl',
    'totalPnl',
    'profit',
  ]);
  const explicitPercent =
    numberFromUnknown(record.percentRealizedPnl) ?? numberFromUnknown(record.percentPnl);
  if (realizedPnl != null && explicitPercent != null) {
    const ratio =
      Math.abs(explicitPercent) > 1 ? explicitPercent / 100 : explicitPercent;
    if (Math.abs(ratio) > 1e-9) {
      const inferred = realizedPnl / ratio;
      if (Number.isFinite(inferred) && inferred > 0) return inferred;
    }
  }

  // 二元市场近似：输光 ≈ |pnl|；赢盘 cost ≈ pnl * avgPrice / (1 - avgPrice)
  if (
    realizedPnl != null &&
    avgPrice != null &&
    avgPrice > 0 &&
    avgPrice < 1 &&
    Math.abs(realizedPnl) > 1e-9
  ) {
    if (realizedPnl < 0) return Math.abs(realizedPnl);
    const denom = 1 - avgPrice;
    if (denom > 1e-9) {
      const inferred = (realizedPnl * avgPrice) / denom;
      if (Number.isFinite(inferred) && inferred > 0) return inferred;
    }
  }
  return null;
}

function extractClosedPositionReturnRatio(row: DataApiPosition): number | null {
  const record = row as Record<string, unknown>;
  const explicitPercent =
    numberFromUnknown(record.percentRealizedPnl) ??
    numberFromUnknown(record.percentPnl);
  if (explicitPercent != null) {
    return Math.abs(explicitPercent) > 1 ? explicitPercent / 100 : explicitPercent;
  }

  const realizedPnl = extractPnlFromRow(row, ['realizedPnl', 'pnl', 'cashPnl', 'totalPnl', 'profit']);
  const totalBought = numberFromUnknown(record.totalBought);
  const avgPrice = numberFromUnknown(record.avgPrice);
  const costBasis =
    numberFromUnknown(record.initialValue) ??
    (totalBought != null && avgPrice != null ? totalBought * avgPrice : null);

  if (realizedPnl == null || costBasis == null || costBasis <= 0) {
    return null;
  }
  return roundMetric(realizedPnl / costBasis);
}

const CLOSED_MARKET_RETURN_DISTRIBUTION_RANGES: Array<{
  id: string;
  label: string;
  test: (value: number) => boolean;
}> = [
  { id: 'leMinus5', label: '<= -5%', test: (value) => value <= -0.05 },
  { id: 'minus5ToMinus2', label: '-5% to -2%', test: (value) => value > -0.05 && value <= -0.02 },
  { id: 'minus2ToMinus1', label: '-2% to -1%', test: (value) => value > -0.02 && value <= -0.01 },
  { id: 'minus1ToZero', label: '-1% to 0%', test: (value) => value > -0.01 && value < 0 },
  { id: 'zeroToPlus1', label: '0% to +1%', test: (value) => value >= 0 && value < 0.01 },
  { id: 'plus1ToPlus2', label: '+1% to +2%', test: (value) => value >= 0.01 && value < 0.02 },
  { id: 'plus2ToPlus5', label: '+2% to +5%', test: (value) => value >= 0.02 && value < 0.05 },
  { id: 'plus5ToPlus10', label: '+5% to +10%', test: (value) => value >= 0.05 && value < 0.1 },
  { id: 'gePlus10', label: '>= +10%', test: (value) => value >= 0.1 },
];

/** 已平仓市场中回报率 >5% 的占比（plus5ToPlus10 + gePlus10） */
export function computeHighReturnMarketShare(
  distribution: ClosedMarketReturnDistribution | null | undefined
): number | null {
  if (!distribution) return null;
  const share = distribution.buckets
    .filter((bucket) => bucket.id === 'plus5ToPlus10' || bucket.id === 'gePlus10')
    .reduce((sum, bucket) => sum + (bucket.ratio ?? 0), 0);
  return roundMetric(share);
}

/**
 * 近窗已平仓回报：按事件汇总后计算
 * - 平均盈利率 = 事件收益率等权平均
 * - 总盈利率 = Σpnl / Σcost（同窗同样本）
 */
export function buildClosedMarketReturnDistribution(
  rows: DataApiPosition[],
  days = SMART_MONEY_PNL_WINDOW_DAYS,
  nowMs = Date.now()
): ClosedMarketReturnDistribution | null {
  const markets = aggregateClosedMarketsByCost(rows, days, nowMs);
  const ratios: number[] = [];
  let sumPnl = 0;
  let sumCost = 0;

  for (const market of markets) {
    if (!market.hasPnl || !(market.costBasisUsd > 0)) continue;
    const ratio = market.realizedPnl / market.costBasisUsd;
    if (!Number.isFinite(ratio)) continue;
    ratios.push(ratio);
    sumPnl += market.realizedPnl;
    sumCost += market.costBasisUsd;
  }

  if (ratios.length === 0) {
    return null;
  }

  const sorted = [...ratios].sort((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);
  const medianReturn =
    sorted.length % 2 === 0
      ? roundMetric((sorted[middleIndex - 1] + sorted[middleIndex]) / 2)
      : roundMetric(sorted[middleIndex]);
  const meanReturn = roundMetric(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);

  let totalReturnRatio: number | null = null;
  if (sumCost >= MIN_CLOSED_RETURN_COST_USD) {
    const raw = sumPnl / sumCost;
    if (Number.isFinite(raw) && Math.abs(raw) <= MAX_CLOSED_TOTAL_RETURN_RATIO) {
      totalReturnRatio = roundMetric(raw);
    }
  }

  return {
    sampledMarketCount: ratios.length,
    meanReturn,
    medianReturn,
    totalReturnRatio,
    totalRealizedPnl: roundMetric(sumPnl),
    totalCostBasisUsd: roundMetric(sumCost),
    buckets: CLOSED_MARKET_RETURN_DISTRIBUTION_RANGES.map((range) => {
      const count = ratios.filter(range.test).length;
      return {
        id: range.id,
        label: range.label,
        count,
        ratio: roundMetric(count / ratios.length),
      };
    }),
  };
}

/** 按市场汇总未平仓浮盈浮亏 */
export function summarizeOpenPositionPnlStats(rows: DataApiPosition[]): OpenPositionPnlStats {
  const summary = summarizePnlByMarket(rows, (row) =>
    extractPnlFromRow(row, ['cashPnl', 'unrealizedPnl', 'pnl', 'totalPnl'])
  );
  const underwaterMarketShare =
    summary.decisiveMarkets > 0
      ? (summary.decisiveMarkets - summary.winningMarkets) / summary.decisiveMarkets
      : null;

  let totalCostBasis = 0;
  let hasCost = false;
  for (const row of rows) {
    const cost = positionNotional(row);
    if (cost > 0) {
      totalCostBasis += cost;
      hasCost = true;
    }
  }

  return {
    sampleSize: summary.sampleSize,
    marketCount: summary.marketCount,
    decisiveMarkets: summary.decisiveMarkets,
    winningMarkets: summary.winningMarkets,
    marketWinRate: summary.marketWinRate,
    underwaterMarketShare,
    totalUnrealizedPnl: summary.totalPnl,
    totalCostBasis: hasCost ? roundMetric(totalCostBasis) : null,
  };
}

function positionNotional(row: DataApiPosition): number {
  // 对冲识别用成本名义，不用 currentValue：Yes/No 市价会反向偏离，等量对冲会被低估
  const size = numberFromUnknown(row.size) ?? 0;
  const avgPrice = numberFromUnknown(row.avgPrice);
  if (size > 0 && avgPrice != null && avgPrice > 0) return size * avgPrice;
  const currentValue = numberFromUnknown(row.currentValue);
  if (currentValue != null && currentValue > 0) return currentValue;
  const curPrice = numberFromUnknown(row.curPrice);
  if (size > 0 && curPrice != null && curPrice > 0) return size * curPrice;
  return Math.max(0, size);
}

function positionSize(row: DataApiPosition): number {
  return Math.max(0, numberFromUnknown(row.size) ?? 0);
}

type OutcomeSide = 'yes' | 'no' | 'other';

function classifyOutcomeSide(row: DataApiPosition): OutcomeSide {
  const outcome = typeof row.outcome === 'string' ? row.outcome.trim().toLowerCase() : '';
  if (outcome === 'yes' || outcome === 'y') return 'yes';
  if (outcome === 'no' || outcome === 'n') return 'no';
  if (row.outcomeIndex === 0) return 'yes';
  if (row.outcomeIndex === 1) return 'no';
  return 'other';
}

/**
 * 检测未平仓中「同一 conditionId 同时持有较接近的 Yes+No」对冲暴露。
 * 对冲名义 = 2 * min(yesNotional, noNotional)；占比相对全部未平仓名义。
 */
export function detectHedgedPairExposure(openRows: DataApiPosition[]): HedgedPairExposure {
  if (openRows.length === 0) {
    return { ...EMPTY_HEDGED_PAIR_EXPOSURE };
  }

  type SideAgg = { size: number; notional: number };
  const byMarket = new Map<string, { yes: SideAgg; no: SideAgg; otherNotional: number }>();
  let totalOpenNotional = 0;

  for (const row of openRows) {
    const conditionId =
      typeof row.conditionId === 'string' && row.conditionId ? row.conditionId : null;
    if (!conditionId) continue;
    const size = positionSize(row);
    const notional = positionNotional(row);
    if (size <= 0 && notional <= 0) continue;
    totalOpenNotional += notional;

    const bucket = byMarket.get(conditionId) ?? {
      yes: { size: 0, notional: 0 },
      no: { size: 0, notional: 0 },
      otherNotional: 0,
    };
    const side = classifyOutcomeSide(row);
    if (side === 'yes') {
      bucket.yes.size += size;
      bucket.yes.notional += notional;
    } else if (side === 'no') {
      bucket.no.size += size;
      bucket.no.notional += notional;
    } else {
      bucket.otherNotional += notional;
    }
    byMarket.set(conditionId, bucket);
  }

  let hedgedNotional = 0;
  let hedgedMarketCount = 0;

  for (const bucket of byMarket.values()) {
    if (bucket.yes.size <= 0 || bucket.no.size <= 0) continue;
    const sizeRatio =
      Math.min(bucket.yes.size, bucket.no.size) / Math.max(bucket.yes.size, bucket.no.size);
    const yesN = bucket.yes.notional;
    const noN = bucket.no.notional;
    const notionalRatio =
      yesN > 0 && noN > 0 ? Math.min(yesN, noN) / Math.max(yesN, noN) : 0;
    const balanced =
      sizeRatio >= HEDGED_PAIR_BALANCE_MIN_RATIO || notionalRatio >= HEDGED_PAIR_BALANCE_MIN_RATIO;
    if (!balanced) continue;

    const pairNotional = 2 * Math.min(yesN, noN);
    if (pairNotional <= 0) continue;
    hedgedNotional += pairNotional;
    hedgedMarketCount += 1;
  }

  return {
    hedgedPairShare:
      totalOpenNotional > 0 ? roundMetric(Math.min(1, hedgedNotional / totalOpenNotional)) : null,
    hedgedMarketCount,
    hedgedNotional: roundMetric(hedgedNotional) ?? 0,
    totalOpenNotional: roundMetric(totalOpenNotional) ?? 0,
  };
}

export function computeCompositeMarketWinRate(
  closed: ClosedPositionPnlStats | null,
  open: OpenPositionPnlStats | null,
  minDecisive = MIN_DECISIVE_MARKETS_FOR_WIN_RATE
): number | null {
  // open=null 表示未平仓接口失败：禁止退回「仅已平仓」100% 假象（只平掉盈利单）
  if (open == null) {
    return null;
  }

  const closedDecisive = closed?.decisiveMarkets ?? 0;
  const openDecisive = open.decisiveMarkets;
  const totalDecisive = closedDecisive + openDecisive;
  const totalWins = (closed?.winningMarkets ?? 0) + open.winningMarkets;

  if (totalDecisive >= minDecisive) {
    return totalWins / totalDecisive;
  }
  if (
    open.sampleSize === 0 &&
    closedDecisive >= minDecisive &&
    closed?.marketWinRate != null
  ) {
    return closed.marketWinRate;
  }
  if (openDecisive >= minDecisive && open.marketWinRate != null) {
    return open.marketWinRate;
  }
  return null;
}

export function buildPositionPnlStats(
  closed: ClosedPositionPnlStats | null,
  open: OpenPositionPnlStats | null,
  openRows: DataApiPosition[] = []
): PositionPnlStats {
  const hedgedPairExposure =
    open == null
      ? null
      : openRows.length > 0
        ? detectHedgedPairExposure(openRows)
        : { ...EMPTY_HEDGED_PAIR_EXPOSURE };
  return {
    closed,
    open,
    compositeMarketWinRate: computeCompositeMarketWinRate(closed, open),
    hedgedPairExposure,
  };
}

export async function fetchClosedPositionPnlStats(wallet: string): Promise<ClosedPositionPnlStats | null> {
  try {
    const { rows } = await fetchDataApiClosedPositions(wallet, {
      limit: 50,
      maxPages: CLOSED_POSITIONS_DEEP_MAX_PAGES,
      windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
      totalBudgetMs: CLOSED_POSITIONS_TOTAL_BUDGET_MS,
    });
    if (rows.length === 0) return null;
    return summarizeClosedPositionPnlStats(rows);
  } catch {
    return null;
  }
}

export async function fetchOpenPositionPnlStats(wallet: string): Promise<OpenPositionPnlStats | null> {
  try {
    const rows = await fetchDataApiPositions(wallet, { limit: 500 });
    if (rows.length === 0) return { ...EMPTY_OPEN_POSITION_STATS };
    return summarizeOpenPositionPnlStats(rows);
  } catch {
    return null;
  }
}

export async function fetchPositionPnlStats(wallet: string): Promise<PositionPnlStats> {
  const context = await fetchPositionPnlContext(wallet);
  return context.stats;
}

export async function fetchPositionPnlContext(
  wallet: string,
  signalOrOptions?:
    | AbortSignal
    | {
        signal?: AbortSignal;
        skipOpenPositions?: boolean;
        /** 注入预热 closed；跳过现场翻页 */
        closedOverride?: ClosedPositionsFetchResult | null;
        /** 现场拉取时的 maxPages（默认 Deep 80） */
        maxPages?: number;
      }
): Promise<PositionPnlContext> {
  const options =
    signalOrOptions instanceof AbortSignal || signalOrOptions == null
      ? { signal: signalOrOptions ?? undefined, skipOpenPositions: false }
      : signalOrOptions;
  const signal = options.signal;
  const shouldSkipOpen = options.skipOpenPositions === true;
  const closedOverride = options.closedOverride;

  const fetchClosed = async () => {
    if (closedOverride != null) {
      return closedOverride;
    }
    const opts = {
      limit: 50,
      maxPages: options.maxPages ?? CLOSED_POSITIONS_DEEP_MAX_PAGES,
      windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
      totalBudgetMs: CLOSED_POSITIONS_TOTAL_BUDGET_MS,
      signal,
    } as const;
    try {
      return await fetchDataApiClosedPositions(wallet, opts);
    } catch (error) {
      // 批量 Deep 时偶发 429/超时：失败不伪装成空列表，重试一次
      if (signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return fetchDataApiClosedPositions(wallet, opts);
    }
  };

  const [closedRowsResult, openRowsResult] = await Promise.allSettled([
    fetchClosed(),
    shouldSkipOpen
      ? Promise.resolve([] as Awaited<ReturnType<typeof fetchDataApiPositions>>)
      : fetchDataApiPositions(wallet, { limit: 500, signal }),
  ]);

  const closedFetchOk = closedRowsResult.status === 'fulfilled';
  const openFetchOk = shouldSkipOpen ? true : openRowsResult.status === 'fulfilled';
  const closedFetch = closedFetchOk ? closedRowsResult.value : null;
  const closedRows = closedFetch?.rows ?? [];
  const closedSample = closedFetch?.meta ?? null;
  const openRows =
    shouldSkipOpen ? [] : openFetchOk && openRowsResult.status === 'fulfilled' ? openRowsResult.value : [];
  const closedFetchError =
    closedRowsResult.status === 'rejected'
      ? closedRowsResult.reason instanceof Error
        ? closedRowsResult.reason.message
        : String(closedRowsResult.reason)
      : null;
  const closed =
    closedFetchOk && closedRows.length > 0
      ? summarizeClosedPositionPnlStats(closedRows)
      : null;
  const open = shouldSkipOpen
    ? null
    : openFetchOk
      ? openRows.length === 0
        ? { ...EMPTY_OPEN_POSITION_STATS }
        : summarizeOpenPositionPnlStats(openRows)
      : null;

  return {
    closedRows,
    openRows,
    stats: buildPositionPnlStats(closed, open, openRows),
    closedFetchOk,
    openFetchOk,
    closedFetchError,
    closedSample,
  };
}
