import { CONFIG } from '../../config/env';
import { prisma } from '../../db';

export type CopyPoolSubscribeCheck = {
  allowed: boolean;
  policy: 'off' | 'warn' | 'block';
  inCopyPool: boolean | null;
  warningCode: string | null;
};

export async function checkSmartMoneyCopyPoolSubscription(
  leaderAddress: string
): Promise<CopyPoolSubscribeCheck> {
  const policy = CONFIG.smartMoneyCopyPoolSubscribePolicy;
  if (policy === 'off') {
    return { allowed: true, policy, inCopyPool: null, warningCode: null };
  }

  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet: leaderAddress.toLowerCase() },
    select: { inCopyPool: true },
  });

  if (row?.inCopyPool) {
    return { allowed: true, policy, inCopyPool: true, warningCode: null };
  }

  const warningCode = 'SMART_MONEY_NOT_IN_COPY_POOL';
  if (policy === 'block') {
    return { allowed: false, policy, inCopyPool: false, warningCode };
  }

  return { allowed: true, policy, inCopyPool: false, warningCode };
}
