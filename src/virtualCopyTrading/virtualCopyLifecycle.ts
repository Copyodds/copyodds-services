import { CONFIG } from '../config/env';
import { prisma } from '../db';
import { processVirtualMarketSettlements } from './virtualCopySettlement';

/**
 * Expires accounts, applies only authoritative Polygon CTF resolutions, then marks
 * accounts settled once every position lot has been closed.
 */
export async function processVirtualAccountLifecycle(
  now = new Date(),
  options: { settleMarkets?: boolean } = {},
): Promise<{
  expired: number;
  settled: number;
}> {
  const expired = await prisma.virtualCopyAccount.updateMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] }, expiresAt: { lte: now } },
    data: { status: 'EXPIRED_CLOSING', expiredAt: now, version: { increment: 1 } },
  });
  if (options.settleMarkets ?? CONFIG.virtualCopySettlementEnabled) {
    await processVirtualMarketSettlements();
  }
  const accountsWithOpenLots = await prisma.virtualPositionLot.findMany({
    where: { remainingSize: { gt: 0 }, account: { status: 'EXPIRED_CLOSING' } },
    select: { accountId: true },
    distinct: ['accountId'],
  });
  const candidates = await prisma.virtualCopyAccount.findMany({
    where: {
      status: 'EXPIRED_CLOSING',
      ...(accountsWithOpenLots.length > 0
        ? { id: { notIn: accountsWithOpenLots.map((item) => item.accountId) } }
        : {}),
    },
    select: { id: true },
  });
  let settled = 0;
  if (candidates.length > 0) {
    const result = await prisma.virtualCopyAccount.updateMany({
      where: { id: { in: candidates.map((item) => item.id) }, status: 'EXPIRED_CLOSING' },
      data: { status: 'SETTLED', settledAt: now, version: { increment: 1 } },
    });
    settled = result.count;
  }
  return { expired: expired.count, settled };
}
