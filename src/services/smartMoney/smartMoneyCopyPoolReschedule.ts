import { CONFIG } from '../../config/env';
import { prisma } from '../../db';

/**
 * CopyPool 分层复评间隔（legacy_tiered）：Top100 → 1d；≤midRank → 3d；其余 → 7d。
 * dual_channel 模式下由 smartMoneyCopyPoolRescoreChannels 接管，本文件仅作回滚。
 * rank 缺失时勿直接按尾部 7d：Deep 写榜后 rank 常异步重算，误用 7d 会导致 Top100 长期不复评。
 */
export function computeCopyPoolRescoreDelayMs(rank: number | null | undefined): number {
  const topRank = CONFIG.smartMoneyCopyPoolRescoreTopRank;
  const midRank = CONFIG.smartMoneyCopyPoolRescoreMidRank;
  if (rank != null && Number.isFinite(rank) && rank > 0 && rank <= topRank) {
    return CONFIG.smartMoneyCopyPoolRescoreTopMs;
  }
  if (rank != null && Number.isFinite(rank) && rank <= midRank) {
    return CONFIG.smartMoneyCopyPoolRescoreMidMs;
  }
  return CONFIG.smartMoneyCopyPoolRescoreTailMs;
}

export function computeCopyPoolNextDeepAnalyzeAt(
  rank: number | null | undefined,
  now = new Date()
): Date {
  return new Date(now.getTime() + computeCopyPoolRescoreDelayMs(rank));
}

/**
 * 解析用于复评冷却的有效 rank。
 *
 * 正式 rank 尚未写入时（异步 rank-recompute 前）：
 * - 不能按 null→7d 尾部（会冻死刚入榜的头部地址）
 * - 也不能只用 traderScore 估名次（官方排名是「档位优先 + TraderScore」，估偏会把 S 档判成 3d）
 * → 统一按 Top 档（返回 1 → 1d）。下次 Deep 时已有正式 rank，再分层。
 */
export async function resolveCopyPoolRescoreRank(input: {
  wallet: string;
  rank?: number | null;
}): Promise<number | null> {
  if (input.rank != null && Number.isFinite(input.rank) && input.rank > 0) {
    return input.rank;
  }

  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet: input.wallet },
    select: { rank: true },
  });
  if (row?.rank != null && row.rank > 0) {
    return row.rank;
  }

  return 1;
}
