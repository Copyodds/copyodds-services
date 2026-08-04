import type { DataApiPosition } from '../polymarket/polymarketData';
import type { PolymarketTokenMarketMetadata } from '../polymarket/markets';
import { fetchMarketMetadataForClobTokenIds } from '../polymarket/markets';

const DOMINANT_CATEGORY_MIN_SHARE = 0.4;
const MAX_CATEGORY_TOKEN_LOOKUP = 120;

export type SmartMoneyMarketCategoryBucket = {
  category: string;
  rawCategory: string;
  share: number;
  weight: number;
  positionCount: number;
};

export type SmartMoneyMarketCategoryProfile = {
  dominantCategory: string;
  dominantShare: number | null;
  diversified: boolean;
  classifiedPositionCount: number;
  uniqueTokenCount: number;
  sampledTokenCount: number;
  usedTokenLookupCap: boolean;
  buckets: SmartMoneyMarketCategoryBucket[];
};

function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeMarketCategory(category: string | null | undefined): string | null {
  if (typeof category !== 'string') return null;
  const trimmed = category.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toUpperCase();
}

function resolvePositionWeight(row: DataApiPosition): number {
  const currentValue = numberFromUnknown(row.currentValue);
  if (currentValue != null && Math.abs(currentValue) >= 1) return Math.abs(currentValue);

  const realizedPnl = numberFromUnknown((row as Record<string, unknown>).realizedPnl);
  if (realizedPnl != null && Math.abs(realizedPnl) >= 1) return Math.abs(realizedPnl);

  const cashPnl = numberFromUnknown((row as Record<string, unknown>).cashPnl);
  if (cashPnl != null && Math.abs(cashPnl) >= 1) return Math.abs(cashPnl);

  const totalPnl = numberFromUnknown((row as Record<string, unknown>).totalPnl);
  if (totalPnl != null && Math.abs(totalPnl) >= 1) return Math.abs(totalPnl);

  const price = numberFromUnknown(row.curPrice) ?? numberFromUnknown(row.avgPrice);
  if (price != null && row.size > 0) {
    const notion = Math.abs(price * row.size);
    if (notion >= 1) return notion;
  }

  if (row.size > 0) return row.size;
  return 1;
}

function mergePositionRows(
  openRows: DataApiPosition[],
  closedRows: DataApiPosition[]
): DataApiPosition[] {
  return [...openRows, ...closedRows].filter((row) => typeof row.asset === 'string' && /^\d+$/.test(row.asset.trim()));
}

function buildCategoryProfileFromRows(
  rows: DataApiPosition[],
  metadataByTokenId: Map<string, Pick<PolymarketTokenMarketMetadata, 'category'>>,
  options?: { uniqueTokenCount?: number; sampledTokenCount?: number }
): SmartMoneyMarketCategoryProfile | null {
  const bucketMap = new Map<string, { rawCategory: string; weight: number; positionCount: number }>();
  let totalWeight = 0;
  let classifiedPositionCount = 0;

  for (const row of rows) {
    const tokenId = row.asset.trim();
    const metadata = metadataByTokenId.get(tokenId);
    const rawCategory = metadata?.category?.trim() ?? '';
    const normalizedCategory = normalizeMarketCategory(rawCategory);
    if (!normalizedCategory) continue;

    const weight = resolvePositionWeight(row);
    const existing = bucketMap.get(normalizedCategory) ?? {
      rawCategory,
      weight: 0,
      positionCount: 0,
    };
    existing.weight += weight;
    existing.positionCount += 1;
    bucketMap.set(normalizedCategory, existing);
    totalWeight += weight;
    classifiedPositionCount += 1;
  }

  if (bucketMap.size === 0 || totalWeight <= 0) {
    return null;
  }

  const buckets: SmartMoneyMarketCategoryBucket[] = [...bucketMap.entries()]
    .map(([category, value]) => ({
      category,
      rawCategory: value.rawCategory,
      weight: roundMetric(value.weight),
      share: roundMetric(value.weight / totalWeight),
      positionCount: value.positionCount,
    }))
    .sort((left, right) => {
      if (right.share !== left.share) return right.share - left.share;
      if (right.positionCount !== left.positionCount) return right.positionCount - left.positionCount;
      return left.category.localeCompare(right.category);
    });

  const top = buckets[0]!;
  const diversified = top.share < DOMINANT_CATEGORY_MIN_SHARE;
  return {
    dominantCategory: diversified ? 'DIVERSIFIED' : top.category,
    dominantShare: diversified ? top.share : top.share,
    diversified,
    classifiedPositionCount,
    uniqueTokenCount: options?.uniqueTokenCount ?? new Set(rows.map((row) => row.asset.trim())).size,
    sampledTokenCount: options?.sampledTokenCount ?? metadataByTokenId.size,
    usedTokenLookupCap:
      (options?.sampledTokenCount ?? metadataByTokenId.size) <
      (options?.uniqueTokenCount ?? new Set(rows.map((row) => row.asset.trim())).size),
    buckets,
  };
}

export async function buildSmartMoneyMarketCategoryProfile(params: {
  openRows: DataApiPosition[];
  closedRows: DataApiPosition[];
}): Promise<SmartMoneyMarketCategoryProfile | null> {
  const rows = mergePositionRows(params.openRows, params.closedRows);
  if (rows.length === 0) return null;

  const uniqueTokenIds = [...new Set(rows.map((row) => row.asset.trim()))];
  const sampledTokenIds = uniqueTokenIds.slice(0, MAX_CATEGORY_TOKEN_LOOKUP);
  const metadata = await fetchMarketMetadataForClobTokenIds(sampledTokenIds, { timeoutMs: 4_000 });
  return buildCategoryProfileFromRows(rows, metadata, {
    uniqueTokenCount: uniqueTokenIds.length,
    sampledTokenCount: sampledTokenIds.length,
  });
}

export const smartMoneyMarketCategoryLogic = {
  buildCategoryProfileFromRows,
  normalizeMarketCategory,
  resolvePositionWeight,
};
