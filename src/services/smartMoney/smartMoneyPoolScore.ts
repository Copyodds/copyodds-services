import type { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';

/**
 * §15 / F8：CopyPool / 展示 / 出榜线统一用的池分数。
 * 产品主分 = traderScore（displayScore 为其别名）；v4 `score` 仅附属回落，不驱动进出榜。
 */
export function resolveCopyPoolMetricScore(input: {
  traderScore?: number | null;
  score: number;
}): number {
  if (
    CONFIG.smartMoneyTraderScoreAsPrimary &&
    input.traderScore != null &&
    Number.isFinite(input.traderScore)
  ) {
    return input.traderScore;
  }
  return input.score;
}

/** Prisma where：当前池分 > 出榜线（含 traderScore null 回落 score） */
export function copyPoolAboveExitWhere(
  exitScore = CONFIG.smartMoneyCopyPoolExitScore
): Prisma.SmartMoneyLeaderboardRowWhereInput {
  if (!CONFIG.smartMoneyTraderScoreAsPrimary) {
    return { score: { gt: exitScore } };
  }
  return {
    OR: [
      { traderScore: { gt: exitScore } },
      { AND: [{ traderScore: null }, { score: { gt: exitScore } }] },
    ],
  };
}

/** S=0 … D=4，未知靠后 —— 供 rank 重算「档位优先」 */
export function tierSortRank(tier: string | null | undefined): number {
  switch ((tier ?? '').toUpperCase()) {
    case 'S':
      return 0;
    case 'A':
      return 1;
    case 'B':
      return 2;
    case 'C':
      return 3;
    case 'D':
      return 4;
    default:
      return 5;
  }
}
