/**
 * 跟单不适配特征检测（高频 / 小仓 / 窄边 / 品类单一 / 机器人启发式）。
 * 仅基于 Deep 已拉取的 trades + positions，不额外打上游。
 */
import type { DataApiPosition } from '../polymarket/polymarketData';
import type { DataApiTrade } from '../polymarket/polymarketTrades';
import { normalizeTradeTimestampMs } from '../polymarket/polymarketTrades';
import { CONFIG } from '../../config/env';

export const COPY_UNSUITABLE_SOFT_FLAGS = [
  'MICRO_CLIP_TRADING',
  'NARROW_EDGE_ENTRY',
  'DUST_POSITION_SPRAY',
  'CATEGORY_MONOCULTURE',
] as const;

export type CopyUnsuitableSoftFlag = (typeof COPY_UNSUITABLE_SOFT_FLAGS)[number];

export type CopyUnsuitableDetectInput = {
  trades: DataApiTrade[] | null | undefined;
  openPositions: DataApiPosition[] | null | undefined;
  predictionCount: number | null | undefined;
  /** 账户大致天数；未知时用 null，仅跳过生涯密度规则 */
  accountAgeDays: number | null | undefined;
  tradesPerDay1D?: number | null;
  trades30d?: number | null;
  nowMs?: number;
};

export type CopyUnsuitableDetectResult = {
  flags: string[];
  metrics: {
    avgTradeNotionalUsd: number | null;
    narrowEdgeShare: number | null;
    medianOpenNotionalUsd: number | null;
    openPositionCount: number;
    dominantCategory: string | null;
    dominantCategoryShare: number | null;
    predictionsPerDay: number | null;
    softFlagCount: number;
  };
};

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function tradeNotionalUsd(trade: DataApiTrade): number | null {
  const size = numberFromUnknown(trade.size);
  const price = numberFromUnknown(trade.price);
  if (size == null || price == null) return null;
  const notional = Math.abs(size * price);
  return Number.isFinite(notional) && notional > 0 ? notional : null;
}

function positionNotionalUsd(row: DataApiPosition): number | null {
  const currentValue = numberFromUnknown(row.currentValue);
  if (currentValue != null && Math.abs(currentValue) > 0) return Math.abs(currentValue);
  const price = numberFromUnknown(row.curPrice) ?? numberFromUnknown(row.avgPrice);
  if (price != null && row.size > 0) {
    const notion = Math.abs(price * row.size);
    if (notion > 0) return notion;
  }
  return null;
}

/** 标题/slug 轻量聚类，避免 Gate 再打 Gamma */
export function inferTradeCategoryBucket(title?: string | null, slug?: string | null): string {
  const text = `${title ?? ''} ${slug ?? ''}`.toLowerCase();
  if (
    /temperature|highest temp|lowest temp|weather|\u00b0[cf]|°[cf]|daily high|daily low/.test(
      text
    )
  ) {
    return 'TEMPERATURE';
  }
  if (/bitcoin|btc|ethereum|eth\b|solana|crypto|dogecoin|xrp/.test(text)) return 'CRYPTO';
  if (
    /\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|ufc|soccer|premier league|la liga|champions league|tennis|golf/.test(
      text
    )
  ) {
    return 'SPORTS';
  }
  if (/election|president|trump|biden|senate|congress|poll|governor|parliament/.test(text)) {
    return 'POLITICS';
  }
  if (typeof slug === 'string' && slug.trim()) {
    const parts = slug
      .trim()
      .toLowerCase()
      .split(/[-_/]+/)
      .filter(Boolean)
      .slice(0, 2);
    if (parts.length > 0) return parts.join('_').toUpperCase();
  }
  return 'OTHER';
}

