/**
 * 一次性补全：CUSTODIAL + 已有 ApiCredential 但 polymarketFunderAddress 为空的钱包，
 * 按 owner 地址推导 Polymarket deposit wallet 并写入。
 *
 * Usage: npx tsx scripts/backfill-polymarket-deposit-funder.ts
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { syncCustodialPolymarketDepositFunderIfEmpty } from '../src/services/polymarket/polymarketAuth';

async function main() {
  const rows = await prisma.wallet.findMany({
    where: {
      type: 'CUSTODIAL',
      polymarketFunderAddress: null,
      userId: { not: null },
      apiCredential: { isNot: null },
    } as any,
    select: { id: true, userId: true, address: true },
  });

  let ok = 0;
  let skip = 0;
  for (const w of rows) {
    const uid = w.userId;
    if (uid == null) {
      skip++;
      continue;
    }
    try {
      await syncCustodialPolymarketDepositFunderIfEmpty({
        userId: uid,
        walletId: w.id,
        ownerAddress: w.address,
      });
      const after = await prisma.wallet.findUnique({
        where: { id: w.id },
        select: { polymarketFunderAddress: true },
      });
      if (after?.polymarketFunderAddress) ok++;
      else skip++;
    } catch (e) {
      console.warn('[backfill] wallet', w.id, e instanceof Error ? e.message : e);
      skip++;
    }
  }

  console.log(`[backfill-polymarket-deposit-funder] done: updated=${ok} skipped=${skip} scanned=${rows.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
