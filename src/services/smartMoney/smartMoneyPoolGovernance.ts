/**
 * Phase G：QUALIFIED/SCORED 池硬顶治理。
 * 超限优先 ELIMINATED（腾 Deep 配额），可选 dormant。
 */
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { moveToEliminated } from './smartMoneyEliminated';
import { hasLeaderboardSource, isFastTrackSource } from './smartMoneyRawSource';

export type SmartMoneyPoolGovernanceResult = {
  rawStaleDormant: number;
  rawWeakDormant: number;
  qualifiedDormant: number;
  qualifiedEliminated: number;
  scoredDormant: number;
  scoredEliminated: number;
};

/** H-R1：弱信号 RAW 长期未活跃 → dormant（无榜源） */
async function dormifyWeakRawSignals(now: Date): Promise<number> {
  const days = CONFIG.smartMoneyRawWeakDormantDays;
  if (days <= 0) return 0;

  const staleBefore = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const candidates = await prisma.smartMoneyRawAddress.findMany({
    where: {
      dormant: false,
      pipelineStage: 'RAW',
      tier1lPassedAt: null,
      lastSeenAt: { lt: staleBefore },
    },
    select: { wallet: true, sources: true },
    take: 5000,
  });

  const wallets = candidates
    .filter((row) => !hasLeaderboardSource(row.sources) && !isFastTrackSource(row.sources))
    .map((row) => row.wallet);

  if (wallets.length === 0) return 0;

  const updated = await prisma.smartMoneyRawAddress.updateMany({
    where: { wallet: { in: wallets } },
    data: { dormant: true },
  });
  return updated.count;
}

/** RAW 长期未 Light、QUALIFIED/SCORED 超 cap → dormant 或 ELIMINATED */
export async function runSmartMoneyPoolGovernanceTick(): Promise<SmartMoneyPoolGovernanceResult> {
  const result: SmartMoneyPoolGovernanceResult = {
    rawStaleDormant: 0,
    rawWeakDormant: 0,
    qualifiedDormant: 0,
    qualifiedEliminated: 0,
    scoredDormant: 0,
    scoredEliminated: 0,
  };

  const now = new Date();
  result.rawWeakDormant = await dormifyWeakRawSignals(now);

  const staleBefore = new Date(
    Date.now() - CONFIG.smartMoneyRawStaleDormantDays * 24 * 60 * 60 * 1000
  );
  const rawStale = await prisma.smartMoneyRawAddress.updateMany({
    where: {
      dormant: false,
      pipelineStage: 'RAW',
      tier1lPassedAt: null,
      lastSeenAt: { lt: staleBefore },
    },
    data: { dormant: true },
  });
  result.rawStaleDormant = rawStale.count;

  if (CONFIG.smartMoneyQualifiedMaxActive > 0) {
    const qualifiedActive = await prisma.smartMoneyRawAddress.count({
      where: { pipelineStage: 'QUALIFIED', dormant: false },
    });
    const overflow = qualifiedActive - CONFIG.smartMoneyQualifiedMaxActive;
    if (overflow > 0) {
      const victims = await prisma.smartMoneyRawAddress.findMany({
        where: { pipelineStage: 'QUALIFIED', dormant: false },
        orderBy: [{ lastSeenAt: 'asc' }, { wallet: 'asc' }],
        take: overflow,
        select: { wallet: true },
      });
      if (CONFIG.smartMoneyQualifiedOverCapAction === 'eliminated') {
        for (const row of victims) {
          await moveToEliminated(row.wallet, 'QUALIFIED_CAP');
          result.qualifiedEliminated += 1;
        }
      } else if (victims.length > 0) {
        const updated = await prisma.smartMoneyRawAddress.updateMany({
          where: { wallet: { in: victims.map((r) => r.wallet) } },
          data: { dormant: true },
        });
        result.qualifiedDormant = updated.count;
      }
    }
  }

  if (CONFIG.smartMoneyScoredMaxActive > 0) {
    const scoredActive = await prisma.smartMoneyRawAddress.count({
      where: { pipelineStage: 'SCORED', dormant: false },
    });
    const overflow = scoredActive - CONFIG.smartMoneyScoredMaxActive;
    if (overflow > 0) {
      const victims = await prisma.smartMoneyRawAddress.findMany({
        where: { pipelineStage: 'SCORED', dormant: false },
        orderBy: [
          { scoredMissCount: 'desc' },
          { lastDeepQueuedAt: { sort: 'asc', nulls: 'first' } },
          { lastSeenAt: 'asc' },
        ],
        take: overflow,
        select: { wallet: true },
      });
      for (const row of victims) {
        await moveToEliminated(row.wallet, 'SCORED_CAP');
        result.scoredEliminated += 1;
      }
    }
  }

  if (
    result.rawStaleDormant > 0 ||
    result.rawWeakDormant > 0 ||
    result.qualifiedDormant > 0 ||
    result.qualifiedEliminated > 0 ||
    result.scoredDormant > 0 ||
    result.scoredEliminated > 0
  ) {
    console.log('[smart-money-pool-governance]', result);
  }

  return result;
}

export async function countQualifiedOverCap(): Promise<number> {
  if (CONFIG.smartMoneyQualifiedMaxActive <= 0) return 0;
  const active = await prisma.smartMoneyRawAddress.count({
    where: { pipelineStage: 'QUALIFIED', dormant: false },
  });
  return Math.max(0, active - CONFIG.smartMoneyQualifiedMaxActive);
}

export async function countScoredActive(): Promise<number> {
  return prisma.smartMoneyRawAddress.count({
    where: { pipelineStage: 'SCORED', dormant: false },
  });
}