export function estimateAccountAgeDaysFromJoinText(
  joinedAtText: string | null | undefined,
  nowMs = Date.now()
): number | null {
  if (typeof joinedAtText !== 'string' || !joinedAtText.trim()) return null;
  const parsed = Date.parse(joinedAtText);
  if (!Number.isNaN(parsed)) {
    return Math.max(0, (nowMs - parsed) / (24 * 60 * 60 * 1000));
  }
  // "Mar 2026" / "March 2026"
  const monthYear = joinedAtText.trim().match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
  if (!monthYear) return null;
  const probe = Date.parse(`${monthYear[1]} 1, ${monthYear[2]}`);
  if (Number.isNaN(probe)) return null;
  return Math.max(0, (nowMs - probe) / (24 * 60 * 60 * 1000));
}

export function estimateAccountAgeDaysFromCurves(
  curves: Array<{ ts?: Date | string | null }> | null | undefined,
  nowMs = Date.now()
): number | null {
  if (!curves || curves.length === 0) return null;
  let minMs: number | null = null;
  for (const point of curves) {
    const raw = point.ts;
    const ms =
      raw instanceof Date
        ? raw.getTime()
        : typeof raw === 'string'
          ? Date.parse(raw)
          : Number.NaN;
    if (!Number.isFinite(ms)) continue;
    if (minMs == null || ms < minMs) minMs = ms;
  }
  if (minMs == null) return null;
  return Math.max(0, (nowMs - minMs) / (24 * 60 * 60 * 1000));
}

