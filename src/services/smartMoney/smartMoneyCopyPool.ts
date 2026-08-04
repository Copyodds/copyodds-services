import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import type { SmartMoneyScoreResult } from './smartMoneyScorer';
import { evaluateTier2Enhanced, hasCopyPoolHardFlag, buildCopyPoolHardElimReason } from './smartMoneyTierGate';
import { upsertSmartMoneyLeaderboardRow } from './smartMoneyLeaderboardWriter';
import { transitionPipelineStage } from './smartMoneyPipeline';
import type { ClosedMarketReturnDistribution } from './smartMoneyPositionStats';
import type { SmartMoneyMarketLiquidityProfile } from './smartMoneyMarketLiquidity';
import {
  computeCopyPoolNextDeepAnalyzeAt,
  resolveCopyPoolRescoreRank,
} from './smartMoneyCopyPoolReschedule';
import {
  computeDualChannelNextDeepAnalyzeAt,
  isDualChannelRescoreMode,
} from './smartMoneyCopyPoolRescoreChannels';
import { assignApproximateRankIfMissing } from './smartMoneyApproxRank';
import { moveToEliminated } from './smartMoneyEliminated';
import { resolveCopyPoolMetricScore } from './smartMoneyPoolScore';
import { shouldExitCopyPoolForInactivity } from './smartMoneyCopyPoolInactivity';
import {
  isCopyabilityComputed,
  isCopyabilityReadyForPool,
  isCopyabilityEligibleForPoolEnter,
} from './smartMoneyCopyReady';

export {
  isCopyabilityComputed,
  isCopyabilityReadyForPool,
  isCopyabilityEligibleForPoolEnter,
} from './smartMoneyCopyReady';

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 从 scoreExplain.displayProfile 取 trades7d */
function readTrades7d(scoreResult: SmartMoneyScoreResult): number | null {
  const explain = scoreResult.scoreExplain as {
    displayProfile?: { trades7d?: unknown };
  } | null;
  return numberOrNull(explain?.displayProfile?.trades7d);
}

async function scheduleCopyPoolRescore(wallet: string): Promise<void> {
  if (isDualChannelRescoreMode()) {
    const row = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet },
      select: { rank: true },
    });
    const channel =
      row?.rank != null &&
      row.rank >= 1 &&
      row.rank <= CONFIG.smartMoneyCopyPoolDailyTopN
        ? 'priority'
        : 'background';
    await transitionPipelineStage(wallet, 'COPY_POOL', {
      nextDeepAnalyzeAt: computeDualChannelNextDeepAnalyzeAt(new Date(), channel),
    });
    return;
  }
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: { rank: true },
  });
  const effectiveRank = await resolveCopyPoolRescoreRank({
    wallet,
    rank: row?.rank ?? null,
  });
  await transitionPipelineStage(wallet, 'COPY_POOL', {
    nextDeepAnalyzeAt: computeCopyPoolNextDeepAnalyzeAt(effectiveRank),
  });
}

export type CopyPoolExitReason = 'INACTIVE' | 'EXIT_SCORE' | 'HARD_FLAG' | 'COPY_TOO_LOW';
export type CopyPoolEnterBlockedReason =
  | 'SCORE_BELOW'
  | 'TIER2E'
  | 'HARD_FLAG'
  | 'COPY_NOT_READY'
  /** 仿跟单已算出但为 0（无可复制信号），不入榜、不再排队 Enrich */
  | 'COPY_TOO_LOW';

export type SyncCopyPoolResult = {
  inCopyPool: boolean;
  entered: boolean;
  exited: boolean;
  exitReason?: CopyPoolExitReason | null;
  enterBlockedReason?: CopyPoolEnterBlockedReason | null;
};

export async function removeFromCopyPool(wallet: string): Promise<void> {
  const now = new Date();
  const existing = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: { copyabilityScore: true, traderScore: true, score: true },
  });
  const poolScore = resolveCopyPoolMetricScore({
    traderScore: existing?.traderScore != null ? Number(existing.traderScore) : null,
    score: existing?.score != null ? Number(existing.score) : 0,
  });
  // 出池后若仍达线且仿跟单未算完，保持/恢复 Enrich 排队，避免 enrichPending 被清后空转
  const keepEnrichPending =
    CONFIG.smartMoneyCopyReadyRequiredForPool &&
    !isCopyabilityComputed(
      existing?.copyabilityScore != null ? Number(existing.copyabilityScore) : null
    ) &&
    poolScore >= CONFIG.smartMoneyCopyPoolEnterScore;

  await prisma.$transaction(async (tx) => {
    await tx.smartMoneyLeaderboardRow.updateMany({
      where: { wallet },
      data: {
        inCopyPool: false,
        copyPoolExitedAt: now,
        rank: null,
        activeCandidate: false,
        eligible: false,
        enrichPending: keepEnrichPending,
      },
    });
    await tx.smartMoneyRawAddress.updateMany({
      where: { wallet },
      data: {
        pipelineStage: 'SCORED',
        nextDeepAnalyzeAt: new Date(now.getTime() + CONFIG.smartMoneyScoredRecheckMs),
        updatedAt: now,
      },
    });
  });
}

