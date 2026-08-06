import { Router } from 'express';
import { z } from 'zod';
import { ethers } from 'ethers';
import { jwtAuth } from '../middlewares/jwtAuth';
import { Code, success, fail } from '../utils/response';
import { logger } from '../utils/logger';
import * as polymarketAuth from '../services/polymarket/polymarketAuth';
import { invalidateUserClobClientCache } from '../services/polymarket/polymarketClob';
import {
  listLatestCachedLeaderboardRows,
  OFFICIAL_LEADERBOARD_CATEGORIES,
} from '../services/polymarket/leaderboardCache';
import { listLatestPredictingTopRows } from '../services/polymarket/predictingTopLeaderboard';
import {
  listLatestPolymarketAnalyticsRows,
} from '../services/polymarket/polymarketAnalyticsLeaderboard';
import {
  getSmartMoneyRiskProfile,
  getSmartMoneyRiskProfileByDisplayName,
} from '../services/smartMoney/smartMoneyRiskProfile';
import {
  getSmartMoneyProfilePositions,
  SmartMoneyProfilePositionsFetchError,
} from '../services/smartMoney/smartMoneyProfilePositions';
import {
  getSmartMoneyProfileClosedPositions,
  SmartMoneyProfileClosedPositionsFetchError,
} from '../services/smartMoney/smartMoneyProfileClosedPositions';
import {
  getSmartMoneyProfileTrades,
  SmartMoneyProfileTradesFetchError,
} from '../services/smartMoney/smartMoneyProfileTrades';
import { authRateLimit } from '../middlewares/authRateLimit';
import {
  buildSmartMoneyCachedApiMeta,
  smartMoneyCachedDisplayWhere,
} from '../services/smartMoney/smartMoneyCachedQuery';
import { runDeepAnalyzeForWallet } from '../services/smartMoney/smartMoneyDeepAnalyze';
import { ingestSmartMoneyRawAddresses } from '../services/smartMoney/smartMoneyRawIngest';
import { checkSmartMoneyProfileRiskCopyPool } from '../services/smartMoney/smartMoneyProfileRiskCopyPoolGate';
import { readCanonicalBoardMetrics } from '../services/smartMoney/smartMoneyCanonicalBoardMetrics';
import { alignScoreExplainTraderProfileToBoard } from '../services/smartMoney/smartMoneyDisplayAuthority';
import { PolymarketProfileFetchError } from '../services/polymarket/polymarketProfile';
import { prisma } from '../db';
import { CONFIG } from '../config/env';
import { Prisma, type LeaderboardRow } from '../generated/prisma/client';
import { createConflictError } from '../utils/appError';
import { stableCacheKey } from '../utils/ttlMemoryCache';
import {
  smartMoneyCachedListCache,
  smartMoneyProfileRiskCache,
} from '../services/smartMoney/smartMoneyReadCache';
import {
  enqueueSmartMoneyAnalyze,
  evaluateSmartMoneyAddressFreshness,
  getSmartMoneyAnalyzeJob,
  SmartMoneyAnalyzeQueueError,
} from '../services/smartMoney/smartMoneyAnalyzeQueue';

const router = Router();

function parseQueryBoolean(val: unknown, defaultValue = false): boolean {
  if (val === undefined || val === null || val === '') return defaultValue;
  if (typeof val === 'boolean') return val;
  const s = String(Array.isArray(val) ? val[0] : val).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** DB 缓存行 → 与原先 Data API 直连时相近的 JSON 形状（供 /leaderboard 使用） */
function leaderboardRowToApiShape(r: LeaderboardRow) {
  return {
    rank: String(r.rank),
    proxyWallet: r.proxyWallet as `0x${string}`,
    userName: r.userName ?? undefined,
    vol: Number(r.vol),
    pnl: Number(r.pnl),
    profileImage: r.profileImage ?? undefined,
    xUsername: r.xUsername ?? undefined,
  };
}

function extractSmartMoneyTotalPnl(scoreExplain: Prisma.JsonValue | null): string | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return null;
  }
  const explain = scoreExplain as {
    resolvedMetrics?: { totalPnl?: unknown };
    rawMetrics?: { totalPnl?: unknown };
  };
  const resolved = explain.resolvedMetrics?.totalPnl;
  if (typeof resolved === 'number' && Number.isFinite(resolved)) return String(resolved);
  const raw = explain.rawMetrics?.totalPnl;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

function extractSmartMoneyTotalVolume(scoreExplain: Prisma.JsonValue | null): string | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return null;
  }
  const explain = scoreExplain as {
    resolvedMetrics?: { totalVolume?: unknown };
    rawMetrics?: { totalVolume?: unknown };
  };
  const resolved = numberOrNull(explain.resolvedMetrics?.totalVolume);
  if (resolved != null) return String(resolved);
  const raw = numberOrNull(explain.rawMetrics?.totalVolume);
  return raw != null ? String(raw) : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 从 scoreExplain 取展示指标（profitFactor、maxDrawdownPercent）。
 * 新口径：displayProfile 为权威（已平仓 PF / ALL×1Y MDD）；无亏损或不可测时禁止回退外部/曲线。
 * 旧榜行无 metricsSource 标记时，仍允许 externalPrimary → predicting.top → local 回退。
 */
function extractSmartMoneyExplainMetric(
  scoreExplain: Prisma.JsonValue | null,
  key: 'profitFactor' | 'maxDrawdownPercent'
): string | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return null;
  }
  const explain = scoreExplain as {
    displayProfile?: Record<string, unknown> | null;
    externalPrimary?: Record<string, unknown> | null;
    externalPredictingTop?: { all?: Record<string, unknown> | null } | null;
    externalMerged?: { all?: Record<string, unknown> | null } | null;
    externalLocalFallback?: { all?: Record<string, unknown> | null } | null;
  };
  const display = explain.displayProfile;
  const metricsSource =
    display?.metricsSource != null &&
    typeof display.metricsSource === 'object' &&
    !Array.isArray(display.metricsSource)
      ? (display.metricsSource as Record<string, unknown>)
      : null;

  if (key === 'profitFactor' && display != null) {
    if (display.profitFactorNoLoss === true) return null;
    if (metricsSource?.profitFactor === 'CLOSED_POSITIONS') {
      const n = numberOrNull(display.profitFactor);
      if (n == null) return null;
      if (n <= 0 || n > 100) return null;
      return String(n);
    }
  }
  if (key === 'maxDrawdownPercent' && display != null) {
    if (display.mddUnmeasurable === true) return null;
    if (metricsSource?.maxDrawdown === 'PORTFOLIO_PNL_ALL_1Y') {
      const n = numberOrNull(display.maxDrawdownPercent);
      if (n == null) return null;
      if (n < 0 || n > 5) return null;
      return String(n);
    }
  }

  const candidates = [
    display,
    explain.externalPrimary,
    explain.externalPredictingTop?.all,
    explain.externalMerged?.all,
    explain.externalLocalFallback?.all,
  ];
  for (const block of candidates) {
    if (block == null) continue;
    const n = numberOrNull(block[key]);
    if (n == null) continue;
    if (key === 'maxDrawdownPercent' && (n < 0 || n > 5)) continue;
    if (key === 'profitFactor' && (n <= 0 || n > 100)) continue;
    return String(n);
  }
  return null;
}

function extractSmartMoneyMarketCategoryProfile(scoreExplain: Prisma.JsonValue | null) {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return null;
  }
  const raw = (scoreExplain as { marketCategoryProfile?: unknown }).marketCategoryProfile;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw;
}

function extractSmartMoneyDisplayProfile(scoreExplain: Prisma.JsonValue | null) {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return null;
  }
  const display = (scoreExplain as { displayProfile?: unknown }).displayProfile;
  if (display != null && typeof display === 'object' && !Array.isArray(display)) {
    return display;
  }
  const copyability = (scoreExplain as { copyability?: { metrics?: Record<string, unknown> } })
    .copyability?.metrics;
  if (copyability == null) return null;
  return {
    backtestPnlUsd: copyability.backtestPnlUsd ?? null,
    copyLossRate: copyability.copyLossRate ?? null,
    medianHoldingSec: copyability.medianHoldingSec ?? null,
    avgHoldingSec: copyability.avgHoldingSec ?? null,
    lastTradeAt:
      typeof copyability.lastTradeAtMs === 'number'
        ? new Date(copyability.lastTradeAtMs).toISOString()
        : null,
    sampleWindowDays: copyability.sampleWindowDays ?? null,
    sampleTradeCount: copyability.sampleTradeCount ?? null,
    slippageBpsEffective: copyability.slippageBpsEffective ?? null,
  };
}

