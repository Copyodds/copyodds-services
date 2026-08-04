/**
 * WSL 测算：promote 搁浅户后 stranded 应下降、出现新 copyPoolEnteredAt。
 *
 *   DATABASE_URL=... SMART_MONEY_COPY_READY_REQUIRED_FOR_POOL=true \
 *   npx tsx scripts/verify-enrich-enter-fix.ts
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import { prisma } from '../src/db.js';
import { CONFIG } from '../src/config/env.js';
import {
  promoteStrandedCopyReadyToPool,
  requeueOrphanCopyabilityPending,
  tryEnterCopyPoolAfterCopyReady,
} from '../src/services/smartMoney/smartMoneyCopyabilityEnrich.js';
import { Prisma } from '../src/generated/prisma/client.js';

async function metrics() {
  const rows = await prisma.$queryRaw<
    Array<{
      in_pool: bigint;
      pending_out: bigint;
      stranded_clean: bigint;
      enter_15m: bigint;
    }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE "inCopyPool") AS in_pool,
      COUNT(*) FILTER (WHERE NOT "inCopyPool" AND "enrichPending") AS pending_out,
      COUNT(*) FILTER (
        WHERE NOT "inCopyPool"
          AND "copyabilityScore" IS NOT NULL
          AND COALESCE("traderScore", score) >= 50
          AND NOT ("riskFlags" && ARRAY[
            'BLACKLISTED','NEGATIVE_TOTAL_PNL','HEDGED_PAIR_EXPOSURE',
            'HIGH_TRADE_FREQUENCY','TRADE_FREQUENCY_UNVERIFIED','SHORT_HORIZON_MARKET'
          ]::text[])
      ) AS stranded_clean,
      COUNT(*) FILTER (
        WHERE "inCopyPool"
          AND "copyPoolEnteredAt" >= NOW() - INTERVAL '15 minutes'
      ) AS enter_15m
    FROM "SmartMoneyLeaderboardRow"
  `;
  const r = rows[0];
  return {
    in_pool: Number(r.in_pool),
    pending_out: Number(r.pending_out),
    stranded_clean: Number(r.stranded_clean),
    enter_15m: Number(r.enter_15m),
  };
}

async function main(): Promise<void> {
  console.log('[verify] config', {
    copyReadyRequired: CONFIG.smartMoneyCopyReadyRequiredForPool,
    enterScore: CONFIG.smartMoneyCopyPoolEnterScore,
    traderScoreAsPrimary: CONFIG.smartMoneyTraderScoreAsPrimary,
  });

  const before = await metrics();
  console.log('[verify] before', before);

  // Case: seed + tryEnter return shape
  const wallet = '0xverifyenrichenterfix0000000000000001';
  const now = new Date();
  await prisma.smartMoneyRawAddress.upsert({
    where: { wallet },
    create: {
      wallet,
      sources: ['VERIFY_ENRICH_ENTER_FIX'],
      firstSeenAt: now,
      lastSeenAt: now,
      lastIngestedAt: now,
      pipelineStage: 'SCORED',
      dormant: false,
      nextDeepAnalyzeAt: new Date(now.getTime() + 3_600_000),
    },
    update: { pipelineStage: 'SCORED' },
  });
  await prisma.smartMoneyLeaderboardRow.upsert({
    where: { wallet },
    create: {
      wallet,
      score: new Prisma.Decimal('72'),
      pnlQuality: new Prisma.Decimal('50'),
      activityScore: new Prisma.Decimal('50'),
      consistencyScore: new Prisma.Decimal('50'),
      riskPenalty: new Prisma.Decimal('0'),
      scoreVersion: 'verify',
      lastScoredAt: now,
      syncedAt: now,
      traderScore: new Prisma.Decimal('72'),
      copyabilityScore: new Prisma.Decimal('55'),
      copyabilityComputedAt: now,
      displayScore: new Prisma.Decimal('72'),
      tier: 'B',
      riskFlags: [],
      inCopyPool: false,
      enrichPending: false,
      activeCandidate: false,
      eligible: false,
      sourceFetchedAt: now,
    },
    update: {
      traderScore: new Prisma.Decimal('72'),
      copyabilityScore: new Prisma.Decimal('55'),
      inCopyPool: false,
      enrichPending: false,
      riskFlags: [],
      copyPoolEnteredAt: null,
    },
  });

  const enter = await tryEnterCopyPoolAfterCopyReady(wallet);
  console.log('[verify] seeded tryEnter', enter);
  await prisma.smartMoneyLeaderboardRow.deleteMany({ where: { wallet } });
  await prisma.smartMoneyRawAddress.deleteMany({ where: { wallet } });

  let totalPromoted = 0;
  let rounds = 0;
  // 多轮直到搁浅清空或本轮 0 晋级（默认每轮最多 100）
  for (; rounds < 20; rounds += 1) {
    const n = await promoteStrandedCopyReadyToPool(100);
    totalPromoted += n;
    console.log('[verify] promote_round', { rounds: rounds + 1, n, totalPromoted });
    if (n === 0) break;
  }
  const orphan = await requeueOrphanCopyabilityPending();
  const after = await metrics();
  console.log('[verify] after', { totalPromoted, orphan, rounds: rounds + 1, ...after });

  const fixed =
    enter.entered === true &&
    enter.reason === 'ENTERED' &&
    (before.stranded_clean === 0 || after.stranded_clean < before.stranded_clean) &&
    (before.stranded_clean === 0 || after.enter_15m > before.enter_15m) &&
    after.stranded_clean === 0;

  if (fixed || (enter.entered && after.stranded_clean === 0)) {
    console.log('[verify] PASS: stranded cleared (or was empty) and tryEnter works');
    process.exitCode = 0;
  } else if (enter.entered && totalPromoted > 0 && after.stranded_clean < before.stranded_clean) {
    console.log('[verify] PARTIAL: promoted some but stranded remain', {
      remaining: after.stranded_clean,
    });
    process.exitCode = 0;
  } else {
    console.error('[verify] FAIL', {
      enter,
      strandedDelta: after.stranded_clean - before.stranded_clean,
      enter15mDelta: after.enter_15m - before.enter_15m,
      totalPromoted,
    });
    process.exitCode = 2;
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[verify] fatal', err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