/**
 * 排行榜池（§15 单轨）：入出线看 TraderScore（产品主分；无值时回落 v4 score）+ hard flag。
 * Tier2E 仅当 SMART_MONEY_COPY_POOL_REQUIRE_TIER2E=true 时硬拦。
 * 池分 ≤ EXIT：立即出池（与 rank flush purgeBelowExit 同权威，无 miss 迟滞）。
 * 灰区 (EXIT, ENTER)：在池老人可滞留；新人不可进入。
 * F8：展示/入出本期以 traderScore 为准（displayScore 为其别名）。
 */
export async function syncSmartMoneyCopyPool(input: {
  scoreResult: SmartMoneyScoreResult;
  tier2EnhancedPassed: boolean;
  closedMarketReturnDistribution: ClosedMarketReturnDistribution | null;
  marketLiquidityProfile: SmartMoneyMarketLiquidityProfile | null;
  /** Gate 路径入榜后待补仿真 */
  enrichPending?: boolean;
  /** 按需未入榜分析不应改写排行榜 pipelineStage。默认 true 保持批处理行为。 */
  mutatePipelineStage?: boolean;
  /** 按需分析只负责入/出榜，不写 ELIMINATED。默认 true 保持批处理治理。 */
  allowElimination?: boolean;
}): Promise<SyncCopyPoolResult> {
  const { scoreResult } = input;
  const wallet = scoreResult.wallet;
  const poolScore = resolveCopyPoolMetricScore({
    traderScore: scoreResult.traderScore,
    score: scoreResult.score,
  });
  const flags = scoreResult.riskFlags;
  const enrichPending = input.enrichPending === true;
  const mutatePipelineStage = input.mutatePipelineStage !== false;
  const allowElimination = input.allowElimination !== false;

  if (hasCopyPoolHardFlag(flags)) {
    const existing = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet },
      select: { inCopyPool: true },
    });
    if (existing?.inCopyPool) {
      await removeFromCopyPool(wallet);
    }
    if (allowElimination) {
      const reason = buildCopyPoolHardElimReason(flags) ?? 'COPY_HARD';
      await moveToEliminated(wallet, reason);
    }
    return {
      inCopyPool: false,
      entered: false,
      exited: existing?.inCopyPool === true,
      exitReason: existing?.inCopyPool === true ? 'HARD_FLAG' : null,
      enterBlockedReason: 'HARD_FLAG',
    };
  }

  let tier2eOk = true;
  if (CONFIG.smartMoneyCopyPoolRequireTier2e) {
    const t2e = evaluateTier2Enhanced({
      closedMarketReturnDistribution: input.closedMarketReturnDistribution,
      marketLiquidityProfile: input.marketLiquidityProfile,
    });
    tier2eOk = input.tier2EnhancedPassed && t2e.passed;
  }

  const copyComputed = isCopyabilityComputed(scoreResult.copyabilityScore);
  const copyEligible = isCopyabilityEligibleForPoolEnter(scoreResult.copyabilityScore);
  const copyGateOk = !CONFIG.smartMoneyCopyReadyRequiredForPool || copyEligible;
  const scoreEnterOk = tier2eOk && poolScore >= CONFIG.smartMoneyCopyPoolEnterScore;
  const canEnter = scoreEnterOk && copyGateOk;

  const [existing, rawRow] = await Promise.all([
    prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet },
      select: {
        inCopyPool: true,
        copyPoolMissCount: true,
        holdingsValue: true,
        trades7d: true,
        trades30d: true,
        copyabilityScore: true,
      },
    }),
    prisma.smartMoneyRawAddress.findUnique({
      where: { wallet },
      select: { lastTradeAt: true },
    }),
  ]);

  if (!existing?.inCopyPool && canEnter) {
    const now = new Date();
    await upsertSmartMoneyLeaderboardRow(scoreResult);
    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet },
      data: {
        inCopyPool: true,
        copyPoolEnteredAt: now,
        copyPoolExitedAt: null,
        copyPoolMissCount: 0,
        activeCandidate: true,
        eligible: true,
        enrichPending,
      },
    });
    await assignApproximateRankIfMissing({
      wallet,
      score: scoreResult.score,
      traderScore: scoreResult.traderScore,
      tier: scoreResult.tier,
    }).catch(() => null);
    await scheduleCopyPoolRescore(wallet);
    return { inCopyPool: true, entered: true, exited: false, exitReason: null };
  }

  if (existing?.inCopyPool) {
    const holdingsUsd =
      numberOrNull(scoreResult.holdingsValue) ??
      numberOrNull(existing.holdingsValue) ??
      0;
    const trades7d = readTrades7d(scoreResult) ?? existing.trades7d ?? null;
    if (
      shouldExitCopyPoolForInactivity({
        holdingsValueUsd: holdingsUsd,
        trades7d,
        lastTradeAt: rawRow?.lastTradeAt ?? null,
        exitDays: CONFIG.smartMoneyCopyPoolInactiveExitDays,
        maxHoldingsUsd: CONFIG.smartMoneyCopyPoolInactiveMaxHoldingsUsd,
      })
    ) {
      await upsertSmartMoneyLeaderboardRow(scoreResult);
      await removeFromCopyPool(wallet);
      if (allowElimination) {
        await moveToEliminated(wallet, 'INACTIVE_FLAT_EXIT').catch(() => undefined);
      }
      return {
        inCopyPool: false,
        entered: false,
        exited: true,
        exitReason: 'INACTIVE',
      };
    }

    // Deep Gate 常不带 copyability：必须以库内已落库值为准，避免误踢已 Enrich 的池内地址。
    // 仅当本次结果与库内都未算出时，才出池并等 Enrich。
    const dbCopyScore =
      existing.copyabilityScore != null ? Number(existing.copyabilityScore) : null;
    const dbCopyComputed = isCopyabilityComputed(dbCopyScore);
    if (CONFIG.smartMoneyCopyReadyRequiredForPool && !copyComputed && !dbCopyComputed) {
      await upsertSmartMoneyLeaderboardRow(scoreResult);
      await removeFromCopyPool(wallet);
      return {
        inCopyPool: false,
        entered: false,
        exited: true,
        exitReason: 'COPY_TOO_LOW',
        enterBlockedReason: 'COPY_NOT_READY',
      };
    }

    const effectiveCopyScore = copyComputed
      ? scoreResult.copyabilityScore
      : dbCopyScore;
    if (
      CONFIG.smartMoneyCopyReadyRequiredForPool &&
      isCopyabilityComputed(effectiveCopyScore) &&
      !isCopyabilityEligibleForPoolEnter(effectiveCopyScore)
    ) {
      await upsertSmartMoneyLeaderboardRow(scoreResult);
      await removeFromCopyPool(wallet);
      if (allowElimination) {
        await moveToEliminated(
          wallet,
          `COPY_TOO_LOW|copyability=${effectiveCopyScore ?? 'null'}|min=${CONFIG.smartMoneyCopyPoolMinComposite}`
        );
      }
      return {
        inCopyPool: false,
        entered: false,
        exited: true,
        exitReason: 'COPY_TOO_LOW',
        enterBlockedReason: 'COPY_TOO_LOW',
      };
    }

    // ≤ EXIT：立即出池（与 flush purgeBelowExit 同权威）
    if (poolScore <= CONFIG.smartMoneyCopyPoolExitScore) {
      await upsertSmartMoneyLeaderboardRow(scoreResult);
      await removeFromCopyPool(wallet);
      return {
        inCopyPool: false,
        entered: false,
        exited: true,
        exitReason: 'EXIT_SCORE',
      };
    }

    await upsertSmartMoneyLeaderboardRow(scoreResult);
    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet },
      data: {
        copyPoolMissCount: 0,
        inCopyPool: true,
        activeCandidate: true,
        eligible: true,
        ...(enrichPending ? { enrichPending: true } : {}),
      },
    });
    await scheduleCopyPoolRescore(wallet);
    return { inCopyPool: true, entered: false, exited: false, exitReason: null };
  }

  if (mutatePipelineStage) {
    await transitionPipelineStage(wallet, 'SCORED', {
      nextDeepAnalyzeAt: new Date(Date.now() + CONFIG.smartMoneyScoredRecheckMs),
    });
  }

  // 榜前 Copy：达线但尚未算出仿跟单 → 排队 Enrich，不展示、不累加 Deep miss
  if (scoreEnterOk && CONFIG.smartMoneyCopyReadyRequiredForPool && !copyComputed) {
    await upsertSmartMoneyLeaderboardRow(scoreResult);
    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet },
      data: {
        inCopyPool: false,
        enrichPending: true,
        activeCandidate: false,
        eligible: false,
        rank: null,
      },
    });
    return {
      inCopyPool: false,
      entered: false,
      exited: false,
      exitReason: null,
      enterBlockedReason: 'COPY_NOT_READY',
    };
  }

  // 已算出但综合分 < MIN：不入榜、不占 Enrich；允许淘汰时直接 ELIMINATED
  if (scoreEnterOk && CONFIG.smartMoneyCopyReadyRequiredForPool && copyComputed && !copyEligible) {
    await upsertSmartMoneyLeaderboardRow(scoreResult);
    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet },
      data: {
        inCopyPool: false,
        enrichPending: false,
        activeCandidate: false,
        eligible: false,
        rank: null,
      },
    });
    if (allowElimination) {
      const score =
        scoreResult.copyabilityScore != null ? Number(scoreResult.copyabilityScore) : null;
      await moveToEliminated(
        wallet,
        `COPY_TOO_LOW|copyability=${score ?? 'null'}|min=${CONFIG.smartMoneyCopyPoolMinComposite}`
      );
    }
    return {
      inCopyPool: false,
      entered: false,
      exited: false,
      exitReason: null,
      enterBlockedReason: 'COPY_TOO_LOW',
    };
  }

  // 已算出（含有效 copy）但仍未入：只可能是分不够 / Tier2E
  return {
    inCopyPool: false,
    entered: false,
    exited: false,
    exitReason: null,
    enterBlockedReason: !tier2eOk ? 'TIER2E' : 'SCORE_BELOW',
  };
}
