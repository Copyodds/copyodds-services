/**
 * 本地复现：Enrich 成功清 pending 但未入池。
 *
 * 用法（WSL）：
 *   cd /root/workspace/polycopy/polymarket-backend
 *   npx tsx --env-file=.env scripts/repro-enrich-enter-stall.ts
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import { Prisma } from '../src/generated/prisma/client.js';
import { prisma } from '../src/db.js';
import { CONFIG } from '../src/config/env.js';
import { hasCopyPoolHardFlag } from '../src/services/smartMoney/smartMoneyTierGate.js';
import { isCopyabilityReadyForPool } from '../src/services/smartMoney/smartMoneyCopyReady.js';
import { resolveCopyPoolMetricScore } from '../src/services/smartMoney/smartMoneyPoolScore.js';
import { tryEnterCopyPoolAfterCopyReady } from '../src/services/smartMoney/smartMoneyCopyabilityEnrich.js';

const WALLET = '0xreproenrichenterstall000000000000000001';

function baseLeaderboardCreate(wallet: string, now: Date) {
  return {
    wallet,
    score: new Prisma.Decimal('72'),
    pnlQuality: new Prisma.Decimal('50'),
    activityScore: new Prisma.Decimal('50'),
    consistencyScore: new Prisma.Decimal('50'),
    riskPenalty: new Prisma.Decimal('0'),
    scoreVersion: 'repro',
    lastScoredAt: now,
    syncedAt: now,
    traderScore: new Prisma.Decimal('72'),
    copyabilityScore: new Prisma.Decimal('55'),
    copyabilityComputedAt: now,
    displayScore: new Prisma.Decimal('72'),
    tier: 'B',
    riskFlags: [] as string[],
    inCopyPool: false,
    enrichPending: true,
    activeCandidate: false,
    eligible: false,
    rank: null as number | null,
    sourceFetchedAt: now,
  };
}

function diagnoseEnterGate(row: {
  inCopyPool: boolean;
  copyabilityScore: Prisma.Decimal | null;
  traderScore: Prisma.Decimal | null;
  score: Prisma.Decimal;
  riskFlags: string[];
}): { ok: boolean; reason: string } {
  if (!CONFIG.smartMoneyCopyReadyRequiredForPool) {
    return { ok: false, reason: 'COPY_READY_REQUIRED_FOR_POOL=false → tryEnter 直接 return false' };
  }
  if (row.inCopyPool) return { ok: false, reason: 'already_in_pool' };
  const copy = row.copyabilityScore != null ? Number(row.copyabilityScore) : null;
  if (!isCopyabilityReadyForPool(copy)) return { ok: false, reason: 'COPY_NOT_READY' };
  if (hasCopyPoolHardFlag(row.riskFlags ?? [])) return { ok: false, reason: 'HARD_FLAG' };
  const poolScore = resolveCopyPoolMetricScore({
    traderScore: row.traderScore != null ? Number(row.traderScore) : null,
    score: row.score != null ? Number(row.score) : 0,
  });
  if (poolScore < CONFIG.smartMoneyCopyPoolEnterScore) {
    return {
      ok: false,
      reason: `SCORE_BELOW poolScore=${poolScore} enter=${CONFIG.smartMoneyCopyPoolEnterScore}`,
    };
  }
  return { ok: true, reason: 'SHOULD_ENTER' };
}

async function seed(wallet: string): Promise<void> {
  const now = new Date();
  await prisma.smartMoneyRawAddress.upsert({
    where: { wallet },
    create: {
      wallet,
      sources: ['REPRO_ENRICH_ENTER_STALL'],
      firstSeenAt: now,
      lastSeenAt: now,
      lastIngestedAt: now,
      pipelineStage: 'SCORED',
      dormant: false,
      nextDeepAnalyzeAt: new Date(now.getTime() + 3_600_000),
      scoredMissCount: 0,
    },
    update: {
      pipelineStage: 'SCORED',
      dormant: false,
      nextDeepAnalyzeAt: new Date(now.getTime() + 3_600_000),
    },
  });
  await prisma.smartMoneyLeaderboardRow.upsert({
    where: { wallet },
    create: baseLeaderboardCreate(wallet, now),
    update: {
      score: new Prisma.Decimal('72'),
      traderScore: new Prisma.Decimal('72'),
      copyabilityScore: new Prisma.Decimal('55'),
      copyabilityComputedAt: now,
      riskFlags: [],
      inCopyPool: false,
      enrichPending: true,
      activeCandidate: false,
      eligible: false,
      rank: null,
      copyPoolEnteredAt: null,
      copyPoolExitedAt: null,
      lastScoredAt: now,
    },
  });
}

async function main(): Promise<void> {
  console.log('[repro] config', {
    copyReadyRequired: CONFIG.smartMoneyCopyReadyRequiredForPool,
    enterScore: CONFIG.smartMoneyCopyPoolEnterScore,
    traderScoreAsPrimary: CONFIG.smartMoneyTraderScoreAsPrimary,
    traderScoreNextAsPrimary: CONFIG.smartMoneyTraderScoreNextAsPrimary,
  });

  await seed(WALLET);
  const before = await prisma.smartMoneyLeaderboardRow.findUniqueOrThrow({
    where: { wallet: WALLET },
    select: {
      inCopyPool: true,
      enrichPending: true,
      copyabilityScore: true,
      traderScore: true,
      score: true,
      riskFlags: true,
      copyPoolEnteredAt: true,
    },
  });
  const gateBefore = diagnoseEnterGate(before);
  console.log('[repro] before', {
    inCopyPool: before.inCopyPool,
    enrichPending: before.enrichPending,
    traderScore: before.traderScore?.toString() ?? null,
    copyabilityScore: before.copyabilityScore?.toString() ?? null,
    gate: gateBefore,
  });

  // === Case A：对齐 Enrich 尾部 —— tryEnter 后无论成败清 pending ===
  const enteredA = await tryEnterCopyPoolAfterCopyReady(WALLET);
  await prisma.smartMoneyLeaderboardRow.updateMany({
    where: { wallet: WALLET },
    data: { enrichPending: false },
  });
  const afterA = await prisma.smartMoneyLeaderboardRow.findUniqueOrThrow({
    where: { wallet: WALLET },
    select: {
      inCopyPool: true,
      enrichPending: true,
      copyPoolEnteredAt: true,
      traderScore: true,
      score: true,
      riskFlags: true,
      copyabilityScore: true,
    },
  });
  console.log('[repro] caseA tryEnter+clearPending', {
    entered: enteredA.entered,
    reason: enteredA.reason,
    inCopyPool: afterA.inCopyPool,
    enrichPending: afterA.enrichPending,
    copyPoolEnteredAt: afterA.copyPoolEnteredAt,
    gate: diagnoseEnterGate(afterA),
  });

  // === Case B：模拟 tryEnter 因 COPY_READY=false 静默失败 + 仍清 pending ===
  const walletB = '0xreproenrichenterstall000000000000000002';
  await seed(walletB);
  const savedCopyReady = CONFIG.smartMoneyCopyReadyRequiredForPool;
  (CONFIG as { smartMoneyCopyReadyRequiredForPool: boolean }).smartMoneyCopyReadyRequiredForPool =
    false;
  const enteredB = await tryEnterCopyPoolAfterCopyReady(walletB);
  await prisma.smartMoneyLeaderboardRow.updateMany({
    where: { wallet: walletB },
    data: { enrichPending: false },
  });
  (CONFIG as { smartMoneyCopyReadyRequiredForPool: boolean }).smartMoneyCopyReadyRequiredForPool =
    savedCopyReady;
  const afterB = await prisma.smartMoneyLeaderboardRow.findUniqueOrThrow({
    where: { wallet: walletB },
    select: {
      inCopyPool: true,
      enrichPending: true,
      copyPoolEnteredAt: true,
      traderScore: true,
      score: true,
      riskFlags: true,
      copyabilityScore: true,
    },
  });
  const gateBWithReady = diagnoseEnterGate(afterB);
  console.log('[repro] caseB COPY_READY=false then clearPending', {
    entered: enteredB.entered,
    reason: enteredB.reason,
    inCopyPool: afterB.inCopyPool,
    enrichPending: afterB.enrichPending,
    gateAfterRestore: gateBWithReady,
    stall:
      enteredB.entered === false &&
      afterB.enrichPending === false &&
      afterB.inCopyPool === false &&
      gateBWithReady.ok === true,
  });

  // === Case C：Enrich 重算后分掉线（traderScore 被打到 < enter）仍清 pending ===
  const walletC = '0xreproenrichenterstall000000000000000003';
  await seed(walletC);
  await prisma.smartMoneyLeaderboardRow.update({
    where: { wallet: walletC },
    data: { traderScore: new Prisma.Decimal('35'), score: new Prisma.Decimal('35') },
  });
  const enteredC = await tryEnterCopyPoolAfterCopyReady(walletC);
  await prisma.smartMoneyLeaderboardRow.updateMany({
    where: { wallet: walletC },
    data: { enrichPending: false },
  });
  const afterC = await prisma.smartMoneyLeaderboardRow.findUniqueOrThrow({
    where: { wallet: walletC },
    select: {
      inCopyPool: true,
      enrichPending: true,
      traderScore: true,
      score: true,
      riskFlags: true,
      copyabilityScore: true,
    },
  });
  console.log('[repro] caseC scoreBelow+clearPending', {
    entered: enteredC.entered,
    reason: enteredC.reason,
    inCopyPool: afterC.inCopyPool,
    enrichPending: afterC.enrichPending,
    gate: diagnoseEnterGate(afterC),
    stallPattern:
      enteredC.entered === false &&
      afterC.enrichPending === false &&
      afterC.inCopyPool === false,
  });

  const caseAOk = enteredA.entered === true && afterA.inCopyPool === true;
  const caseBStall =
    enteredB.entered === false &&
    afterB.enrichPending === false &&
    afterB.inCopyPool === false &&
    gateBWithReady.ok === true;
  const caseCStall =
    enteredC.entered === false &&
    afterC.enrichPending === false &&
    afterC.inCopyPool === false;

  console.log('[repro] verdict', {
    caseA_cleanShouldEnter: caseAOk ? 'PASS_enter_works' : 'FAIL_tryEnter_broken_on_clean',
    caseB_copyReadyOffSilentFail: caseBStall ? 'REPRODUCED' : 'not_reproduced',
    caseC_scoreDropClearsPending: caseCStall ? 'REPRODUCED' : 'not_reproduced',
    note: '生产 pending↓ + real_new_enter=0 对齐 caseB/C：成功清队但不进池',
  });

  if (!caseAOk) {
    console.error('[repro] CRITICAL: clean wallet failed tryEnter under current local CONFIG');
    process.exitCode = 2;
  } else if (caseBStall || caseCStall) {
    console.error('[repro] REPRODUCED stall patterns (silent tryEnter fail + clear pending)');
    process.exitCode = 2;
  }

  await prisma.smartMoneyLeaderboardRow.deleteMany({
    where: { wallet: { in: [WALLET, walletB, walletC] } },
  });
  await prisma.smartMoneyRawAddress.deleteMany({
    where: { wallet: { in: [WALLET, walletB, walletC] } },
  });
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[repro] fatal', err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
