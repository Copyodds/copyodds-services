/**
 * 对本地库里「干净搁浅」样本跑一次真实 tryEnter。
 *   DATABASE_URL=... npx tsx scripts/repro-try-enter-stranded-sample.ts
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import { prisma } from '../src/db.js';
import { tryEnterCopyPoolAfterCopyReady } from '../src/services/smartMoney/smartMoneyCopyabilityEnrich.js';

async function main(): Promise<void> {
  const rows = await prisma.$queryRaw<
    Array<{ wallet: string; traderScore: unknown; copyabilityScore: unknown }>
  >`
    SELECT wallet, "traderScore", "copyabilityScore"
    FROM "SmartMoneyLeaderboardRow"
    WHERE NOT "inCopyPool"
      AND NOT "enrichPending"
      AND "copyabilityScore" IS NOT NULL
      AND COALESCE("traderScore", score) >= 50
      AND NOT ("riskFlags" && ARRAY[
        'BLACKLISTED','NEGATIVE_TOTAL_PNL','HEDGED_PAIR_EXPOSURE',
        'HIGH_TRADE_FREQUENCY','TRADE_FREQUENCY_UNVERIFIED','SHORT_HORIZON_MARKET'
      ]::text[])
    ORDER BY "lastScoredAt" DESC NULLS LAST
    LIMIT 5
  `;
  console.log('[sample] stranded_clean_no_pending', rows.length, rows.map((r) => r.wallet.slice(0, 14)));

  if (rows.length === 0) {
    console.log('[sample] none found');
    await prisma.$disconnect();
    return;
  }

  const wallet = rows[0].wallet;
  const before = await prisma.smartMoneyLeaderboardRow.findUniqueOrThrow({
    where: { wallet },
    select: {
      inCopyPool: true,
      enrichPending: true,
      copyPoolEnteredAt: true,
      traderScore: true,
      copyabilityScore: true,
    },
  });
  const enter = await tryEnterCopyPoolAfterCopyReady(wallet);
  const after = await prisma.smartMoneyLeaderboardRow.findUniqueOrThrow({
    where: { wallet },
    select: {
      inCopyPool: true,
      enrichPending: true,
      copyPoolEnteredAt: true,
    },
  });
  console.log('[sample] tryEnter on real stranded', {
    wallet: wallet.slice(0, 14),
    before,
    enter,
    after,
  });

  // 复原，避免污染本地榜
  if (enter.entered) {
    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet },
      data: {
        inCopyPool: false,
        enrichPending: false,
        activeCandidate: false,
        eligible: false,
        rank: null,
        copyPoolEnteredAt: before.copyPoolEnteredAt,
      },
    });
    await prisma.smartMoneyRawAddress.updateMany({
      where: { wallet },
      data: { pipelineStage: 'SCORED' },
    });
    console.log('[sample] reverted enter (local safety)');
  }

  await prisma.$disconnect();
  if (enter.entered) {
    console.error('[sample] REPRODUCED: stranded wallet CAN enter via tryEnter → was cleared from queue without enter');
    process.exitCode = 2;
  } else {
    console.error('[sample] tryEnter failed on stranded sample', enter);
    process.exitCode = 3;
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
