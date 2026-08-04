/**
 * 确认新地址（SCORED + copy 已算 + 达线）能走 tryEnter / promote 进池。
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.SMART_MONEY_COPY_READY_REQUIRED_FOR_POOL ??= 'true';
process.env.SMART_MONEY_COPY_POOL_ENTER_SCORE ??= '50';
process.env.SMART_MONEY_TRADER_SCORE_AS_PRIMARY ??= 'true';

import { Prisma } from '../src/generated/prisma/client.js';
import { prisma } from '../src/db.js';
import {
  promoteStrandedCopyReadyToPool,
  requeueOrphanCopyabilityPending,
  tryEnterCopyPoolAfterCopyReady,
} from '../src/services/smartMoney/smartMoneyCopyabilityEnrich.js';

const wallet = '0xhealthchecknewaddr000000000000000001';

async function main(): Promise<void> {
  const now = new Date();
  const nodeNowIso = now.toISOString();
  const dbNow = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
  console.log('[clock]', { nodeNowIso, dbNow: dbNow[0]?.now });

  const promotedLeft = await promoteStrandedCopyReadyToPool(50);
  const orphanTouched = await requeueOrphanCopyabilityPending();

  await prisma.smartMoneyRawAddress.upsert({
    where: { wallet },
    create: {
      wallet,
      sources: ['HEALTHCHECK_NEW_ADDR'],
      firstSeenAt: now,
      lastSeenAt: now,
      lastIngestedAt: now,
      pipelineStage: 'SCORED',
      dormant: false,
      nextDeepAnalyzeAt: now,
    },
    update: {
      pipelineStage: 'SCORED',
      dormant: false,
      nextDeepAnalyzeAt: now,
    },
  });
  await prisma.smartMoneyLeaderboardRow.upsert({
    where: { wallet },
    create: {
      wallet,
      score: new Prisma.Decimal('66'),
      pnlQuality: new Prisma.Decimal('50'),
      activityScore: new Prisma.Decimal('50'),
      consistencyScore: new Prisma.Decimal('50'),
      riskPenalty: new Prisma.Decimal('0'),
      scoreVersion: 'healthcheck',
      lastScoredAt: now,
      syncedAt: now,
      traderScore: new Prisma.Decimal('66'),
      copyabilityScore: new Prisma.Decimal('40'),
      copyabilityComputedAt: now,
      displayScore: new Prisma.Decimal('66'),
      tier: 'B',
      riskFlags: [],
      inCopyPool: false,
      enrichPending: false,
      activeCandidate: false,
      eligible: false,
      sourceFetchedAt: now,
    },
    update: {
      traderScore: new Prisma.Decimal('66'),
      copyabilityScore: new Prisma.Decimal('40'),
      inCopyPool: false,
      enrichPending: false,
      riskFlags: [],
      copyPoolEnteredAt: null,
      lastScoredAt: now,
    },
  });

  const enter = await tryEnterCopyPoolAfterCopyReady(wallet);
  const row = await prisma.smartMoneyLeaderboardRow.findUniqueOrThrow({
    where: { wallet },
    select: {
      inCopyPool: true,
      copyPoolEnteredAt: true,
      enrichPending: true,
      rank: true,
    },
  });
  const raw = await prisma.smartMoneyRawAddress.findUniqueOrThrow({
    where: { wallet },
    select: { pipelineStage: true },
  });

  await prisma.smartMoneyLeaderboardRow.delete({ where: { wallet } });
  await prisma.smartMoneyRawAddress.delete({ where: { wallet } });

  const metrics = await prisma.$queryRaw<
    Array<{ stranded: bigint; need_copy: bigint; in_pool_no_rank: bigint }>
  >`
    SELECT
      COUNT(*) FILTER (
        WHERE NOT "inCopyPool"
          AND "copyabilityScore" IS NOT NULL
          AND COALESCE("traderScore", score) >= 50
          AND NOT ("riskFlags" && ARRAY[
            'BLACKLISTED','NEGATIVE_TOTAL_PNL','HEDGED_PAIR_EXPOSURE',
            'HIGH_TRADE_FREQUENCY','TRADE_FREQUENCY_UNVERIFIED','SHORT_HORIZON_MARKET'
          ]::text[])
      ) AS stranded,
      COUNT(*) FILTER (
        WHERE NOT "inCopyPool"
          AND "copyabilityScore" IS NULL
          AND "enrichPending" = false
          AND COALESCE("traderScore", score) >= 50
      ) AS need_copy,
      COUNT(*) FILTER (WHERE "inCopyPool" AND rank IS NULL) AS in_pool_no_rank
    FROM "SmartMoneyLeaderboardRow"
  `;

  const ok = enter.entered && row.inCopyPool && raw.pipelineStage === 'COPY_POOL';
  console.log(
    JSON.stringify(
      {
        promotedLeft,
        orphanTouched,
        newAddrEnter: enter,
        row,
        rawStage: raw.pipelineStage,
        postMetrics: {
          stranded: Number(metrics[0].stranded),
          need_copy_orphan: Number(metrics[0].need_copy),
          in_pool_no_rank: Number(metrics[0].in_pool_no_rank),
        },
        verdict: ok ? 'NEW_ADDR_CAN_ENTER' : 'NEW_ADDR_BLOCKED',
      },
      null,
      2
    )
  );
  await prisma.$disconnect();
  process.exit(ok ? 0 : 2);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
