/**
 * 纠正误写入 UUPS 的 polymarketFunderAddress（WALLET-CREATE 链上实际部署 Beacon）。
 *
 * Usage:
 *   npx tsx scripts/backfill-polymarket-deposit-funder-repair.ts
 *   npx tsx scripts/backfill-polymarket-deposit-funder-repair.ts 17
 */
import '../src/loadEnv';
import { ethers } from 'ethers';
import { prisma } from '../src/db';
import { CONFIG } from '../src/config/env';
import {
  resolvePolymarketDepositWalletAddress,
  shouldCorrectStoredDepositFunderMisassignedUups,
} from '../src/services/polymarket/polymarketDepositWalletDerive';

async function main(): Promise<void> {
  const userIdArg = process.argv[2];
  const filterUserId = userIdArg ? Number.parseInt(userIdArg, 10) : null;
  if (userIdArg && (!Number.isFinite(filterUserId!) || filterUserId! <= 0)) {
    console.error('usage: npx tsx scripts/backfill-polymarket-deposit-funder-repair.ts [userId]');
    process.exit(1);
  }

  const rows = await prisma.wallet.findMany({
    where: {
      type: 'CUSTODIAL',
      userId: filterUserId != null ? filterUserId : { not: null },
      polymarketFunderAddress: { not: null },
    } as any,
    select: { id: true, userId: true, address: true, polymarketFunderAddress: true },
  });

  let corrected = 0;
  let skipped = 0;
  for (const w of rows) {
    const uid = w.userId;
    const stored = (w.polymarketFunderAddress ?? '').trim();
    if (uid == null || !stored) {
      skipped++;
      continue;
    }
    const shouldFix = await shouldCorrectStoredDepositFunderMisassignedUups({
      ownerAddress: w.address,
      chainId: CONFIG.chainId,
      storedDeposit: stored,
    });
    if (!shouldFix) {
      skipped++;
      continue;
    }
    const resolved = ethers.utils.getAddress(
      await resolvePolymarketDepositWalletAddress(w.address, CONFIG.chainId),
    );
    await prisma.wallet.update({
      where: { id: w.id },
      data: { polymarketFunderAddress: resolved },
    });
    console.log('[repair] userId=%s walletId=%s %s → %s', uid, w.id, stored, resolved);
    corrected++;
  }

  console.log(
    `[backfill-polymarket-deposit-funder-repair] done: corrected=${corrected} skipped=${skipped} scanned=${rows.length}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
