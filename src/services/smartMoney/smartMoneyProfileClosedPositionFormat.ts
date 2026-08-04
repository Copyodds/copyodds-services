import {
  extractClosedPositionAtMs,
  type DataApiPosition,
} from '../polymarket/polymarketData';

export type SmartMoneyProfileClosedPositionItem = {
  asset: string;
  conditionId: string;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  totalBought: number | null;
  avgPrice: number | null;
  realizedPnl: number | null;
  realizedPnlRatio: number | null;
  closedAt: string | null;
  endDate: string | null;
};

export type SmartMoneyProfileClosedPositionsSummary = {
  positionCount: number;
  totalRealizedPnl: number | null;
  sampleRealizedPnl: number | null;
  complete: boolean;
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

function realizedPnlFromRow(record: Record<string, unknown>): number | null {
  for (const key of ['realizedPnl', 'pnl', 'cashPnl', 'totalPnl', 'profit']) {
    const value = numberFromUnknown(record[key]);
    if (value != null) return value;
  }
  return null;
}

export function formatSmartMoneyProfileClosedPosition(
  row: DataApiPosition
): SmartMoneyProfileClosedPositionItem {
  const record = row as Record<string, unknown>;
  const totalBought = numberFromUnknown(record.totalBought) ?? numberFromUnknown(row.size);
  const avgPrice = numberFromUnknown(row.avgPrice);
  const realizedPnl = realizedPnlFromRow(record);
  const explicitRatio =
    numberFromUnknown(record.percentRealizedPnl) ?? numberFromUnknown(record.percentPnl);
  const costBasis =
    totalBought != null && totalBought > 0 && avgPrice != null && avgPrice > 0
      ? totalBought * avgPrice
      : null;
  const realizedPnlRatio =
    explicitRatio != null
      ? Math.abs(explicitRatio) > 1
        ? explicitRatio / 100
        : explicitRatio
      : realizedPnl != null && costBasis != null && costBasis > 0
        ? realizedPnl / costBasis
        : null;
  const closedAtMs = extractClosedPositionAtMs(row);

  return {
    asset: row.asset,
    conditionId: row.conditionId,
    title: typeof row.title === 'string' ? row.title : null,
    slug: typeof row.slug === 'string' ? row.slug : null,
    eventSlug: typeof record.eventSlug === 'string' ? record.eventSlug : null,
    outcome: typeof row.outcome === 'string' ? row.outcome : null,
    outcomeIndex: numberFromUnknown(row.outcomeIndex),
    totalBought: roundMetric(totalBought),
    avgPrice: roundMetric(avgPrice),
    realizedPnl: roundMetric(realizedPnl),
    realizedPnlRatio: roundMetric(realizedPnlRatio),
    closedAt: closedAtMs != null ? new Date(closedAtMs).toISOString() : null,
    endDate: typeof row.endDate === 'string' ? row.endDate : null,
  };
}

export function summarizeSmartMoneyProfileClosedPositions(
  positions: SmartMoneyProfileClosedPositionItem[],
  partial: boolean
): SmartMoneyProfileClosedPositionsSummary {
  const hasRealizedPnl = positions.some((row) => row.realizedPnl != null);
  const sampleRealizedPnl = hasRealizedPnl
    ? roundMetric(
        positions.reduce((sum, row) => sum + (row.realizedPnl ?? 0), 0)
      )
    : null;
  return {
    positionCount: positions.length,
    totalRealizedPnl: partial ? null : sampleRealizedPnl,
    sampleRealizedPnl,
    complete: !partial,
  };
}
