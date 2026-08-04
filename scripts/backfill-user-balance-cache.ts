/**
 * 一次性回填 UserBalanceCache（admin 用户列表 USDC/PUSD 展示）。
 * 用法：node --env-file=.env --import tsx scripts/backfill-user-balance-cache.ts
 * 可选：BACKFILL_USER_IDS=18,19  BACKFILL_LIMIT=100
 */
import { prisma } from '../src/db';
import { getOnChainUsdcBalanceForCustodialUser } from '../src/services/custody/custodyOnChainBalance';
import { getPolymarketDepositUsdcBalance } from '../src/services/polymarket/polymarketDepositWithdraw';

async function main() {
  const idsEnv = (process.env.BACKFILL_USER_IDS ?? '').trim();
  const limit = Math.min(200, Math.max(1, Number(process.env.BACKFILL_LIMIT ?? 100) || 100));

  let userIds: number[] = [];
  if (idsEnv) {
    userIds = idsEnv
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } else {
    const rows = await prisma.user.findMany({
      where: {
        OR: [
          { wallets: { some: { type: 'CUSTODIAL' } } },
          { wallets: { some: { polymarketFunderAddress: { not: null } } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'desc' },
      take: limit,
    });
    userIds = rows.map((r) => r.id);
  }

  console.log(`[backfill-user-balance-cache] syncing ${userIds.length} users...`);
  for (const userId of userIds) {
    try {
      const dep = await getPolymarketDepositUsdcBalance(userId, { readOnly: false });
      const cust = await getOnChainUsdcBalanceForCustodialUser(userId);
      console.log(
        `[backfill-user-balance-cache] user=${userId} deposit=${dep?.formatted ?? '-'} custody=${cust?.usdc.formatted ?? '-'}`,
      );
    } catch (err) {
      console.warn(`[backfill-user-balance-cache] user=${userId} failed`, err);
    }
  }
  console.log('[backfill-user-balance-cache] done');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
