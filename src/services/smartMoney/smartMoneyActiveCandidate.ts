import { prisma } from '../../db';

/** 将榜行 candidatePeriods/Categories 与 ObservedTrader 对齐（元数据，不驱动过滤）。 */
export async function syncSmartMoneyLeaderboardCandidateMetadata(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "SmartMoneyLeaderboardRow" sm
    SET
      "candidateCategories" = ot."candidateCategories",
      "candidatePeriods" = ot."candidatePeriods"
    FROM "ObservedTrader" ot
    WHERE ot.wallet = sm.wallet
      AND ot."candidateActive" = true
      AND (
        sm."candidateCategories" IS DISTINCT FROM ot."candidateCategories"
        OR sm."candidatePeriods" IS DISTINCT FROM ot."candidatePeriods"
      )
  `;
}

/**
 * 兼容字段：activeCandidate 镜像 inCopyPool。
 * cached API / 入出池以 inCopyPool 为准，不再依赖候选位图。
 */
export async function syncSmartMoneyLeaderboardActiveCandidateFlags(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "SmartMoneyLeaderboardRow" sm
    SET
      "activeCandidate" = sm."inCopyPool",
      eligible = sm."inCopyPool"
    WHERE sm."activeCandidate" IS DISTINCT FROM sm."inCopyPool"
       OR sm.eligible IS DISTINCT FROM sm."inCopyPool"
  `;
}