/** 补齐 displayProfile 中 PF 括号用的赢/亏次数（旧榜行可能仅有 profitFactor） */
function enrichSmartMoneyDisplayProfile(
  scoreExplain: Prisma.JsonValue | null,
  displayProfile: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return displayProfile;
  }
  const closed = (
    scoreExplain as {
      closedPositions?: {
        winningMarkets?: unknown;
        losingMarkets?: unknown;
        decisiveMarkets?: unknown;
      };
    }
  ).closedPositions;
  const base =
    displayProfile != null && typeof displayProfile === 'object' && !Array.isArray(displayProfile)
      ? { ...displayProfile }
      : {};
  const winFromClosed = numberOrNull(closed?.winningMarkets);
  const lossFromClosed = numberOrNull(closed?.losingMarkets);
  const decisive = numberOrNull(closed?.decisiveMarkets);
  if (base.winMarketCount == null && winFromClosed != null) {
    base.winMarketCount = winFromClosed;
  }
  if (base.winningMarkets == null && winFromClosed != null) {
    base.winningMarkets = winFromClosed;
  }
  if (base.lossMarketCount == null) {
    if (lossFromClosed != null) {
      base.lossMarketCount = lossFromClosed;
    } else if (decisive != null && winFromClosed != null) {
      base.lossMarketCount = Math.max(0, decisive - winFromClosed);
    }
  }
  if (base.losingMarkets == null && base.lossMarketCount != null) {
    base.losingMarkets = base.lossMarketCount;
  }
  return Object.keys(base).length > 0 ? base : null;
}

/** 聪明钱缓存列表：与排名重算语义一致，且保证分页稳定（null rank 永远在未排名段；并列时按钱包字典序） */
function computeDefaultSmartMoneyFollowerCount(wallet: string): number {
  let hash = 2166136261;
  for (const char of wallet.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return 18 + (Math.abs(hash) % 41);
}

function smartMoneyCachedOrderBy(
  eligibleOnly: boolean
): Prisma.SmartMoneyLeaderboardRowOrderByWithRelationInput[] {
  // §15：默认按已赋 rank（rank 重算已是档位优先 + TraderScore）
  return eligibleOnly
    ? [
        { rank: { sort: 'asc', nulls: 'last' } },
        { traderScore: { sort: 'desc', nulls: 'last' } },
        { score: 'desc' },
        { lastScoredAt: 'desc' },
        { wallet: 'asc' },
      ]
    : [
        { traderScore: { sort: 'desc', nulls: 'last' } },
        { score: 'desc' },
        { lastScoredAt: 'desc' },
        { wallet: 'asc' },
      ];
}

type SmartMoneyLeaderboardRankField =
  | 'rank'
  | 'sourceRankWeek'
  | 'sourceRankMonth'
  | 'sourceRankAll'
  | 'officialSourceRankWeek'
  | 'officialSourceRankMonth'
  | 'officialSourceRankAll'
  | 'externalSourceRankWeek'
  | 'externalSourceRankMonth'
  | 'externalSourceRankAll';

type SmartMoneyLeaderboardDecimalField =
  | 'score'
  | 'displayScore'
  | 'copyabilityScore'
  | 'rankScore'
  | 'pnlQuality'
  | 'consistencyScore'
  | 'activityScore'
  | 'holdingsValue'
  | 'totalPnl'
  | 'recentPnl7d'
  | 'maxDrawdownPercent'
  | 'externalWinRate'
  | 'externalSharpeRatio'
  | 'externalTotalReturn';

function optionalQueryFiniteNumber() {
  return z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    return typeof v === 'string' ? Number(v) : v;
  }, z.number().finite().optional());
}

function optionalQueryInt(min = 0) {
  return z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    return typeof v === 'string' ? Number(v) : v;
  }, z.number().int().min(min).optional());
}

