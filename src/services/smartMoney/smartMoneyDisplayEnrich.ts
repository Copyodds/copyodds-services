/**
 * Deep-Enrich E5/E6：榜内火花图 + Recent20 / 近窗最高盈利（写入 scoreExplain，失败不踢榜）。
 * 纯函数无顶层 prisma，便于无库仿真/单测 import。
 */
import { fetchDataApiClosedPositions } from '../polymarket/polymarketData';

export type SparklinePoint = { t: number; v: number };

export type RecentMarketItem = {
  conditionId: string | null;
  title: string | null;
  realizedPnl: number;
};

export function downsampleSparkline(
  points: Array<{ ts: Date; value: { toNumber?: () => number } | number | string }>,
  maxPoints = 24
): SparklinePoint[] {
  if (points.length === 0) return [];
  const values = points.map((p) => {
    const raw = p.value;
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number(raw)
          : typeof raw?.toNumber === 'function'
            ? raw.toNumber()
            : Number(raw);
    return {
      t: p.ts.getTime(),
      v: Number.isFinite(n) ? Math.round(n * 100) / 100 : 0,
    };
  });
  if (values.length <= maxPoints) return values;
  const out: SparklinePoint[] = [];
  const step = (values.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * step);
    out.push(values[Math.min(idx, values.length - 1)]!);
  }
  return out;
}

/** 1W 曲线日桶最大单日盈利 */
export function computeBiggestWinRecentFromCurve(
  points: Array<{ ts: Date; value: { toNumber?: () => number } | number | string }>
): number | null {
  if (points.length < 2) return null;
  const byDay = new Map<string, number>();
  for (const p of points) {
    const raw = p.value;
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number(raw)
          : typeof raw?.toNumber === 'function'
            ? raw.toNumber()
            : Number(raw);
    if (!Number.isFinite(n)) continue;
    const day = p.ts.toISOString().slice(0, 10);
    byDay.set(day, n);
  }
  const days = [...byDay.keys()].sort();
  let maxGain: number | null = null;
  for (let i = 1; i < days.length; i++) {
    const prev = byDay.get(days[i - 1]!)!;
    const cur = byDay.get(days[i]!)!;
    const gain = cur - prev;
    if (maxGain == null || gain > maxGain) maxGain = gain;
  }
  return maxGain == null ? null : Math.round(maxGain * 100) / 100;
}

function extractTitle(row: Record<string, unknown>): string | null {
  for (const key of ['title', 'market', 'question', 'slug']) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 160);
  }
  return null;
}

function extractConditionId(row: Record<string, unknown>): string | null {
  const v = row.conditionId ?? row.condition_id;
  return typeof v === 'string' && v ? v : null;
}

function extractRealizedPnl(row: Record<string, unknown>): number | null {
  for (const key of ['realizedPnl', 'pnl', 'cashPnl', 'totalPnl', 'profit']) {
    const v = row[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function getPrisma() {
  const { prisma } = await import('../../db.js');
  return prisma;
}

export async function buildSparklineFromDb(wallet: string): Promise<SparklinePoint[]> {
  const prisma = await getPrisma();
  const points = await prisma.traderCurvePoint.findMany({
    where: { wallet, curveType: 'PORTFOLIO_PNL_1W' },
    orderBy: { ts: 'asc' },
    take: 500,
    select: { ts: true, value: true },
  });
  return downsampleSparkline(points);
}

export async function buildBiggestWinRecentFromDb(wallet: string): Promise<number | null> {
  const prisma = await getPrisma();
  const points = await prisma.traderCurvePoint.findMany({
    where: { wallet, curveType: 'PORTFOLIO_PNL_1W' },
    orderBy: { ts: 'asc' },
    take: 500,
    select: { ts: true, value: true },
  });
  return computeBiggestWinRecentFromCurve(points);
}

export async function buildRecentMarketsTop(
  wallet: string,
  limit = 20
): Promise<RecentMarketItem[]> {
  try {
    const { rows } = await fetchDataApiClosedPositions(wallet, {
      limit: 50,
      maxPages: 4,
      windowDays: 365,
      totalBudgetMs: 30_000,
    });
    const mapped: RecentMarketItem[] = [];
    for (const row of rows) {
      const realizedPnl = extractRealizedPnl(row as Record<string, unknown>);
      if (realizedPnl == null) continue;
      mapped.push({
        conditionId: extractConditionId(row as Record<string, unknown>),
        title: extractTitle(row as Record<string, unknown>),
        realizedPnl: Math.round(realizedPnl * 100) / 100,
      });
    }
    mapped.sort((a, b) => Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl));
    return mapped.slice(0, limit);
  } catch {
    return [];
  }
}

export async function buildDisplayEnrichPayload(wallet: string): Promise<{
  sparkline: SparklinePoint[];
  biggestWinRecent: number | null;
  recentMarkets: RecentMarketItem[];
}> {
  const [sparkline, biggestWinRecent, recentMarkets] = await Promise.all([
    buildSparklineFromDb(wallet),
    buildBiggestWinRecentFromDb(wallet),
    buildRecentMarketsTop(wallet, 20),
  ]);
  return { sparkline, biggestWinRecent, recentMarkets };
}
