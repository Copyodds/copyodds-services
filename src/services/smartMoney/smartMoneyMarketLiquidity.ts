import type { DataApiPosition } from '../polymarket/polymarketData';
import type { PolymarketTokenMarketMetadata } from '../polymarket/markets';
import { fetchMarketMetadataForClobTokenIds } from '../polymarket/markets';
import { smartMoneyMarketCategoryLogic } from './smartMoneyMarketCategory';

const MAX_LIQUIDITY_TOKEN_LOOKUP = 120;

export type SmartMoneyMarketLiquidityProfile = {
  minMarketVolumeUsd: number;
  highVolumeMarketShare: number | null;
  lowVolumeMarketShare: number | null;
  classifiedPositionCount: number;
  totalPositionCount: number;
  classificationShare: number | null;
  highVolumePositionCount: number;
  lowVolumePositionCount: number;
  uniqueTokenCount: number;
  sampledTokenCount: number;
  usedTokenLookupCap: boolean;
};

function roundMetric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function mergePositionRows(
  openRows: DataApiPosition[],
  closedRows: DataApiPosition[]
): DataApiPosition[] {
  return [...openRows, ...closedRows].filter(
    (row) => typeof row.asset === 'string' && /^\d+$/.test(row.asset.trim())
  );
}

function buildLiquidityProfileFromRows(
  rows: DataApiPosition[],
  metadataByTokenId: Map<string, Pick<PolymarketTokenMarketMetadata, 'volumeNum'>>,
  minMarketVolumeUsd: number,
  options?: { uniqueTokenCount?: number; sampledTokenCount?: number }
): SmartMoneyMarketLiquidityProfile | null {
  if (rows.length === 0) return null;

  let totalWeight = 0;
  let highVolumeWeight = 0;
  let lowVolumeWeight = 0;
  let classifiedPositionCount = 0;
  let highVolumePositionCount = 0;
  let lowVolumePositionCount = 0;

  for (const row of rows) {
    const tokenId = row.asset.trim();
    const metadata = metadataByTokenId.get(tokenId);
    const volumeNum = metadata?.volumeNum ?? null;
    if (volumeNum == null || !Number.isFinite(volumeNum)) continue;

    const weight = smartMoneyMarketCategoryLogic.resolvePositionWeight(row);
    totalWeight += weight;
    classifiedPositionCount += 1;

    if (volumeNum >= minMarketVolumeUsd) {
      highVolumeWeight += weight;
      highVolumePositionCount += 1;
    } else {
      lowVolumeWeight += weight;
      lowVolumePositionCount += 1;
    }
  }

  const highVolumeMarketShare =
    totalWeight > 0 ? roundMetric(highVolumeWeight / totalWeight) : null;
  const lowVolumeMarketShare =
    totalWeight > 0 ? roundMetric(lowVolumeWeight / totalWeight) : null;
  const classificationShare =
    rows.length > 0 ? roundMetric(classifiedPositionCount / rows.length) : null;

  return {
    minMarketVolumeUsd,
    highVolumeMarketShare,
    lowVolumeMarketShare,
    classifiedPositionCount,
    totalPositionCount: rows.length,
    classificationShare,
    highVolumePositionCount,
    lowVolumePositionCount,
    uniqueTokenCount: options?.uniqueTokenCount ?? new Set(rows.map((row) => row.asset.trim())).size,
    sampledTokenCount: options?.sampledTokenCount ?? metadataByTokenId.size,
    usedTokenLookupCap:
      (options?.sampledTokenCount ?? metadataByTokenId.size) <
      (options?.uniqueTokenCount ?? new Set(rows.map((row) => row.asset.trim())).size),
  };
}

export function extractMarketLiquidityProfileFromScoreExplain(
  scoreExplain: unknown
): SmartMoneyMarketLiquidityProfile | null {
  if (!scoreExplain || typeof scoreExplain !== 'object') return null;
  const profile = (scoreExplain as { marketLiquidityProfile?: unknown }).marketLiquidityProfile;
  if (!profile || typeof profile !== 'object') return null;

  const record = profile as Record<string, unknown>;
  const minMarketVolumeUsd = Number(record.minMarketVolumeUsd);
  if (!Number.isFinite(minMarketVolumeUsd)) return null;

  const toMetric = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
  };
  const toCount = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    minMarketVolumeUsd,
    highVolumeMarketShare: toMetric(record.highVolumeMarketShare),
    lowVolumeMarketShare: toMetric(record.lowVolumeMarketShare),
    classifiedPositionCount: toCount(record.classifiedPositionCount),
    totalPositionCount: toCount(record.totalPositionCount),
    classificationShare: toMetric(record.classificationShare),
    highVolumePositionCount: toCount(record.highVolumePositionCount),
    lowVolumePositionCount: toCount(record.lowVolumePositionCount),
    uniqueTokenCount: toCount(record.uniqueTokenCount),
    sampledTokenCount: toCount(record.sampledTokenCount),
    usedTokenLookupCap: record.usedTokenLookupCap === true,
  };
}

export async function buildSmartMoneyMarketLiquidityProfile(params: {
  openRows: DataApiPosition[];
  closedRows: DataApiPosition[];
  minMarketVolumeUsd?: number;
}): Promise<SmartMoneyMarketLiquidityProfile | null> {
  const rows = mergePositionRows(params.openRows, params.closedRows);
  if (rows.length === 0) return null;

  const minMarketVolumeUsd = params.minMarketVolumeUsd ?? 0;
  const uniqueTokenIds = [...new Set(rows.map((row) => row.asset.trim()))];
  const sampledTokenIds = uniqueTokenIds.slice(0, MAX_LIQUIDITY_TOKEN_LOOKUP);
  const metadata = await fetchMarketMetadataForClobTokenIds(sampledTokenIds, { timeoutMs: 4_000 });
  return buildLiquidityProfileFromRows(rows, metadata, minMarketVolumeUsd, {
    uniqueTokenCount: uniqueTokenIds.length,
    sampledTokenCount: sampledTokenIds.length,
  });
}

export const smartMoneyMarketLiquidityLogic = {
  buildLiquidityProfileFromRows,
  mergePositionRows,
};