function applySmartMoneyDecimalRangeFilter(
  where: Prisma.SmartMoneyLeaderboardRowWhereInput,
  field: SmartMoneyLeaderboardDecimalField,
  min?: number,
  max?: number
): void {
  if (min == null && max == null) return;
  const range = {
    ...(min != null ? { gte: new Prisma.Decimal(min) } : {}),
    ...(max != null ? { lte: new Prisma.Decimal(max) } : {}),
  };
  switch (field) {
    case 'score':
      where.score = { ...(where.score as Prisma.DecimalFilter | undefined), ...range };
      break;
    case 'pnlQuality':
      where.pnlQuality = { ...(where.pnlQuality as Prisma.DecimalFilter | undefined), ...range };
      break;
    case 'consistencyScore':
      where.consistencyScore = {
        ...(where.consistencyScore as Prisma.DecimalFilter | undefined),
        ...range,
      };
      break;
    case 'activityScore':
      where.activityScore = { ...(where.activityScore as Prisma.DecimalFilter | undefined), ...range };
      break;
    case 'holdingsValue':
      where.holdingsValue = {
        ...(where.holdingsValue as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
    case 'totalPnl':
      where.totalPnl = {
        ...(where.totalPnl as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
    case 'externalWinRate':
      where.externalWinRate = {
        ...(where.externalWinRate as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
    case 'externalSharpeRatio':
      where.externalSharpeRatio = {
        ...(where.externalSharpeRatio as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
    case 'externalTotalReturn':
      where.externalTotalReturn = {
        ...(where.externalTotalReturn as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
    case 'copyabilityScore':
      where.copyabilityScore = {
        ...(where.copyabilityScore as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
    case 'displayScore':
      where.displayScore = {
        ...(where.displayScore as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
    case 'recentPnl7d':
      where.recentPnl7d = {
        ...(where.recentPnl7d as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
    case 'maxDrawdownPercent':
      where.maxDrawdownPercent = {
        ...(where.maxDrawdownPercent as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
    case 'rankScore':
      where.rankScore = {
        ...(where.rankScore as Prisma.DecimalNullableFilter | undefined),
        ...range,
      };
      break;
  }
}

/** 名次上限筛选：与 topLimit 叠加时取更严的一侧；null 视为不命中 */
function mergeSmartMoneyMaxRankFilter(
  where: Prisma.SmartMoneyLeaderboardRowWhereInput,
  field: SmartMoneyLeaderboardRankField,
  maxRank?: number
): void {
  if (maxRank == null) return;
  const existing = where[field] as Prisma.IntNullableFilter | undefined;
  const existingLte =
    existing?.lte != null && typeof existing.lte === 'number' ? existing.lte : null;
  const lte = existingLte != null ? Math.min(existingLte, maxRank) : maxRank;
  where[field] = { ...existing, not: null, lte };
}

/** 榜单只展示前 N 名：默认综合榜用内部 rank；周/月/总榜用对应 sourceRank* */
function applySmartMoneyLeaderboardTopFilter(
  where: Prisma.SmartMoneyLeaderboardRowWhereInput,
  rankSortKey: 'WEEK' | 'MONTH' | 'ALL' | undefined,
  topLimit: number
): void {
  if (rankSortKey === 'WEEK') {
    where.sourceRankWeek = { not: null, lte: topLimit };
    return;
  }
  if (rankSortKey === 'MONTH') {
    where.sourceRankMonth = { not: null, lte: topLimit };
    return;
  }
  if (rankSortKey === 'ALL') {
    where.sourceRankAll = { not: null, lte: topLimit };
    return;
  }
  where.rank = { not: null, lte: topLimit };
}

/** 按候选来源窗口筛选时，优先按该窗口下的综合来源榜名次排序，再按分数与钱包稳定 tie-break */
function smartMoneyCachedOrderByWithCandidatePeriod(
  candidatePeriod: 'WEEK' | 'MONTH' | 'ALL',
  eligibleOnly: boolean
): Prisma.SmartMoneyLeaderboardRowOrderByWithRelationInput[] {
  const primary: Prisma.SmartMoneyLeaderboardRowOrderByWithRelationInput =
    candidatePeriod === 'WEEK'
      ? { sourceRankWeek: { sort: 'asc', nulls: 'last' } }
      : candidatePeriod === 'MONTH'
        ? { sourceRankMonth: { sort: 'asc', nulls: 'last' } }
        : { sourceRankAll: { sort: 'asc', nulls: 'last' } };
  const fallback = eligibleOnly
    ? ([
        { rank: { sort: 'asc', nulls: 'last' } },
        { score: 'desc' },
        { lastScoredAt: 'desc' },
        { wallet: 'asc' },
      ] satisfies Prisma.SmartMoneyLeaderboardRowOrderByWithRelationInput[])
    : ([
        { score: 'desc' },
        { lastScoredAt: 'desc' },
        { wallet: 'asc' },
      ] satisfies Prisma.SmartMoneyLeaderboardRowOrderByWithRelationInput[]);
  return [primary, ...fallback];
}

const leaderboardQuerySchema = z.object({
  category: z.enum(OFFICIAL_LEADERBOARD_CATEGORIES).optional(),
  timePeriod: z.enum(['DAY', 'WEEK', 'MONTH', 'ALL']).optional(),
  orderBy: z.enum(['PNL', 'VOL']).optional(),
  limit: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(1).max(500))
    .optional(),
  offset: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(0).max(1000))
    .optional(),
  user: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  userName: z.string().min(1).optional(),
});

const leaderboardCachedQuerySchema = z.object({
  category: z.enum(OFFICIAL_LEADERBOARD_CATEGORIES).optional().default('OVERALL'),
  timePeriod: z.enum(['DAY', 'WEEK', 'MONTH', 'ALL']).optional().default('WEEK'),
  orderBy: z.enum(['PNL', 'VOL']).optional().default('PNL'),
});

const smartMoneyCachedQuerySchema = z.object({
  limit: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(1).max(500))
    .optional()
    .default(Math.min(100, 500)),
  offset: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(0).max(10000))
    .optional()
    .default(0),
  eligibleOnly: z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const normalized = v.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
      return v;
    }, z.boolean())
    .optional()
    .default(true),
  /** Phase 3+：显式 CopyPool 过滤；管道模式下优先于 eligibleOnly 语义 */
  copyPoolOnly: z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const normalized = v.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
      return v;
    }, z.boolean())
    .optional(),
  /** 只保留 candidatePeriods 含该窗口的钱包（与官方/外部候选同步写入的 WEEK / MONTH / ALL 一致） */
  candidatePeriod: z.enum(['WEEK', 'MONTH', 'ALL']).optional(),
  /**
   * 按官方综合来源名次排序：周榜 / 月榜 / 总榜（sourceRankWeek / Month / All，null 在后）。
   * 与 `candidatePeriod` 独立：只影响 orderBy，不缩小候选集；未传时若传了 `candidatePeriod` 则仍按该周期名次排序（兼容旧行为）。
  */
  rankBy: z.enum(['WEEK', 'MONTH', 'ALL']).optional(),
  category: z.enum(OFFICIAL_LEADERBOARD_CATEGORIES).optional(),
  // Quality filters
  minScore: optionalQueryFiniteNumber(),
  maxScore: optionalQueryFiniteNumber(),
  minPnlQuality: optionalQueryFiniteNumber(),
  maxPnlQuality: optionalQueryFiniteNumber(),
  minConsistencyScore: optionalQueryFiniteNumber(),
  maxConsistencyScore: optionalQueryFiniteNumber(),
  minActivityScore: optionalQueryFiniteNumber(),
  maxActivityScore: optionalQueryFiniteNumber(),
  minWinRate: optionalQueryFiniteNumber(),
  maxWinRate: optionalQueryFiniteNumber(),
  minExternalSharpeRatio: optionalQueryFiniteNumber(),
  maxExternalSharpeRatio: optionalQueryFiniteNumber(),
  minExternalTotalReturn: optionalQueryFiniteNumber(),
  maxExternalTotalReturn: optionalQueryFiniteNumber(),
  minPredictionCount: optionalQueryInt(0),
  maxPredictionCount: optionalQueryInt(0),
  minHoldingsValue: optionalQueryFiniteNumber(),
  maxHoldingsValue: optionalQueryFiniteNumber(),
  minCopyabilityScore: optionalQueryFiniteNumber(),
  maxCopyabilityScore: optionalQueryFiniteNumber(),
  minTotalPnl: optionalQueryFiniteNumber(),
  maxTotalPnl: optionalQueryFiniteNumber(),
  minRecentPnl7d: optionalQueryFiniteNumber(),
  maxRecentPnl7d: optionalQueryFiniteNumber(),
  minTrades7d: optionalQueryInt(0),
  maxTrades7d: optionalQueryInt(0),
  minMaxDrawdownPercent: optionalQueryFiniteNumber(),
  maxMaxDrawdownPercent: optionalQueryFiniteNumber(),
  maxSourceRankWeek: optionalQueryInt(1),
  maxSourceRankMonth: optionalQueryInt(1),
  maxSourceRankAll: optionalQueryInt(1),
  maxOfficialRankWeek: optionalQueryInt(1),
  maxOfficialRankMonth: optionalQueryInt(1),
  maxOfficialRankAll: optionalQueryInt(1),
  maxExternalRankWeek: optionalQueryInt(1),
  maxExternalRankMonth: optionalQueryInt(1),
  maxExternalRankAll: optionalQueryInt(1),
  // Flags filters (riskFlags)
  hasFlag: z.string().trim().min(1).max(100).optional(),
  hasAnyFlags: z
    .preprocess((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') {
        return val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return val;
    }, z.array(z.string().trim().min(1).max(100)))
    .optional(),
  excludeFlag: z.string().trim().min(1).max(100).optional(),
  excludeFlags: z
    .preprocess((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') {
        return val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return val;
    }, z.array(z.string().trim().min(1).max(100)))
    .optional(),
  includeCopyability: z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const normalized = v.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
      return v;
    }, z.boolean())
    .optional()
    .default(false),
  /** Phase H：列表默认不返回完整 scoreExplain（详情页再拉） */
  includeScoreExplain: z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const normalized = v.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
      return v;
    }, z.boolean())
    .optional()
    .default(false),
  /**
   * 按指定字段排序（优先于 rankBy）。
   * 支持: score | totalPnl | predictionCount | holdingsValue | pnlQuality | consistencyScore | activityScore | externalWinRate | externalSharpeRatio | externalTotalReturn | profitFactor | maxDrawdownPercent | trades7d
   */
  sortBy: z
    .enum([
      'score',
      'displayScore',
      'traderScore',
      'copyabilityScore',
      'rankScore',
      'totalPnl',
      'predictionCount',
      'holdingsValue',
      'pnlQuality',
      'consistencyScore',
      'activityScore',
      'externalWinRate',
      'externalSharpeRatio',
      'externalTotalReturn',
      'profitFactor',
      'maxDrawdownPercent',
      'trades7d',
    ])
    .optional(),
  /** 排序方向，默认 desc */
  sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
  /** 产品档位筛选：S|A|B|C|D，可逗号分隔多选 */
  tier: z.string().optional(),
  /** 策略类型筛选 */
  traderType: z
    .enum(['INFORMATION', 'ARBITRAGE', 'GAMBLER', 'MARKET_MAKER', 'GENERAL'])
    .optional(),
  /** 仅主推（S/A 且非做市型） */
  mainPushOnly: z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const normalized = v.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
      return v;
    }, z.boolean())
    .optional()
    .default(false),
});

const externalLeaderboardCachedQuerySchema = z.object({
  source: z.enum(['PREDICTING_TOP', 'POLYMARKET_ANALYTICS']).optional().default('PREDICTING_TOP'),
  period: z.enum(['7D', '30D', 'ALL']).optional().default('7D'),
  limit: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(1).max(500))
    .optional()
    .default(100),
});

const smartMoneyRiskProfileQuerySchema = z
  .object({
    wallet: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .transform((value) => value.toLowerCase())
      .optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    period: z.enum(['1D', '1W', '1M', 'ALL']).optional().default('ALL'),
    live: z.preprocess((val) => parseQueryBoolean(val, false), z.boolean()),
    /** 默认 false：详情首屏不拉 Data API 成交，避免阻塞；需要时显式 true */
    includeTradeActivity: z.preprocess((val) => parseQueryBoolean(val, false), z.boolean()),
  })
  .refine((data) => Boolean(data.wallet) !== Boolean(data.displayName), {
    message: 'Provide exactly one of wallet or displayName',
  });

const smartMoneyRiskProfileRefreshBodySchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .transform((value) => value.toLowerCase()),
  period: z.enum(['1D', '1W', '1M', 'ALL']).optional().default('ALL'),
});

const smartMoneyAnalyzeJobParamsSchema = z.object({
  jobId: z.string().trim().min(1).max(100),
});

const smartMoneyProfilePositionsQuerySchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .transform((value) => value.toLowerCase()),
  limit: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(1).max(500))
    .optional()
    .default(200),
  offset: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(0))
    .optional()
    .default(0),
});

const smartMoneyProfileTradesQuerySchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .transform((value) => value.toLowerCase()),
  limit: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(1).max(200))
    .optional()
    .default(50),
  offset: z
    .preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(0).max(3000))
    .optional()
    .default(0),
});

const authBodySchema = z.union([
  z.object({
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address'),
    signature: z.string().min(1),
    // Preferred: backend derives CLOB API creds for user custody wallet
  }),
  z.object({
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address'),
    signature: z.string().min(1),
    // Legacy: accept explicit Polymarket API creds from caller
    apiKey: z.string().min(1),
    apiSecret: z.string().min(1),
    passphrase: z.string().min(1),
  }),
]);

/** 手动绑定 CLOB API Key（须与 address 对应钱包在 Polymarket 侧派生的 key 一致，否则会 40021） */
const manualCredentialsBodySchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address'),
  /** 对 POLYMARKET_AUTH_MESSAGE 的签名，证明用户控制该 address（与 /auth 相同） */
  signature: z.string().min(1),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  passphrase: z.string().min(1),
});

router.post('/auth', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = authBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }
    const userId = req.user.userId;
    const data = parsed.data as any;

    const result =
      'apiKey' in data && 'apiSecret' in data && 'passphrase' in data
        ? await polymarketAuth.upsertPolymarketCredential({
            userId,
            address: data.address,
            signature: data.signature,
            apiKey: data.apiKey,
            apiSecret: data.apiSecret,
            passphrase: data.passphrase,
          })
        : await (polymarketAuth as any).deriveAndUpsertPolymarketCredentialForUser({
            userId,
            address: data.address,
            signature: data.signature,
          });
    success(res, { apiKey: result.apiKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    if (
      message.includes('SECRET_KEY') ||
      message.includes('decode') ||
      message.includes('Invalid address') ||
      message.includes('Invalid signature') ||
      message.includes('Signature verification') ||
      message.includes('Missing api') ||
      message.includes('custodial') ||
      message.includes('Custodial') ||
      message.includes('Signed address')
    ) {
      next(
        createConflictError('Polymarket authorization prerequisites not completed', {
          reason: message,
          hint: 'Use your custodial execution address (POST /api/custody/open) and complete Polymarket authorization.',
        }),
      );
      return;
    }
    next(err);
  }
});

