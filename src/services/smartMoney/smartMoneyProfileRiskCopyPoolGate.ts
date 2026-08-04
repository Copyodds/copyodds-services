import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import {
  resolveAnalyzedProfileRiskCopyPoolCheck,
  resolveProfileRiskCopyPoolCheck,
  type ProfileRiskCopyPoolCheck,
} from './smartMoneyProfileRiskCopyPoolPolicy';

export type { ProfileRiskCopyPoolCheck, ProfileRiskCopyPoolPolicy } from './smartMoneyProfileRiskCopyPoolPolicy';
export { resolveProfileRiskCopyPoolCheck } from './smartMoneyProfileRiskCopyPoolPolicy';

export async function checkSmartMoneyProfileRiskCopyPool(
  wallet: string
): Promise<ProfileRiskCopyPoolCheck> {
  const policy = CONFIG.smartMoneyProfileRiskCopyPoolPolicy;
  if (policy === 'off') {
    return resolveProfileRiskCopyPoolCheck(policy, null);
  }

  const normalized = wallet.toLowerCase();
  const [row, scoreCache] = await Promise.all([
    prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet: normalized },
      select: { inCopyPool: true },
    }),
    prisma.smartMoneyScoreCache.findUnique({
      where: { wallet: normalized },
      select: { wallet: true },
    }),
  ]);

  return resolveAnalyzedProfileRiskCopyPoolCheck(
    policy,
    row?.inCopyPool ?? false,
    scoreCache != null
  );
}
