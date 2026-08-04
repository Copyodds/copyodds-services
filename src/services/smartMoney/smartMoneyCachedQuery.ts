/**
 * 跟单榜 cached API 过滤：CopyPool + 已赋 rank + 当前池分 > 出榜线。
 * §15：池分优先 TraderScore。
 * 榜前 Copy：若开启必算门，要求 copyability ≥ MIN（统一综合分门槛）；未达线不展示。
 * 注意：此 where 仅约束「我们推荐的榜单」；用户自选地址跟单不走此门。
 */
import type { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import { copyPoolAboveExitWhere } from './smartMoneyPoolScore';
import { copyabilityPoolMinComposite } from './smartMoneyCopyReady';

export function smartMoneyCachedDisplayWhere(input?: {
  eligibleOnly?: boolean;
  copyPoolOnly?: boolean;
}): Prisma.SmartMoneyLeaderboardRowWhereInput {
  void input;
  return {
    inCopyPool: true,
    rank: { not: null },
    ...(CONFIG.smartMoneyCopyReadyRequiredForPool
      ? { copyabilityScore: { gte: copyabilityPoolMinComposite() } }
      : {}),
    ...copyPoolAboveExitWhere(),
  };
}

/** 排名资格 where：CopyPool 且当前池分 > 出榜线。 */
export function smartMoneyLeaderboardRankWhere(): Prisma.SmartMoneyLeaderboardRowWhereInput {
  return {
    inCopyPool: true,
    ...(CONFIG.smartMoneyCopyReadyRequiredForPool
      ? { copyabilityScore: { gte: copyabilityPoolMinComposite() } }
      : {}),
    ...copyPoolAboveExitWhere(),
  };
}

export function buildSmartMoneyCachedApiMeta(input: {
  eligibleOnly: boolean;
  copyPoolOnly?: boolean;
}): {
  copyPoolOnly: boolean;
  deprecatedFields: string[];
} {
  const copyPoolOnly = input.copyPoolOnly ?? input.eligibleOnly;
  return {
    copyPoolOnly: copyPoolOnly !== false,
    deprecatedFields: [
      'eligible',
      'activeCandidate',
      'displayMode',
      'officialSourceRankWeek',
      'officialSourceRankMonth',
      'officialSourceRankAll',
    ],
  };
}
