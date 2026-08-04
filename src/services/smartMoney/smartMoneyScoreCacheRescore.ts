import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  computeV22RiskPenalty,
  computeV22ScoreFromComponents,
} from './smartMoneyScorer';
import {
  isSmartMoneyScoreV40Active,
  SMART_MONEY_SCORE_V40_WEIGHTS,
} from './smartMoneyScoreV40';
import { purgeBelowExitScoreLeaderboardRows } from './smartMoneyLeaderboardWriter';

type ScoreExplainComponents = {
  profit?: unknown;
  consistency?: unknown;
  risk?: unknown;
  tradeQuality?: unknown;
  activity?: unknown;
  dataConfidence?: unknown;
};

type V40Factors = {
  S_base?: unknown;
  S_roi?: unknown;
  S_recent_pnl?: unknown;
  S_total_pnl?: unknown;
  S_sharpe?: unknown;
  S_mdd?: unknown;
  S_win_rate?: unknown;
  S_profit_factor?: unknown;
  S_concentration?: unknown;
  S_copyability?: unknown;
  S_activity?: unknown;
  S_activity_freq?: unknown;
  S_consistency?: unknown;
  S_distribution?: unknown;
  S_volume_fresh?: unknown;
};

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function extractExplainVersion(scoreExplain: Prisma.JsonValue | null): string | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return null;
  }
  const version = (scoreExplain as { version?: unknown }).version;
  return typeof version === 'string' && version.trim() ? version.trim() : null;
}

function extractResolvedTotalPnl(scoreExplain: Prisma.JsonValue): number | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return null;
  }
  const explain = scoreExplain as {
    resolvedMetrics?: { totalPnl?: unknown };
    rawMetrics?: { totalPnl?: unknown };
  };
  return (
    toFiniteNumber(explain.resolvedMetrics?.totalPnl) ??
    toFiniteNumber(explain.rawMetrics?.totalPnl)
  );
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 同版本 v4.x：用已存 factors + P_hft 按权重重算（禁止跨版本改写）。 */
function rescoreV40FromExplain(scoreExplain: Prisma.JsonValue): {
  score: number;
  totalPnl: number | null;
} | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return null;
  }
  const v40 = (scoreExplain as { v40?: { factors?: V40Factors; penalties?: { P_hft?: unknown } } })
    .v40;
  const factors = v40?.factors;
  if (factors == null) return null;

  const w = SMART_MONEY_SCORE_V40_WEIGHTS;
  const keys: Array<[keyof typeof SMART_MONEY_SCORE_V40_WEIGHTS, string, string?]> = [
    ['base', 'S_base'],
    ['roi', 'S_roi'],
    ['recent_pnl', 'S_recent_pnl'],
    ['pnl_30d', 'S_pnl_30d'],
    ['total_pnl', 'S_total_pnl'],
    ['sharpe', 'S_sharpe'],
    ['mdd', 'S_mdd'],
    ['win_rate', 'S_win_rate'],
    ['profit_factor', 'S_profit_factor'],
    ['concentration', 'S_concentration'],
    ['copyability', 'S_copyability'],
    ['activity_freq', 'S_activity_freq', 'S_activity'],
    ['consistency', 'S_consistency'],
    ['distribution', 'S_distribution'],
  ];

  let raw = 0;
  const factorMap = factors as Record<string, unknown>;
  for (const [weightKey, factorKey, fallbackKey] of keys) {
    const factor =
      toFiniteNumber(factorMap[factorKey]) ??
      (fallbackKey != null ? toFiniteNumber(factorMap[fallbackKey]) : null);
    // 旧 explain 缺 recent/total 时用中性 35，避免 fast rescore 整行失败
    const resolved =
      factor ??
      (weightKey === 'recent_pnl' || weightKey === 'pnl_30d'
        ? 50
        : weightKey === 'total_pnl'
          ? 35
          : null);
    if (resolved == null) return null;
    raw += w[weightKey] * resolved;
  }

  const pHft = toFiniteNumber(v40?.penalties?.P_hft) ?? 0;
  return {
    score: roundScore(clamp(raw - pHft, 0, 100)),
    totalPnl: extractResolvedTotalPnl(scoreExplain),
  };
}