/**
 * POST /api/polymarket/manual-credentials
 * 手动写入 Polymarket CLOB L2 凭证（apiKey / secret / passphrase），加密入库并清除进程内 ClobClient 缓存。
 * 凭证必须是用 **本接口传入的 address**（当前用户托管执行地址）在 Polymarket CLOB 上创建/派生的，否则下单会报 signer 与 API key 不一致。
 * 鉴权消息与 POST /api/polymarket/auth 相同，见 polymarketAuth.POLYMARKET_AUTH_MESSAGE。
 */
router.post('/manual-credentials', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = manualCredentialsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }
    const userId = req.user.userId;
    const { address, signature, apiKey, apiSecret, passphrase } = parsed.data;
    const result = await polymarketAuth.upsertPolymarketCredential({
      userId,
      address,
      signature,
      apiKey,
      apiSecret,
      passphrase,
    });
    success(res, {
      apiKey: result.apiKey,
      hint: 'Credentials must belong to the same address as order signer; process CLOB cache was cleared.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    if (
      message.includes('SECRET_KEY') ||
      message.includes('decode') ||
      message.includes('Invalid address') ||
      message.includes('Invalid signature') ||
      message.includes('Signature verification') ||
      message.includes('Missing api') ||
      message.includes('custodial') ||
      message.includes('Custodial') ||
      message.includes('Signed address')
    ) {
      next(
        createConflictError('Polymarket manual credentials rejected', {
          reason: message,
          hint: 'Use your custodial execution address and a valid signature over POLYMARKET_AUTH_MESSAGE; API key must be derived for that address.',
        }),
      );
      return;
    }
    next(err);
  }
});

router.get('/status', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const data = await polymarketAuth.getPolymarketCredentialStatus(req.user.userId);
    success(res, data);
  } catch (err) {
    next(err);
  }
});

