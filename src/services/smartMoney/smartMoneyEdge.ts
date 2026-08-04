/**
 * 预测能力 Edge（方案 §4）：从已平仓 positions 纯 CPU 派生，不增加上游 HTTP。
 * edge_i ≈ 结算结果(0|1) − 入场均价；样本显著性收缩防「赌对一次」。
 */
import type { DataApiPosition } from '../polymarket/polymarketData';

export const EDGE_SHRINK_K = 15;
export const EDGE_MIN_SAMPLE_FOR_SA = 8;

export type SmartMoneyEdgeMarket = {
  conditionId: string;
  avgPrice: number;
  edge: number;
  notionalUsd: number;
  won: boolean;
};

export type SmartMoneyEdgeResult = {
  edgeScore: number;
  edgeBar: number | null;
  edgeSampleN: number;
  positiveEdgeShare: number | null;
  shrink: number;
  markets: SmartMoneyEdgeMarket[];
  maxWinTradeUsd: number | null;
  maxLossTradeUsd: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function numberFromUnknown(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractRealizedPnl(row: DataApiPosition): number | null {
  const record = row as Record<string, unknown>;
  for (const key of ['realizedPnl', 'pnl', 'cashPnl', 'totalPnl', 'profit'] as const) {
    const n = numberFromUnknown(record[key]);
    if (n != null) return n;
  }
  return null;
}

function extractCostBasis(row: DataApiPosition, avgPrice: number): number | null {
  const record = row as Record<string, unknown>;
  const initialValue = numberFromUnknown(record.initialValue);
  if (initialValue != null && initialValue > 0) return initialValue;
  const totalBought = numberFromUnknown(record.totalBought);
  if (totalBought != null && totalBought > 0 && avgPrice > 0) {
    return totalBought * avgPrice;
  }
  const size = numberFromUnknown(row.size) ?? 0;
  if (size > 0 && avgPrice > 0) return size * avgPrice;
  return null;
}

/**
 * 二元市场近似：赢 → 结算 1，输 → 结算 0；edge = 结算 − avgPrice。
 * 用已实现盈亏符号判断胜负；avgPrice 必须在 (0,1)。
 */
export function computeMarketEntryEdge(row: DataApiPosition): SmartMoneyEdgeMarket | null {
  const avgPrice = numberFromUnknown(row.avgPrice);
  if (avgPrice == null || avgPrice <= 0 || avgPrice >= 1) return null;
  const realizedPnl = extractRealizedPnl(row);
  if (realizedPnl == null || !Number.isFinite(realizedPnl)) return null;
  // 接近零的盈亏无法判定胜负
  if (Math.abs(realizedPnl) < 1e-9) return null;

  const won = realizedPnl > 0;
  const edge = won ? 1 - avgPrice : -avgPrice;
  const costBasis = extractCostBasis(row, avgPrice) ?? Math.abs(realizedPnl / Math.max(Math.abs(edge), 1e-6));
  const conditionId = String(row.conditionId || row.asset || '').trim();
  if (!conditionId) return null;

  return {
    conditionId,
    avgPrice,
    edge: clamp(edge, -1, 1),
    notionalUsd: Math.max(0, costBasis),
    won,
  };
}

function aggregateByCondition(markets: SmartMoneyEdgeMarket[]): SmartMoneyEdgeMarket[] {
  const byId = new Map<string, SmartMoneyEdgeMarket>();
  for (const m of markets) {
    const prev = byId.get(m.conditionId);
    if (!prev) {
      byId.set(m.conditionId, { ...m });
      continue;
    }
    const totalNotional = prev.notionalUsd + m.notionalUsd;
    const edge =
      totalNotional > 0
        ? (prev.edge * prev.notionalUsd + m.edge * m.notionalUsd) / totalNotional
        : prev.edge;
    byId.set(m.conditionId, {
      conditionId: m.conditionId,
      avgPrice:
        totalNotional > 0
          ? (prev.avgPrice * prev.notionalUsd + m.avgPrice * m.notionalUsd) / totalNotional
          : prev.avgPrice,
      edge: clamp(edge, -1, 1),
      notionalUsd: totalNotional,
      won: edge >= 0,
    });
  }
  return [...byId.values()];
}

/**
 * 名义额加权平均 Edge + 收缩：EdgeScore = 50 + 50 * shrink * edge_bar
 */
export function computeSmartMoneyEdge(
  closedRows: DataApiPosition[] | null | undefined,
  options?: { shrinkK?: number; maxNotionalCapUsd?: number }
): SmartMoneyEdgeResult {
  const shrinkK = options?.shrinkK ?? EDGE_SHRINK_K;
  const maxNotionalCapUsd = options?.maxNotionalCapUsd ?? 50_000;
  const raw = (closedRows ?? [])
    .map((row) => computeMarketEntryEdge(row))
    .filter((m): m is SmartMoneyEdgeMarket => m != null);
  const markets = aggregateByCondition(raw);

  let maxWin: number | null = null;
  let maxLoss: number | null = null;
  for (const row of closedRows ?? []) {
    const pnl = extractRealizedPnl(row);
    if (pnl == null) continue;
    if (pnl > 0) maxWin = maxWin == null ? pnl : Math.max(maxWin, pnl);
    if (pnl < 0) maxLoss = maxLoss == null ? pnl : Math.min(maxLoss, pnl);
  }

  if (markets.length === 0) {
    return {
      edgeScore: 50,
      edgeBar: null,
      edgeSampleN: 0,
      positiveEdgeShare: null,
      shrink: 0,
      markets: [],
      maxWinTradeUsd: maxWin,
      maxLossTradeUsd: maxLoss,
    };
  }

  let weightSum = 0;
  let weightedEdge = 0;
  let positiveCount = 0;
  for (const m of markets) {
    const w = Math.min(m.notionalUsd, maxNotionalCapUsd);
    if (w <= 0) continue;
    weightSum += w;
    weightedEdge += m.edge * w;
    if (m.edge > 0) positiveCount += 1;
  }

  const edgeBar = weightSum > 0 ? clamp(weightedEdge / weightSum, -1, 1) : null;
  const n = markets.length;
  const shrink = n / (n + Math.max(1, shrinkK));
  const edgeScore =
    edgeBar == null ? 50 : roundScore(clamp(50 + 50 * shrink * edgeBar, 0, 100));

  return {
    edgeScore,
    edgeBar: edgeBar == null ? null : roundScore(edgeBar * 1000) / 1000,
    edgeSampleN: n,
    positiveEdgeShare: roundScore(positiveCount / n),
    shrink: roundScore(shrink),
    markets,
    maxWinTradeUsd: maxWin,
    maxLossTradeUsd: maxLoss,
  };
}

export function hasEnoughEdgeSampleForSA(edgeSampleN: number): boolean {
  return edgeSampleN >= EDGE_MIN_SAMPLE_FOR_SA;
}