export function detectCopyUnsuitableFlags(
  input: CopyUnsuitableDetectInput
): CopyUnsuitableDetectResult {
  const nowMs = input.nowMs ?? Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const trades = input.trades ?? [];
  const openPositions = input.openPositions ?? [];
  const flags: string[] = [];

  const recentTrades = trades.filter((trade) => {
    const ts = normalizeTradeTimestampMs(trade.timestamp);
    return ts != null && ts >= nowMs - 30 * dayMs;
  });
  const notionals = recentTrades
    .map(tradeNotionalUsd)
    .filter((value): value is number => value != null);
  const avgTradeNotionalUsd =
    notionals.length >= 8
      ? round4(notionals.reduce((sum, value) => sum + value, 0) / notionals.length)
      : null;

  let narrowEdgeShare: number | null = null;
  if (recentTrades.length >= 10) {
    let narrow = 0;
    let priced = 0;
    for (const trade of recentTrades) {
      const price = numberFromUnknown(trade.price);
      if (price == null) continue;
      priced += 1;
      if ((price >= 0.85 && price <= 0.99) || (price >= 0.01 && price <= 0.15)) {
        narrow += 1;
      }
    }
    if (priced >= 10) {
      narrowEdgeShare = round4(narrow / priced);
    }
  }

  const openNotionals = openPositions
    .map(positionNotionalUsd)
    .filter((value): value is number => value != null);
  const medianOpenNotionalUsd =
    openNotionals.length > 0 ? round4(median(openNotionals) ?? 0) : null;
  const openPositionCount = openPositions.length;

  const categoryWeights = new Map<string, number>();
  let categoryWeightTotal = 0;
  for (const row of openPositions) {
    const weight = positionNotionalUsd(row) ?? 1;
    const bucket = inferTradeCategoryBucket(row.title, row.slug);
    categoryWeights.set(bucket, (categoryWeights.get(bucket) ?? 0) + weight);
    categoryWeightTotal += weight;
  }
  let dominantCategory: string | null = null;
  let dominantCategoryShare: number | null = null;
  if (categoryWeightTotal > 0 && openPositionCount > 0) {
    for (const [category, weight] of categoryWeights) {
      const share = weight / categoryWeightTotal;
      if (dominantCategoryShare == null || share > dominantCategoryShare) {
        dominantCategory = category;
        dominantCategoryShare = round4(share);
      }
    }
  }

  const predictionCount =
    input.predictionCount != null && Number.isFinite(input.predictionCount)
      ? Math.max(0, input.predictionCount)
      : null;
  const accountAgeDays =
    input.accountAgeDays != null && Number.isFinite(input.accountAgeDays)
      ? Math.max(0, input.accountAgeDays)
      : null;
  const predictionsPerDay =
    predictionCount != null && accountAgeDays != null
      ? round4(predictionCount / Math.max(accountAgeDays, 7))
      : null;

  if (
    avgTradeNotionalUsd != null &&
    avgTradeNotionalUsd < CONFIG.smartMoneyMinAvgTradeNotionalUsd
  ) {
    flags.push('MICRO_CLIP_TRADING');
  }
  if (
    narrowEdgeShare != null &&
    narrowEdgeShare >= CONFIG.smartMoneyNarrowEdgeEntryShare
  ) {
    flags.push('NARROW_EDGE_ENTRY');
  }
  if (
    openPositionCount >= CONFIG.smartMoneyDustPositionMinCount &&
    medianOpenNotionalUsd != null &&
    medianOpenNotionalUsd < CONFIG.smartMoneyDustPositionMaxMedianUsd
  ) {
    flags.push('DUST_POSITION_SPRAY');
  }
  if (
    openPositionCount >= CONFIG.smartMoneyCategoryMonocultureMinPositions &&
    dominantCategoryShare != null &&
    dominantCategoryShare >= CONFIG.smartMoneyMaxCategoryShare
  ) {
    flags.push('CATEGORY_MONOCULTURE');
  }

  // 天气盘高度集中：即使仓位数未到 50，也视为 bot 倾向
  if (
    dominantCategory === 'TEMPERATURE' &&
    dominantCategoryShare != null &&
    dominantCategoryShare >= 0.85 &&
    openPositionCount >= 15
  ) {
    if (!flags.includes('CATEGORY_MONOCULTURE')) flags.push('CATEGORY_MONOCULTURE');
  }

  let shortHorizonShare: number | null = null;
  if (recentTrades.length >= 8) {
    let shortHits = 0;
    for (const trade of recentTrades) {
      const text = `${trade.title ?? ''} ${trade.slug ?? ''}`.toLowerCase();
      if (
        /up or down|up-or-down|\d+\s*min|\d+\s*minute|5-minute|15-minute|hourly/.test(text)
      ) {
        shortHits += 1;
      }
    }
    shortHorizonShare = round4(shortHits / recentTrades.length);
    if (shortHorizonShare >= 0.5) {
      flags.push('SHORT_HORIZON_MARKET');
    }
  }

  const softFlagCount = flags.filter((flag) =>
    (COPY_UNSUITABLE_SOFT_FLAGS as readonly string[]).includes(flag)
  ).length;

  const densityBot =
    predictionsPerDay != null &&
    predictionsPerDay > CONFIG.smartMoneyMaxPredictionsPerDayDensity;
  const weatherBot =
    dominantCategory === 'TEMPERATURE' &&
    dominantCategoryShare != null &&
    dominantCategoryShare >= 0.85 &&
    openPositionCount >= 15;
  if (densityBot || softFlagCount >= 2 || weatherBot) {
    flags.push('LIKELY_BOT');
  }

  // C2/C10.4：仅 30d 日均 >硬线 → HIGH_TRADE_FREQUENCY（软扣分）；软线~硬线 → ELEVATED
  if (
    input.trades30d != null &&
    Number.isFinite(input.trades30d)
  ) {
    const avg = input.trades30d / 30;
    if (avg > CONFIG.smartMoneyMaxTradesPerDayHard) {
      flags.push('HIGH_TRADE_FREQUENCY');
    } else if (avg > CONFIG.smartMoneyMaxTradesPerDay30dAvg) {
      flags.push('ELEVATED_TRADE_FREQUENCY');
    }
  }

  return {
    flags,
    metrics: {
      avgTradeNotionalUsd,
      narrowEdgeShare,
      medianOpenNotionalUsd,
      openPositionCount,
      dominantCategory,
      dominantCategoryShare,
      predictionsPerDay,
      softFlagCount,
    },
  };
}