const walletFunderBodySchema = z.object({
  /** 托管交易钱包地址；单钱包用户可省略，默认最早一条 CUSTODIAL */
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  /** Polymarket deposit wallet（CLOB funder），与 POLY_SIGNATURE_TYPE=3 配合使用 */
  polymarketFunderAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

/**
 * PUT /api/polymarket/wallet/funder
 * 覆盖/手动绑定 Polymarket CLOB funder（通常为按 owner 推导的 deposit wallet）。开通托管并授权 CLOB 时服务端会自动写入，一般无需调用。
 */
router.put('/wallet/funder', jwtAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = walletFunderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }
    const userId = req.user.userId;
    const funder = ethers.utils.getAddress(parsed.data.polymarketFunderAddress);
    const wallets = await prisma.wallet.findMany({
      where: { userId, type: 'CUSTODIAL' } as any,
      orderBy: { createdAt: 'asc' },
    });
    if (!wallets.length) {
      next(
        createConflictError('No custodial wallet', {
          hint: 'Open custody wallet first (POST /api/custody/open).',
        }),
      );
      return;
    }
    const addrNorm = parsed.data.address?.trim().toLowerCase();
    const target = addrNorm
      ? wallets.find((w) => w.address.toLowerCase() === addrNorm)
      : wallets[0];
    if (!target) {
      fail(res, Code.NOT_FOUND, 'Custodial wallet not found for this address', 404);
      return;
    }
    await prisma.wallet.update({
      where: { id: target.id },
      data: { polymarketFunderAddress: funder },
    });
    invalidateUserClobClientCache(userId, target.address);
    success(res, {
      walletAddress: target.address,
      polymarketFunderAddress: funder,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/polymarket/leaderboard
 * 读取本地缓存的官方 Polymarket Data API 排行榜。
 */
router.get('/leaderboard', async (req, res, next) => {
  const parsed = leaderboardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }

  const q = parsed.data;
  const category = q.category ?? 'OVERALL';
  const timePeriod = q.timePeriod ?? 'WEEK';
  const orderBy = q.orderBy ?? 'PNL';

  try {
    const { rows } = await listLatestCachedLeaderboardRows({
      category,
      timePeriod,
      orderBy,
    });

    let items = rows.map(leaderboardRowToApiShape);

    if (q.user) {
      const want = q.user.toLowerCase();
      items = items.filter((e) => e.proxyWallet.toLowerCase() === want);
    }
    if (q.userName) {
      const needle = q.userName.toLowerCase();
      items = items.filter(
        (e) => typeof e.userName === 'string' && e.userName.toLowerCase().includes(needle)
      );
    }

    const offset = q.offset ?? 0;
    const limit = q.limit ?? 500;
    const paged = items.slice(offset, offset + limit);

    success(res, paged);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/polymarket/leaderboard/cached
 * 读取本地缓存的官方排行榜（需先开启 LEADERBOARD_CRON_ENABLED 并完成至少一次同步）。
 */
router.get('/leaderboard/cached', async (req, res, next) => {
  const parsed = leaderboardCachedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }
  const q = parsed.data;
  try {
    const { rows, syncedAt, syncVersion } = await listLatestCachedLeaderboardRows({
      category: q.category,
      timePeriod: q.timePeriod,
      orderBy: q.orderBy,
    });
    success(res, {
      source: 'OFFICIAL',
      items: rows.map((r) => ({
        syncVersion: r.syncVersion,
        rank: r.rank,
        proxyWallet: r.proxyWallet,
        userName: r.userName,
        profileImage: r.profileImage,
        xUsername: r.xUsername,
        vol: r.vol.toString(),
        pnl: r.pnl.toString(),
      })),
      syncVersion,
      syncedAt: syncedAt ? syncedAt.toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/polymarket/leaderboard/external-cached
 * 读取本地缓存的第三方排行榜（predicting.top 或 Polymarket Analytics）。
 */
router.get('/leaderboard/external-cached', async (req, res, next) => {
  const parsed = externalLeaderboardCachedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }

  const q = parsed.data;
  try {
    if (q.source === 'POLYMARKET_ANALYTICS') {
      const { syncVersion, rows } = await listLatestPolymarketAnalyticsRows(q.period, q.limit);
      const syncedAt = rows[0]?.syncedAt ?? null;
      success(res, {
        source: q.source,
        period: q.period,
        limit: q.limit,
        syncVersion,
        syncedAt: syncedAt ? syncedAt.toISOString() : null,
        items: rows.map((row) => ({
          rank: row.rank,
          wallet: row.wallet,
          hScore: row.hScore?.toString() ?? null,
          roi: row.roi?.toString() ?? null,
          winRate: row.winRate?.toString() ?? null,
          sharpeRatio: row.sharpeRatio?.toString() ?? null,
          pnl: row.totalPnl?.toString() ?? null,
          totalVolume: row.totalVolume?.toString() ?? null,
          totalTrades: row.totalTrades,
          marketsTraded: row.marketsTraded,
          tier: row.tier,
        })),
      });
      return;
    }

    const { syncVersion, rows } = await listLatestPredictingTopRows(q.period, q.limit);
    const syncedAt = rows[0]?.syncedAt ?? null;
    const calculatedAt = rows[0]?.calculatedAt ?? null;

    success(res, {
      source: q.source,
      period: q.period,
      limit: q.limit,
      syncVersion,
      syncedAt: syncedAt ? syncedAt.toISOString() : null,
      calculatedAt: calculatedAt ? calculatedAt.toISOString() : null,
      items: rows.map((row) => ({
        rank: row.rank,
        wallet: row.wallet,
        name: row.name,
        twitter: row.twitter,
        profileImage: row.profileImage,
        platform: row.platform,
        polymarketProfile: row.polymarketProfile,
        walletCount: row.walletCount,
        pnl: row.pnl?.toString() ?? null,
        buys: row.buys,
        sells: row.sells,
        deposits: row.deposits?.toString() ?? null,
        withdrawals: row.withdrawals?.toString() ?? null,
        views: row.views,
        smartScore: row.smartScore?.toString() ?? null,
        tier: row.tier,
        avgDailyReturn: row.avgDailyReturn?.toString() ?? null,
        bestDay: row.bestDay?.toString() ?? null,
        worstDay: row.worstDay?.toString() ?? null,
        winRate: row.winRate?.toString() ?? null,
        profitFactor: row.profitFactor?.toString() ?? null,
        rSquared: row.rSquared?.toString() ?? null,
        sharpeRatio: row.sharpeRatio?.toString() ?? null,
        sortinoRatio: row.sortinoRatio?.toString() ?? null,
        calmarRatio: row.calmarRatio?.toString() ?? null,
        maxDrawdown: row.maxDrawdown?.toString() ?? null,
        maxDrawdownPercent: row.maxDrawdownPercent?.toString() ?? null,
        currentDrawdown: row.currentDrawdown?.toString() ?? null,
        totalReturn: row.totalReturn?.toString() ?? null,
        trendSlope: row.trendSlope?.toString() ?? null,
        calculatedAt: row.calculatedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/polymarket/smart-money/cached
 * 读取本地缓存的聪明钱榜（需先完成 smart-money 候选同步与主页抓取评分）。
 *
 * 分页：Prisma `skip: offset`、`take: limit`（limit 默认 100，上限为 `SMART_MONEY_TOP_LIMIT`，默认 500；
 * offset 默认 0，上限 10000）。响应含 `offset`、`limit`、`total`（满足 where 的总条数）。
 * 是否还有下一页：`offset + items.length < total`（或等价地 `offset + limit < total` 在满页时）。
 *
 * 排序：默认 eligibleOnly=true 时按内部 rank 升序（rank 由综合分 score 降序赋值）；传 `rankBy`（或仅传 `candidatePeriod` 兼容旧版）时按周/月/总榜 `sourceRank*` 升序；eligibleOnly=false 时默认按 score 降序。
 *
 * items[] 展示字段：`profileImage`、`xUsername` 为 `string | null`，优先主页解析，缺失时回退官方榜缓存。
 */
router.get('/smart-money/cached', async (req, res, next) => {
  const parsed = smartMoneyCachedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }

  const q = parsed.data;
  const limit = Math.min(q.limit, CONFIG.smartMoneyTopLimit);
  const offset = q.offset;
  const listCacheKey = stableCacheKey({ ...q, limit, offset });

  try {
    const { value: payload, hit: listCacheHit } = await smartMoneyCachedListCache.getOrSet(
      listCacheKey,
      async () => {
    const where: Prisma.SmartMoneyLeaderboardRowWhereInput = {
      ...smartMoneyCachedDisplayWhere({
        eligibleOnly: q.eligibleOnly,
        copyPoolOnly: q.copyPoolOnly,
      }),
      ...(q.candidatePeriod ? { candidatePeriods: { has: q.candidatePeriod } } : {}),
      ...(q.category ? { candidateCategories: { has: q.category } } : {}),
    };

    // win rate filter maps to externalWinRate (Decimal?)
    applySmartMoneyDecimalRangeFilter(where, 'score', q.minScore, q.maxScore);
    applySmartMoneyDecimalRangeFilter(where, 'pnlQuality', q.minPnlQuality, q.maxPnlQuality);
    applySmartMoneyDecimalRangeFilter(
      where,
      'consistencyScore',
      q.minConsistencyScore,
      q.maxConsistencyScore
    );
    applySmartMoneyDecimalRangeFilter(where, 'activityScore', q.minActivityScore, q.maxActivityScore);
    applySmartMoneyDecimalRangeFilter(where, 'externalWinRate', q.minWinRate, q.maxWinRate);
    applySmartMoneyDecimalRangeFilter(
      where,
      'externalSharpeRatio',
      q.minExternalSharpeRatio,
      q.maxExternalSharpeRatio
    );
    applySmartMoneyDecimalRangeFilter(
      where,
      'externalTotalReturn',
      q.minExternalTotalReturn,
      q.maxExternalTotalReturn
    );
    if (q.minPredictionCount != null || q.maxPredictionCount != null) {
      where.predictionCount = {
        ...(q.minPredictionCount != null ? { gte: q.minPredictionCount } : {}),
        ...(q.maxPredictionCount != null ? { lte: q.maxPredictionCount } : {}),
      };
    }
    applySmartMoneyDecimalRangeFilter(where, 'holdingsValue', q.minHoldingsValue, q.maxHoldingsValue);
    applySmartMoneyDecimalRangeFilter(
      where,
      'copyabilityScore',
      q.minCopyabilityScore,
      q.maxCopyabilityScore
    );
    applySmartMoneyDecimalRangeFilter(where, 'totalPnl', q.minTotalPnl, q.maxTotalPnl);
    applySmartMoneyDecimalRangeFilter(
      where,
      'recentPnl7d',
      q.minRecentPnl7d,
      q.maxRecentPnl7d
    );
    applySmartMoneyDecimalRangeFilter(
      where,
      'maxDrawdownPercent',
      q.minMaxDrawdownPercent,
      q.maxMaxDrawdownPercent
    );
    if (q.minTrades7d != null || q.maxTrades7d != null) {
      where.trades7d = {
        ...(q.minTrades7d != null ? { gte: q.minTrades7d } : {}),
        ...(q.maxTrades7d != null ? { lte: q.maxTrades7d } : {}),
      };
    }
    if (q.hasFlag) where.riskFlags = { has: q.hasFlag };
    if (q.hasAnyFlags?.length) where.riskFlags = { hasSome: q.hasAnyFlags };
    if (q.excludeFlag || q.excludeFlags?.length) {
      const notClauses: Prisma.SmartMoneyLeaderboardRowWhereInput[] = Array.isArray(where.NOT)
        ? where.NOT
        : where.NOT
          ? [where.NOT]
          : [];
      if (q.excludeFlag) notClauses.push({ riskFlags: { has: q.excludeFlag } });
      if (q.excludeFlags?.length) {
        for (const flag of q.excludeFlags) notClauses.push({ riskFlags: { has: flag } });
      }
      where.NOT = notClauses;
    }

    const rankSortKey = q.rankBy ?? q.candidatePeriod;
    applySmartMoneyLeaderboardTopFilter(where, rankSortKey, CONFIG.smartMoneyTopLimit);
    mergeSmartMoneyMaxRankFilter(where, 'sourceRankWeek', q.maxSourceRankWeek);
    mergeSmartMoneyMaxRankFilter(where, 'sourceRankMonth', q.maxSourceRankMonth);
    mergeSmartMoneyMaxRankFilter(where, 'sourceRankAll', q.maxSourceRankAll);
    mergeSmartMoneyMaxRankFilter(where, 'officialSourceRankWeek', q.maxOfficialRankWeek);
    mergeSmartMoneyMaxRankFilter(where, 'officialSourceRankMonth', q.maxOfficialRankMonth);
    mergeSmartMoneyMaxRankFilter(where, 'officialSourceRankAll', q.maxOfficialRankAll);
    mergeSmartMoneyMaxRankFilter(where, 'externalSourceRankWeek', q.maxExternalRankWeek);
    mergeSmartMoneyMaxRankFilter(where, 'externalSourceRankMonth', q.maxExternalRankMonth);
    mergeSmartMoneyMaxRankFilter(where, 'externalSourceRankAll', q.maxExternalRankAll);

    if (q.tier?.trim()) {
      const tiers = q.tier
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter((t) => ['S', 'A', 'B', 'C', 'D'].includes(t));
      if (tiers.length === 1) where.tier = tiers[0];
      else if (tiers.length > 1) where.tier = { in: tiers };
    }
    if (q.traderType) where.traderType = q.traderType;
    if (q.mainPushOnly) {
      where.tier = { in: ['S', 'A'] };
      where.NOT = [
        ...(Array.isArray(where.NOT) ? where.NOT : where.NOT ? [where.NOT] : []),
        { traderType: 'MARKET_MAKER' },
      ];
    }

    // sortBy 优先：若指定了具体字段排序，则用该字段作为主排序，后面跟稳定 tie-break
    let orderBy: Prisma.SmartMoneyLeaderboardRowOrderByWithRelationInput[];
    const sortByProfitFactor = q.sortBy === 'profitFactor';
    if (q.sortBy && !sortByProfitFactor) {
      const dir = q.sortDir;
      const nullsLast = { sort: dir, nulls: 'last' } as const;
      const primary: Prisma.SmartMoneyLeaderboardRowOrderByWithRelationInput =
        q.sortBy === 'score'
          ? { score: dir }
          : q.sortBy === 'displayScore'
            ? { displayScore: nullsLast }
            : q.sortBy === 'traderScore'
              ? { traderScore: nullsLast }
              : q.sortBy === 'copyabilityScore'
                ? { copyabilityScore: nullsLast }
                : q.sortBy === 'rankScore'
                  ? { rankScore: nullsLast }
                  : q.sortBy === 'totalPnl'
                    ? { totalPnl: nullsLast }
                    : q.sortBy === 'predictionCount'
                      ? { predictionCount: dir }
                      : q.sortBy === 'holdingsValue'
                        ? { holdingsValue: nullsLast }
                        : q.sortBy === 'pnlQuality'
                          ? { pnlQuality: dir }
                          : q.sortBy === 'consistencyScore'
                            ? { consistencyScore: dir }
                            : q.sortBy === 'activityScore'
                              ? { activityScore: dir }
                              : q.sortBy === 'externalSharpeRatio'
                                ? { externalSharpeRatio: nullsLast }
                                : q.sortBy === 'externalTotalReturn'
                                  ? { externalTotalReturn: nullsLast }
                                  : q.sortBy === 'maxDrawdownPercent'
                                    ? { maxDrawdownPercent: nullsLast }
                                    : q.sortBy === 'trades7d'
                                      ? { trades7d: nullsLast }
                                      : { externalWinRate: nullsLast };
      const tieBreak = smartMoneyCachedOrderBy(q.eligibleOnly);
      orderBy = [primary, ...tieBreak];
    } else {
      orderBy = rankSortKey
        ? smartMoneyCachedOrderByWithCandidatePeriod(rankSortKey, q.eligibleOnly)
        : smartMoneyCachedOrderBy(q.eligibleOnly);
    }

    const listAggPromise = prisma.smartMoneyLeaderboardRow.aggregate({
      where,
      _count: { _all: true },
    });
    const topRowsForSyncPromise = prisma.smartMoneyLeaderboardRow.findMany({
      where,
      orderBy,
      take: Math.min(50, CONFIG.smartMoneyTopLimit),
      select: { syncedAt: true },
    });

    let rows: Awaited<ReturnType<typeof prisma.smartMoneyLeaderboardRow.findMany>>;
    let listAgg: Awaited<typeof listAggPromise>;
    let topRowsForSync: Awaited<typeof topRowsForSyncPromise>;

    if (sortByProfitFactor) {
      // profitFactor 存在 scoreExplain JSON，无独立列：内存排序后分页（榜单体量可控）
      const [allRows, agg, syncRows] = await Promise.all([
        prisma.smartMoneyLeaderboardRow.findMany({ where, orderBy }),
        listAggPromise,
        topRowsForSyncPromise,
      ]);
      const dirMul = q.sortDir === 'asc' ? 1 : -1;
      allRows.sort((left, right) => {
        const lv = numberOrNull(extractSmartMoneyExplainMetric(left.scoreExplain, 'profitFactor'));
        const rv = numberOrNull(extractSmartMoneyExplainMetric(right.scoreExplain, 'profitFactor'));
        if (lv == null && rv == null) return left.wallet.localeCompare(right.wallet);
        if (lv == null) return 1;
        if (rv == null) return -1;
        if (lv !== rv) return (lv - rv) * dirMul;
        return left.wallet.localeCompare(right.wallet);
      });
      rows = allRows.slice(offset, offset + limit);
      listAgg = agg;
      topRowsForSync = syncRows;
    } else {
      [rows, listAgg, topRowsForSync] = await Promise.all([
        prisma.smartMoneyLeaderboardRow.findMany({
          where,
          orderBy,
          skip: offset,
          take: limit,
        }),
        listAggPromise,
        topRowsForSyncPromise,
      ]);
    }

    const total = listAgg._count._all;
    const syncedAt =
      topRowsForSync.length > 0
        ? topRowsForSync.reduce(
            (max, row) => (row.syncedAt > max ? row.syncedAt : max),
            topRowsForSync[0]!.syncedAt
          )
        : null;
    const scoreVersion = rows[0]?.scoreVersion ?? CONFIG.smartMoneyScoreVersion;
    const candidateSource = [...new Set(rows.flatMap((row) => row.candidatePeriods))];
    const wallets = rows.map((row) => row.wallet.toLowerCase());
    // 入榜展示只信榜表；ScoreCache 仅管道/未入榜详情，列表不再做 fresher 覆盖
    const copyLeaders =
      wallets.length === 0
        ? []
        : await prisma.copyLeader.findMany({
            where: { address: { in: wallets } },
            select: { id: true, address: true },
          });
    const leaderIdByAddress = new Map(copyLeaders.map((leader) => [leader.address.toLowerCase(), leader.id]));
    const realFollowerCounts =
      copyLeaders.length === 0
        ? []
        : await prisma.copySubscription.groupBy({
            by: ['leaderId'],
            where: {
              enabled: true,
              deletedAt: null,
              leaderId: { in: copyLeaders.map((leader) => leader.id) },
            },
            _count: { _all: true },
          });
    const realFollowerCountByLeaderId = new Map(
      realFollowerCounts.map((group) => [group.leaderId, group._count._all])
    );

    return {
      offset,
      items: rows.map((row) => {
        const defaultFollowerCount = computeDefaultSmartMoneyFollowerCount(row.wallet);
        const leaderId = leaderIdByAddress.get(row.wallet.toLowerCase()) ?? null;
        const realFollowerCount =
          leaderId == null ? 0 : realFollowerCountByLeaderId.get(leaderId) ?? 0;
        const displayFollowerCount = defaultFollowerCount + realFollowerCount;
        const effectiveExplain = row.scoreExplain;
        const displayProfile = enrichSmartMoneyDisplayProfile(
          effectiveExplain,
          extractSmartMoneyDisplayProfile(effectiveExplain) as Record<string, unknown> | null
        );
        const canonical = readCanonicalBoardMetrics(effectiveExplain);
        return {
          rank: row.rank,
          wallet: row.wallet,
          displayName: row.displayName,
          profileSlug: row.profileSlug,
          joinedAtText: row.joinedAtText,
          profileImage: row.profileImage,
          xUsername: row.xUsername,
          score: row.score.toString(),
          traderScore: row.traderScore?.toString() ?? null,
          tier: row.tier ?? null,
          edgeScore: row.edgeScore?.toString() ?? null,
          edgeSampleN: row.edgeSampleN ?? null,
          traderType: row.traderType ?? null,
          activeDays: row.activeDays ?? null,
          maxWinTradeUsd: row.maxWinTradeUsd?.toString() ?? null,
          maxLossTradeUsd: row.maxLossTradeUsd?.toString() ?? null,
          traderCard: (() => {
            const aligned = alignScoreExplainTraderProfileToBoard({
              scoreExplain: effectiveExplain,
              tier: row.tier ?? null,
              traderScore: row.traderScore?.toString() ?? null,
              traderType: row.traderType ?? null,
            });
            if (aligned == null || typeof aligned !== 'object' || Array.isArray(aligned)) {
              return null;
            }
            const card = (aligned as { traderProfile?: { card?: unknown } }).traderProfile?.card;
            return card ?? null;
          })(),
          ...(q.includeCopyability
            ? {
                copyabilityScore: row.copyabilityScore?.toString() ?? null,
                displayScore: row.displayScore?.toString() ?? row.score.toString(),
                copyabilityComputedAt: row.copyabilityComputedAt?.toISOString() ?? null,
                rankScore: row.rankScore?.toString() ?? null,
                rankScoreComputedAt: row.rankScoreComputedAt?.toISOString() ?? null,
                copierFeedback: row.copierFeedback ?? null,
                copierFeedbackReady: (() => {
                  const fb = row.copierFeedback as {
                    sampleWeight?: number;
                    washSuspect?: boolean;
                  } | null;
                  if (fb == null || typeof fb !== 'object') return false;
                  if (fb.washSuspect === true) return false;
                  return typeof fb.sampleWeight === 'number' && fb.sampleWeight >= 1;
                })(),
              }
            : {
                displayScore: row.displayScore?.toString() ?? null,
              }),
          pnlQuality: row.pnlQuality.toString(),
          activityScore: row.activityScore.toString(),
          consistencyScore: row.consistencyScore.toString(),
          officialCandidateScore: row.officialCandidateScore.toString(),
          externalQualityScore: row.externalQualityScore.toString(),
          riskPenalty: row.riskPenalty.toString(),
          eligible: row.inCopyPool,
          inCopyPool: row.inCopyPool,
          activeCandidate: row.inCopyPool,
          predictionCount: row.predictionCount,
          holdingsValue: row.holdingsValue?.toString() ?? null,
          sourceRankWeek: row.sourceRankWeek,
          sourceRankMonth: row.sourceRankMonth,
          sourceRankAll: row.sourceRankAll,
          officialSourceRankWeek: row.officialSourceRankWeek,
          officialSourceRankMonth: row.officialSourceRankMonth,
          officialSourceRankAll: row.officialSourceRankAll,
          externalSourceRankWeek: row.externalSourceRankWeek,
          externalSourceRankMonth: row.externalSourceRankMonth,
          externalSourceRankAll: row.externalSourceRankAll,
          candidatePeriods: row.candidatePeriods,
          candidateCategories: row.candidateCategories,
          externalWinRate: row.externalWinRate?.toString() ?? null,
          externalSharpeRatio: row.externalSharpeRatio?.toString() ?? null,
          externalTotalReturn: row.externalTotalReturn?.toString() ?? null,
          profitFactor: extractSmartMoneyExplainMetric(effectiveExplain, 'profitFactor'),
          profitFactorNoLoss: displayProfile?.profitFactorNoLoss === true,
          winMarketCount: numberOrNull(displayProfile?.winMarketCount),
          lossMarketCount: numberOrNull(displayProfile?.lossMarketCount),
          maxDrawdownPercent:
            displayProfile?.mddUnmeasurable === true ||
            (row.maxDrawdownPercent != null && Number(row.maxDrawdownPercent) >= 0.999)
              ? null
              : (() => {
                  const fromDisplay = extractSmartMoneyExplainMetric(
                    effectiveExplain,
                    'maxDrawdownPercent'
                  );
                  if (fromDisplay != null) return fromDisplay;
                  return row.maxDrawdownPercent?.toString() ?? null;
                })(),
          totalPnl:
            row.totalPnl?.toString() ?? extractSmartMoneyTotalPnl(effectiveExplain),
          totalVolume: extractSmartMoneyTotalVolume(effectiveExplain),
          recentPnl7d: (() => {
            if (row.recentPnl7d != null) return row.recentPnl7d.toString();
            const n = numberOrNull(displayProfile?.recentPnl7d);
            return n != null ? String(n) : null;
          })(),
          recentPnl30d: (() => {
            if (row.recentPnl30d != null) return row.recentPnl30d.toString();
            const n = numberOrNull(displayProfile?.recentPnl30d);
            return n != null ? String(n) : null;
          })(),
          trades7d: row.trades7d ?? numberOrNull(displayProfile?.trades7d),
          trades30d: row.trades30d ?? numberOrNull(displayProfile?.trades30d),
          pnlWindowDays: row.pnlWindowDays ?? numberOrNull(displayProfile?.pnlWindowDays),
          totalPnl1y: (() => {
            if (row.totalPnl1y != null) return row.totalPnl1y.toString();
            const n = numberOrNull(displayProfile?.totalPnl1y);
            return n != null ? String(n) : null;
          })(),
          totalReturn1y: row.totalReturn1y?.toString() ?? null,
          maxDrawdown1y: row.maxDrawdown1y?.toString() ?? null,
          marketCategoryProfile: extractSmartMoneyMarketCategoryProfile(row.scoreExplain),
          displayProfile,
          backtestPnlUsd: (() => {
            if (row.backtestPnlUsd != null) return row.backtestPnlUsd.toString();
            const n = numberOrNull(displayProfile?.backtestPnlUsd);
            return n != null ? String(n) : null;
          })(),
          copyLossRate: (() => {
            if (row.copyLossRate != null) return row.copyLossRate.toString();
            const n = numberOrNull(displayProfile?.copyLossRate);
            return n != null ? String(n) : null;
          })(),
          slippageBpsEffective:
            row.slippageBpsEffective ?? numberOrNull(displayProfile?.slippageBpsEffective),
          metricsSource: {
            pnl: 'USER_PNL_API',
            winRate: row.winRateSource ?? null,
            return: 'CAPITAL_ROI',
            copyMetrics: 'SIMULATION',
          },
          copyMetricsNote:
            '仿真回测：按延迟与滑点假设重放历史成交，非本平台真实跟单用户盈亏',
          lastCurveEnrichAt: row.lastCurveEnrichAt?.toISOString() ?? null,
          sparkline: Array.isArray((row.scoreExplain as { sparkline?: unknown } | null)?.sparkline)
            ? (row.scoreExplain as { sparkline: unknown }).sparkline
            : Array.isArray(displayProfile?.sparkline)
              ? displayProfile.sparkline
              : null,
          recentMarkets: Array.isArray(
            (row.scoreExplain as { recentMarkets?: unknown } | null)?.recentMarkets
          )
            ? (row.scoreExplain as { recentMarkets: unknown }).recentMarkets
            : Array.isArray(displayProfile?.recentMarkets)
              ? displayProfile.recentMarkets
              : null,
          biggestWinRecent: (() => {
            const n = numberOrNull(displayProfile?.biggestWinRecent);
            return n != null ? String(n) : null;
          })(),
          turnoverReturnRatio: (() => {
            const fromDisplay = numberOrNull(displayProfile?.turnoverReturnRatio);
            if (fromDisplay != null) return String(fromDisplay);
            return canonical?.turnoverReturnRatio != null
              ? String(canonical.turnoverReturnRatio)
              : null;
          })(),
          maxDrawdownUsd: (() => {
            const fromDisplay = numberOrNull(displayProfile?.maxDrawdownUsd);
            if (fromDisplay != null) return String(fromDisplay);
            return canonical?.maxDrawdownUsd != null ? String(canonical.maxDrawdownUsd) : null;
          })(),
          mddUnmeasurable:
            displayProfile?.mddUnmeasurable === true ||
            (row.maxDrawdownPercent != null && Number(row.maxDrawdownPercent) >= 0.999),
          returnPrincipalSource: (() => {
            if (typeof displayProfile?.returnPrincipalSource === 'string') {
              return displayProfile.returnPrincipalSource;
            }
            return canonical?.returnPrincipalSource ?? null;
          })(),
          lastTradeAt:
            typeof displayProfile?.lastTradeAt === 'string' ? displayProfile.lastTradeAt : null,
          sampleWindowDays: numberOrNull(displayProfile?.sampleWindowDays),
          sampleTradeCount: numberOrNull(displayProfile?.sampleTradeCount),
          defaultFollowerCount,
          realFollowerCount,
          displayFollowerCount,
          externalMetricsPeriod: row.externalMetricsPeriod,
          externalMetricsSource: row.externalMetricsSource,
          winRateSource: row.winRateSource ?? null,
          winRateSampleN: numberOrNull(displayProfile?.winRateSampleN),
          metricsSourceBadge: row.metricsSourceBadge ?? row.externalMetricsSource ?? null,
          flags: row.riskFlags,
          ...(q.includeScoreExplain ? { scoreExplain: effectiveExplain } : {}),
          lastScoredAt: row.lastScoredAt.toISOString(),
          sourceFetchedAt: row.sourceFetchedAt?.toISOString() ?? null,
          syncedAt: row.syncedAt.toISOString(),
        };
      }),
      total,
      limit,
      eligibleOnly: q.eligibleOnly,
      ...buildSmartMoneyCachedApiMeta({
        eligibleOnly: q.eligibleOnly,
        copyPoolOnly: q.copyPoolOnly,
      }),
      category: q.category ?? null,
      rankBy: q.rankBy ?? null,
      sortByRank: rankSortKey ?? null,
      scoreVersion,
      candidateSource,
      syncedAt: syncedAt?.toISOString() ?? null,
    };
      }
    );
    res.setHeader('X-SmartMoney-List-Cache', listCacheHit ? 'HIT' : 'MISS');
    const listTtlSec = Math.max(0, Math.floor(CONFIG.smartMoneyListCacheTtlMs / 1000));
    if (listTtlSec > 0) {
      res.setHeader('Cache-Control', `private, max-age=${listTtlSec}`);
    }
    success(res, payload);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/polymarket/smart-money/profile-risk
 * 读取单个聪明钱钱包的风险画像 MVP：榜单摘要、最新快照、所选周期曲线与基础风险代理指标。
 */
router.get('/smart-money/profile-risk', async (req, res, next) => {
  const parsed = smartMoneyRiskProfileQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    // live=true 依赖上游抓取，必须禁用客户端/CDN缓存，否则移动端浏览器可能复用旧响应导致“怎么都不刷新”
    if (parsed.data.live) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
    const opts = {
      live: parsed.data.live,
      includeTradeActivity: parsed.data.includeTradeActivity,
    };
    let preGate: Awaited<ReturnType<typeof checkSmartMoneyProfileRiskCopyPool>> | null = null;
    if (parsed.data.wallet) {
      preGate = await checkSmartMoneyProfileRiskCopyPool(parsed.data.wallet);
      if (!preGate.allowed) {
        fail(res, Code.NOT_FOUND, 'Smart money risk profile not in copy pool', 404, {
          notInCopyPool: true,
          copyPoolPolicy: preGate.policy,
        });
        return;
      }
    }

    const profileCacheKey = parsed.data.wallet
      ? stableCacheKey({
          wallet: parsed.data.wallet,
          period: parsed.data.period,
          includeTradeActivity: opts.includeTradeActivity,
          live: opts.live,
        })
      : null;

    const loadProfile = async () =>
      parsed.data.wallet
        ? await getSmartMoneyRiskProfile(parsed.data.wallet, parsed.data.period, opts)
        : await getSmartMoneyRiskProfileByDisplayName(
            parsed.data.displayName!,
            parsed.data.period,
            opts
          );

    let data: Awaited<ReturnType<typeof getSmartMoneyRiskProfile>> | null;
    let profileCacheHit = false;
    if (profileCacheKey) {
      try {
        const cached = await smartMoneyProfileRiskCache.getOrSet(profileCacheKey, async () => {
          const loaded = await loadProfile();
          if (loaded == null) {
            const miss = new Error('SMART_MONEY_PROFILE_RISK_NULL');
            (miss as Error & { code: string }).code = 'NULL_PROFILE';
            throw miss;
          }
          return loaded;
        });
        data = cached.value;
        profileCacheHit = cached.hit;
      } catch (err) {
        if (err instanceof Error && (err as { code?: string }).code === 'NULL_PROFILE') {
          fail(res, Code.NOT_FOUND, 'Smart money risk profile not found', 404);
          return;
        }
        throw err;
      }
      res.setHeader('X-SmartMoney-Profile-Cache', profileCacheHit ? 'HIT' : 'MISS');
      // live 仍禁止 HTTP/CDN 缓存；进程内短缓存已生效
      if (!opts.live) {
        const ttlSec = Math.max(0, Math.floor(CONFIG.smartMoneyProfileRiskCacheTtlMs / 1000));
        if (ttlSec > 0) {
          res.setHeader('Cache-Control', `private, max-age=${ttlSec}`);
        }
      }
    } else {
      data = await loadProfile();
      res.setHeader('X-SmartMoney-Profile-Cache', 'BYPASS');
    }
    if (!data) {
      fail(res, Code.NOT_FOUND, 'Smart money risk profile not found', 404);
      return;
    }

    const gate =
      preGate ?? (await checkSmartMoneyProfileRiskCopyPool(data.wallet));
    if (!gate.allowed) {
      fail(res, Code.NOT_FOUND, 'Smart money risk profile not in copy pool', 404, {
        notInCopyPool: true,
        copyPoolPolicy: gate.policy,
      });
      return;
    }
    if (gate.notInCopyPool) {
      data.meta = {
        ...data.meta,
        notInCopyPool: true,
        copyPoolPolicy: gate.policy,
      } as typeof data.meta;
    }

    success(res, data);
  } catch (err) {
    if (err instanceof PolymarketProfileFetchError) {
      fail(res, Code.DEPENDENCY_UNAVAILABLE, err.message, 502, {
        upstream: 'polymarket_profile',
        kind: err.kind,
        retryable: err.retryable,
      });
      return;
    }
    next(err);
  }
});

/**
 * GET /api/polymarket/smart-money/profile-positions
 * 地址详情页持仓：懒加载专用，读取 Polymarket Data API 当前未平仓持仓。
 */
router.get(
  '/smart-money/profile-positions',
  authRateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'smart-money-profile-positions' }),
  async (req, res, next) => {
    const parsed = smartMoneyProfilePositionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      res.setHeader('Cache-Control', 'private, max-age=60');
      const data = await getSmartMoneyProfilePositions(parsed.data.wallet, {
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      success(res, data);
    } catch (err) {
      if (err instanceof SmartMoneyProfilePositionsFetchError) {
        const status = err.kind === 'rate_limit' ? 429 : 502;
        if (err.retryAfterSec != null) {
          res.setHeader('Retry-After', String(err.retryAfterSec));
        }
        fail(res, err.kind === 'rate_limit' ? Code.TOO_MANY_REQUESTS : Code.DEPENDENCY_UNAVAILABLE, err.message, status, {
          upstream: 'polymarket_data_api',
          kind: err.kind,
          retryable: err.retryable,
        });
        return;
      }
      next(err);
    }
  }
);

/**
 * GET /api/polymarket/smart-money/profile-closed-positions
 * 地址详情页历史持仓：优先 FULL 快照，缺失时实时读取，失败后降级 GATE 快照。
 */
router.get(
  '/smart-money/profile-closed-positions',
  authRateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'smart-money-profile-closed-positions' }),
  async (req, res, next) => {
    const parsed = smartMoneyProfilePositionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      res.setHeader('Cache-Control', 'private, max-age=60');
      const data = await getSmartMoneyProfileClosedPositions(parsed.data.wallet, {
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      success(res, data);
    } catch (err) {
      if (err instanceof SmartMoneyProfileClosedPositionsFetchError) {
        logger.warn(
          { err, wallet: parsed.data.wallet },
          'Failed to load smart-money profile closed positions'
        );
        fail(res, Code.DEPENDENCY_UNAVAILABLE, 'Unable to load historical positions', 502, {
          upstream: 'polymarket_closed_positions',
          retryable: true,
        });
        return;
      }
      next(err);
    }
  }
);

/**
 * GET /api/polymarket/smart-money/profile-trades
 * 地址详情页交易记录：懒加载，直连 Polymarket Data API /trades（非本地 enrich 缓存）。
 */
router.get(
  '/smart-money/profile-trades',
  authRateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'smart-money-profile-trades' }),
  async (req, res, next) => {
    const parsed = smartMoneyProfileTradesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      res.setHeader('Cache-Control', 'private, max-age=30');
      const data = await getSmartMoneyProfileTrades(parsed.data.wallet, {
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      success(res, data);
    } catch (err) {
      if (err instanceof SmartMoneyProfileTradesFetchError) {
        const status = err.kind === 'rate_limit' ? 429 : 502;
        if (err.retryAfterSec != null) {
          res.setHeader('Retry-After', String(err.retryAfterSec));
        }
        fail(res, err.kind === 'rate_limit' ? Code.TOO_MANY_REQUESTS : Code.DEPENDENCY_UNAVAILABLE, err.message, status, {
          upstream: 'polymarket_data_api',
          kind: err.kind,
          retryable: err.retryable,
        });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /api/polymarket/smart-money/profile-risk/analyze
 * 新鲜完整结果直接返回；否则进入总容量 5、并发 1 的按需短队列。
 */
router.post('/smart-money/profile-risk/analyze', jwtAuth, async (req, res, next) => {
  const parsed = smartMoneyRiskProfileRefreshBodySchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }
  if (!req.user) {
    fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
    return;
  }

  try {
    const { wallet, period } = parsed.data;
    const freshness = await evaluateSmartMoneyAddressFreshness(wallet);
    if (freshness.action === 'skip') {
      const profile = await getSmartMoneyRiskProfile(wallet, period, { live: false });
      success(res, {
        wallet,
        action: 'skip',
        status: 'READY',
        jobId: null,
        queuePosition: null,
        profile,
        meta: {
          freshness: 'FRESH',
          lastScoredAt: freshness.lastScoredAt?.toISOString() ?? null,
          reasons: freshness.reasons,
        },
      });
      return;
    }

    try {
      const { job, reused } = await enqueueSmartMoneyAnalyze({
        wallet,
        userId: req.user.userId,
        period,
        action: freshness.action,
      });
      const current = await getSmartMoneyAnalyzeJob(job.id);
      const staleProfile = freshness.complete
        ? await getSmartMoneyRiskProfile(wallet, period, { live: false }).catch(() => null)
        : null;
      success(
        res,
        {
          wallet,
          action: job.action.toLowerCase(),
          status: current?.status ?? job.status,
          jobId: job.id,
          queuePosition: current?.queuePosition ?? null,
          profile: staleProfile,
          meta: {
            freshness: freshness.complete ? 'STALE' : 'MISSING',
            reused,
            lastScoredAt: freshness.lastScoredAt?.toISOString() ?? null,
            reasons: freshness.reasons,
          },
        },
        staleProfile ? 200 : 202
      );
      return;
    } catch (error) {
      if (!(error instanceof SmartMoneyAnalyzeQueueError)) throw error;
      const staleProfile = freshness.complete
        ? await getSmartMoneyRiskProfile(wallet, period, { live: false }).catch(() => null)
        : null;
      if (staleProfile) {
        success(res, {
          wallet,
          action: freshness.action,
          status: error.code === 'QUEUE_FULL' ? 'QUEUE_FULL' : 'FAILED',
          jobId: null,
          queuePosition: null,
          error: error.message,
          profile: staleProfile,
          meta: {
            freshness: 'STALE',
            queueError: error.code,
            lastScoredAt: freshness.lastScoredAt?.toISOString() ?? null,
            reasons: freshness.reasons,
          },
        });
        return;
      }
      fail(res, Code.TOO_MANY_REQUESTS, error.message, 429, {
        reason: error.code,
      });
      return;
    }
  } catch (err) {
    next(err);
  }
});

/** GET /api/polymarket/smart-money/profile-risk/analyze/:jobId */
router.get('/smart-money/profile-risk/analyze/:jobId', jwtAuth, async (req, res, next) => {
  const parsed = smartMoneyAnalyzeJobParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }
  try {
    const job = await getSmartMoneyAnalyzeJob(parsed.data.jobId);
    if (!job) {
      fail(res, Code.NOT_FOUND, 'Analysis job not found', 404);
      return;
    }
    const period =
      job.period === '1D' || job.period === '1W' || job.period === '1M' ? job.period : 'ALL';
    const profile =
      job.status === 'READY'
        ? await getSmartMoneyRiskProfile(job.wallet, period, { live: false })
        : null;
    success(res, {
      wallet: job.wallet,
      action: job.action.toLowerCase(),
      status: job.status,
      jobId: job.id,
      queuePosition: job.queuePosition,
      error: job.error,
      profile,
      meta: {
        freshness: job.status === 'READY' ? 'FRESH' : 'MISSING',
        startedAt: job.startedAt?.toISOString() ?? null,
        finishedAt: job.finishedAt?.toISOString() ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/polymarket/smart-money/profile-risk/refresh
 * 手动按钱包重抓一次 Polymarket 个人页，写入最新快照/曲线，并返回最新 DB 风险画像。
 */
router.post('/smart-money/profile-risk/refresh', jwtAuth, async (req, res, next) => {
  const parsed = smartMoneyRiskProfileRefreshBodySchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const wallet = parsed.data.wallet.toLowerCase();
    await ingestSmartMoneyRawAddresses([{ wallet, source: 'ADMIN_REFRESH' }]);
    const refresh = await runDeepAnalyzeForWallet(wallet);
    if (!refresh.success) {
      fail(res, Code.DEPENDENCY_UNAVAILABLE, refresh.error ?? 'Manual refresh failed', 502, {
        wallet,
        refresh,
      });
      return;
    }

    const profile = await getSmartMoneyRiskProfile(parsed.data.wallet, parsed.data.period, { live: false });
    success(res, {
      wallet,
      refresh,
      profile,
    });
  } catch (err) {
    next(err);
  }
});

export const polymarketRouter = router;