function rescoreV22FromExplain(input: {
  riskFlags: string[];
  scoreExplain: Prisma.JsonValue;
}): { score: number; totalPnl: number | null } | null {
  const components = (input.scoreExplain as { components?: ScoreExplainComponents }).components;
  if (components == null) return null;

  const profit = toFiniteNumber(components.profit);
  const consistency = toFiniteNumber(components.consistency);
  const risk = toFiniteNumber(components.risk);
  const tradeQuality = toFiniteNumber(components.tradeQuality);
  const activity = toFiniteNumber(components.activity);
  const dataConfidence = toFiniteNumber(components.dataConfidence);
  if (
    profit == null ||
    consistency == null ||
    risk == null ||
    tradeQuality == null ||
    activity == null ||
    dataConfidence == null
  ) {
    return null;
  }

  const riskPenalty = computeV22RiskPenalty(input.riskFlags);
  const score = computeV22ScoreFromComponents({
    profit,
    consistency,
    risk,
    tradeQuality,
    activity,
    dataConfidence,
    riskPenalty,
  });

  return {
    score,
    totalPnl: extractResolvedTotalPnl(input.scoreExplain),
  };
}

function rescoreRowFromCache(input: {
  score: Prisma.Decimal;
  riskFlags: string[];
  scoreExplain: Prisma.JsonValue | null;
}): { score: number; totalPnl: number | null } | null {
  const explainVersion = extractExplainVersion(input.scoreExplain);
  if (explainVersion == null || explainVersion !== CONFIG.smartMoneyScoreVersion) {
    // 跨版本禁止 fast 改写（避免 v2.2 公式把 v4.0 行打成莫名低分）
    return null;
  }
  if (input.scoreExplain == null) return null;

  if (isSmartMoneyScoreV40Active(explainVersion)) {
    return rescoreV40FromExplain(input.scoreExplain);
  }
  return rescoreV22FromExplain({
    riskFlags: input.riskFlags,
    scoreExplain: input.scoreExplain,
  });
}

/**
 * 不重爬 profile：仅允许**同评分版本**用已缓存 explain 重算 score。
 * v4.0 走 factors 加权；非 v4 才走历史 v2.2 components。写分后按出榜线摘池。
 */
export async function rescoreSmartMoneyLeaderboardScoresFromCache(options?: {
  where?: Prisma.SmartMoneyLeaderboardRowWhereInput;
  batchSize?: number;
}): Promise<{ updated: number; skipped: number; purgedBelowExit: number }> {
  const batchSize = options?.batchSize ?? 500;
  const where = options?.where ?? { eligible: true };
  let updated = 0;
  let skipped = 0;
  let cursor: number | undefined;

  for (;;) {
    const rows = await prisma.smartMoneyLeaderboardRow.findMany({
      where,
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor != null ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        wallet: true,
        score: true,
        riskFlags: true,
        scoreExplain: true,
      },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const rescored = rescoreRowFromCache(row);
      if (rescored == null) {
        skipped += 1;
        continue;
      }
      if (Number(row.score) === rescored.score) {
        skipped += 1;
        continue;
      }

      const scoreExplain =
        row.scoreExplain != null && typeof row.scoreExplain === 'object' && !Array.isArray(row.scoreExplain)
          ? {
              ...(row.scoreExplain as Record<string, unknown>),
              version: CONFIG.smartMoneyScoreVersion,
            }
          : row.scoreExplain;

      const data: Prisma.SmartMoneyLeaderboardRowUpdateInput = {
        score: new Prisma.Decimal(rescored.score.toFixed(8)),
        totalPnl: rescored.totalPnl != null ? new Prisma.Decimal(rescored.totalPnl) : undefined,
        scoreVersion: CONFIG.smartMoneyScoreVersion,
        scoreExplain: scoreExplain as Prisma.InputJsonValue,
        // 不改 lastScoredAt：否则会骗过 dual_channel「今日已复评」日完成标记
      };

      if (!isSmartMoneyScoreV40Active()) {
        data.riskPenalty = new Prisma.Decimal(computeV22RiskPenalty(row.riskFlags).toFixed(8));
      }

      await prisma.smartMoneyLeaderboardRow.update({
        where: { wallet: row.wallet },
        data,
      });
      updated += 1;
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) break;
  }

  const { demotedRows } = await purgeBelowExitScoreLeaderboardRows();
  return { updated, skipped, purgedBelowExit: demotedRows };
}
