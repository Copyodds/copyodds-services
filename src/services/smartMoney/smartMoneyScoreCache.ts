import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import type { SmartMoneyScoreResult } from './smartMoneyScorer';
import { patchLeaderboardRowFromScoreResultIfPresent } from './smartMoneyLeaderboardWriter';

function toDecimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(8));
}

export async function clearSmartMoneyReadCaches(): Promise<void> {
  try {
    const { smartMoneyCachedListCache, smartMoneyProfileRiskCache } = await import(
      './smartMoneyReadCache.js'
    );
    smartMoneyCachedListCache.clear();
    smartMoneyProfileRiskCache.clear();
  } catch {
    // ignore cache module issues in tests
  }
}

/**
 * 评分结果的单一写入口：
 * 1) 总是写入 ScoreCache（管道 / 未入榜详情）
 * 2) 若仍有榜行且评分更新，回写榜表展示列
 */
export async function upsertSmartMoneyScoreCache(
  result: SmartMoneyScoreResult,
  tierMeta?: {
    tier1fPassedAt?: Date | null;
    tier2CorePassedAt?: Date | null;
    tier2EnhancedPassedAt?: Date | null;
  }
): Promise<void> {
  const now = new Date();
  await prisma.smartMoneyScoreCache.upsert({
    where: { wallet: result.wallet },
    create: {
      wallet: result.wallet,
      score: toDecimal(result.score),
      scoreVersion: result.scoreVersion,
      riskFlags: result.riskFlags,
      scoreExplain: result.scoreExplain as Prisma.InputJsonValue,
      tier1fPassedAt: tierMeta?.tier1fPassedAt ?? null,
      tier2CorePassedAt: tierMeta?.tier2CorePassedAt ?? null,
      tier2EnhancedPassedAt: tierMeta?.tier2EnhancedPassedAt ?? null,
      lastScoredAt: result.lastScoredAt,
      updatedAt: now,
    },
    update: {
      score: toDecimal(result.score),
      scoreVersion: result.scoreVersion,
      riskFlags: result.riskFlags,
      scoreExplain: result.scoreExplain as Prisma.InputJsonValue,
      tier1fPassedAt: tierMeta?.tier1fPassedAt ?? null,
      tier2CorePassedAt: tierMeta?.tier2CorePassedAt ?? null,
      tier2EnhancedPassedAt: tierMeta?.tier2EnhancedPassedAt ?? null,
      lastScoredAt: result.lastScoredAt,
      updatedAt: now,
    },
  });
  // 榜行仍在时同步档位等展示列，避免管道写 Cache 后榜表落后
  await patchLeaderboardRowFromScoreResultIfPresent(result).catch(() => undefined);
  // 无榜行或 patch 跳过时也要清读缓存，否则未入榜详情会继续命中旧 profile
  await clearSmartMoneyReadCaches();
}

/**
 * 派生写（copyability 等）只改了榜表后，把展示相关 JSON 回写 ScoreCache。
 * 不改 lastScoredAt（仍表示 Deep 评分时间）；用 updatedAt + displayRevisionAt 标记展示修订。
 */
export async function syncSmartMoneyScoreCacheDisplayFromLeaderboard(
  wallet: string
): Promise<boolean> {
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: {
      wallet: true,
      score: true,
      scoreVersion: true,
      riskFlags: true,
      scoreExplain: true,
      lastScoredAt: true,
    },
  });
  if (!row) return false;

  const now = new Date();
  const explainJson = (row.scoreExplain ?? {}) as Prisma.InputJsonValue;

  await prisma.smartMoneyScoreCache.upsert({
    where: { wallet: row.wallet },
    create: {
      wallet: row.wallet,
      score: row.score,
      scoreVersion: row.scoreVersion,
      riskFlags: row.riskFlags,
      scoreExplain: explainJson,
      lastScoredAt: row.lastScoredAt,
      updatedAt: now,
    },
    update: {
      score: row.score,
      scoreVersion: row.scoreVersion,
      riskFlags: row.riskFlags,
      scoreExplain: explainJson,
      updatedAt: now,
    },
  });

  await clearSmartMoneyReadCaches();
  return true;
}

export async function getSmartMoneyScoreCache(wallet: string) {
  return prisma.smartMoneyScoreCache.findUnique({ where: { wallet } });
}
