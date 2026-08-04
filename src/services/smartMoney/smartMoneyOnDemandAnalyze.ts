import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { resolvePolymarketProfileForAnalyze } from './smartMoneyProfilePersist';
import { ensureGateUserPnlCurves } from './smartMoneyUserPnlCurves';
import { runClosedPrefetchForWallet } from './smartMoneyClosedPrefetch';
import { loadReadyClosedFetchResult, seedFullSnapshotFromGate } from './smartMoneyClosedSnapshot';
import { executeSmartMoneyFullScore } from './smartMoneyScoreRunner';
import { upsertSmartMoneyScoreCache } from './smartMoneyScoreCache';
import { removeFromCopyPool, syncSmartMoneyCopyPool } from './smartMoneyCopyPool';
import { ingestSmartMoneyRawAddresses } from './smartMoneyRawIngest';
import {
  evaluateL1CandidateGate,
  evaluateL1CurveEarlyReject,
  evaluateTier1L,
  evaluateTier2Enhanced,
  extractL1DisplayAlignedMetrics,
  extractResolvedTotalPnl,
  hasCopyPoolHardFlag,
} from './smartMoneyTierGate';
import {
  extractLeaderboardDisplayColumns,
  markSmartMoneyRanksDirty,
  upsertSmartMoneyLeaderboardRow,
} from './smartMoneyLeaderboardWriter';
import { resolveCopyPoolMetricScore } from './smartMoneyPoolScore';
import {
  buildBoardEligibilityExplain,
  mergeBoardEligibilityIntoExplain,
} from './smartMoneyBoardEligibility';
import { runCopyabilityEnrichmentForWallet } from './smartMoneyCopyabilityEnrich';
import { isCopyabilityComputed } from './smartMoneyCopyReady';

export type OnDemandAnalyzeResult = {
  wallet: string;
  success: boolean;
  scored: boolean;
  scoredComplete: boolean;
  inCopyPool: boolean;
  enteredCopyPool: boolean;
  eligibleForPool: boolean;
  l1FailReason: string | null;
  blockedReason: 'TIER1L' | 'L1_EARLY' | 'L1' | 'HARD_FLAG' | null;
  exclusionReasons?: string[];
  error?: string;
};

const LEADERBOARD_PRIORITY_LEASES = [
  'smart-money-fetch-cron',
  'smart-money-deep-cron',
  'smart-money-closed-prefetch-cron',
  'smart-money-closed-full-enrich-cron',
  'smart-money-gamma-cron',
  'smart-money-curve-enrich-cron',
  'smart-money-copyability-enrich-cron',
];

async function waitForLeaderboardIdle(signal?: AbortSignal): Promise<void> {
  while (true) {
    signal?.throwIfAborted();
    const busy = await prisma.cronLease.count({
      where: {
        key: { in: LEADERBOARD_PRIORITY_LEASES },
        expiresAt: { gt: new Date() },
      },
    });
    if (busy === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  }
}

async function ensureClosedGateReady(wallet: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    signal?.throwIfAborted();
    const ready = await loadReadyClosedFetchResult(wallet, 'GATE');
    if (ready) return ready;

    await waitForLeaderboardIdle(signal);
    const fetched = await runClosedPrefetchForWallet(wallet, 'GATE');
    if (!fetched.success) {
      throw new Error(fetched.error ?? 'closed_prefetch_failed');
    }
    if (fetched.ready) {
      const result = await loadReadyClosedFetchResult(wallet, 'GATE');
      if (result) return result;
    }
    if (fetched.pagesFetched === 0) break;
  }
  throw new Error('closed_prefetch_not_ready');
}

async function removeFromPoolIfPresent(wallet: string): Promise<void> {
  const existing = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: { inCopyPool: true },
  });
  if (existing?.inCopyPool) {
    await removeFromCopyPool(wallet);
    markSmartMoneyRanksDirty();
  }
}

async function persistBoardEligibility(
  scoreResult: Awaited<ReturnType<typeof executeSmartMoneyFullScore>>['scoreResult'],
  eligibilityInput: Parameters<typeof buildBoardEligibilityExplain>[0]
): Promise<string[]> {
  const eligibility = buildBoardEligibilityExplain(eligibilityInput);
  scoreResult.scoreExplain = mergeBoardEligibilityIntoExplain(
    scoreResult.scoreExplain,
    eligibility
  );
  await upsertSmartMoneyScoreCache(scoreResult);
  return eligibility.reasons;
}

/**
 * 与排行榜 Enrich 同款：补三情景仿跟单并重算 TraderScore。
 * allowPoolEnter=false 用于门槛未过的按需分析（只完善分数，不入池）。
 */
async function completeOnDemandCopyability(input: {
  wallet: string;
  scoreResult: Awaited<ReturnType<typeof executeSmartMoneyFullScore>>['scoreResult'];
  signal?: AbortSignal;
  allowPoolEnter: boolean;
}): Promise<{ copyabilityScore: number | null; ok: boolean }> {
  // refreshCopyability 以榜行为准；先落榜行（不一定 inCopyPool）
  await upsertSmartMoneyLeaderboardRow(input.scoreResult);
  if (!input.allowPoolEnter) {
    await prisma.smartMoneyLeaderboardRow.update({
      where: { wallet: input.wallet },
      data: {
        inCopyPool: false,
        enrichPending: false,
        activeCandidate: false,
        eligible: false,
        rank: null,
      },
    });
  }
  const enrich = await runCopyabilityEnrichmentForWallet(input.wallet, {
    signal: input.signal,
    allowPoolEnter: input.allowPoolEnter,
  });
  if (!enrich.success) {
    return { copyabilityScore: null, ok: false };
  }
  // 把 Enrich 后的 explain 拉回 scoreResult，供后续 boardEligibility 写入
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet: input.wallet },
    select: {
      scoreExplain: true,
      copyabilityScore: true,
      traderScore: true,
      inCopyPool: true,
      rank: true,
    },
  });
  if (row?.scoreExplain && typeof row.scoreExplain === 'object') {
    input.scoreResult.scoreExplain = row.scoreExplain as Record<string, unknown>;
  }
  if (row?.traderScore != null && Number.isFinite(Number(row.traderScore))) {
    input.scoreResult.traderScore = Number(row.traderScore);
  }
  if (row?.copyabilityScore != null && Number.isFinite(Number(row.copyabilityScore))) {
    input.scoreResult.copyabilityScore = Number(row.copyabilityScore);
  }
  return {
    copyabilityScore:
      enrich.copyabilityScore ??
      (row?.copyabilityScore != null ? Number(row.copyabilityScore) : null),
    ok: isCopyabilityComputed(
      enrich.copyabilityScore ??
        (row?.copyabilityScore != null ? Number(row.copyabilityScore) : null)
    ),
  };
}

/**
 * 用户按需地址分析：
 * - 复用现有 Profile / Closed Snapshot / 评分 / CopyPool；
 * - 失败或不达标只保存详情，不写 ELIMINATED；
 * - 未入榜时不改写排行榜 pipelineStage。
 */
export async function runOnDemandAnalyzeForWallet(
  rawWallet: string,
  options?: { signal?: AbortSignal }
): Promise<OnDemandAnalyzeResult> {
  const wallet = rawWallet.trim().toLowerCase();
  const signal = options?.signal;

  try {
    const resolved = await resolvePolymarketProfileForAnalyze(wallet, { forceLive: true });
    signal?.throwIfAborted();
    await ensureGateUserPnlCurves(wallet, {
      profileFilledPeriods: resolved.profile.profilePnlApiFilledPeriods ?? null,
    });
    signal?.throwIfAborted();

    const profile = resolved.profile;
    const tier1l = evaluateTier1L(profile);
    const early = evaluateL1CurveEarlyReject(profile);
    const closedOverride = await ensureClosedGateReady(wallet, signal);
    await waitForLeaderboardIdle(signal);
    const scoredBundle = await executeSmartMoneyFullScore(profile, {
      signal,
      mode: 'gate',
      closedOverride,
    });
    signal?.throwIfAborted();

    const {
      scoreResult,
      tradeCount30d,
      tradeCount7d,
      closedMarketReturnDistribution,
      marketLiquidityProfile,
      closedFetchOk,
      tradesFetchOk,
    } = scoredBundle;

    if (!closedFetchOk || !tradesFetchOk) {
      throw new Error(
        `data_fetch:${[!closedFetchOk ? 'closed' : null, !tradesFetchOk ? 'trades' : null]
          .filter(Boolean)
          .join('+')}`
      );
    }
    await upsertSmartMoneyScoreCache(scoreResult);

    const totalVolume =
      scoreResult.metrics.totalVolume ??
      (profile.totalVolume != null ? Number(profile.totalVolume) : null);
    const aligned = extractL1DisplayAlignedMetrics(scoreResult);
    const explain = scoreResult.scoreExplain as {
      closedPositions?: {
        marketWinRate?: number | null;
        marketCount?: number;
        decisiveMarkets?: number;
        profitFactorNoLoss?: boolean;
      };
      displayProfile?: {
        winRate?: number | null;
        profitFactor?: number | null;
        profitFactorNoLoss?: boolean;
        medianNotionalUsd?: number | null;
        dustShare?: number | null;
        tradeNotionalSampleCount?: number;
      };
    };
    const closedWinRate =
      explain.closedPositions?.marketWinRate ??
      explain.displayProfile?.winRate ??
      scoreResult.externalWinRate;
    const closedProfitFactor = explain.displayProfile?.profitFactor ?? null;
    const closedMarketDataMissing =
      scoreResult.riskFlags.includes('CLOSED_POSITIONS_FETCH_FAILED') ||
      scoreResult.riskFlags.includes('CLOSED_RETURN_DATA_MISSING');
    const closedMarketCountRaw =
      explain.closedPositions?.decisiveMarkets ??
      explain.closedPositions?.marketCount ??
      closedMarketReturnDistribution?.sampledMarketCount ??
      null;
    const displayMetrics = extractLeaderboardDisplayColumns(scoreResult.scoreExplain);
    const l1 = evaluateL1CandidateGate({
      profile,
      resolvedTotalPnl: extractResolvedTotalPnl(scoreResult),
      totalVolume,
      effectiveTotalReturn: aligned.effectiveTotalReturn,
      effectiveMaxDrawdown: aligned.effectiveMaxDrawdown,
      winRate: closedWinRate,
      profitFactor: closedProfitFactor,
      profitFactorNoLoss:
        explain.displayProfile?.profitFactorNoLoss === true ||
        explain.closedPositions?.profitFactorNoLoss === true,
      trades7d: tradeCount7d,
      trades30d: tradeCount30d,
      tradesFetchOk,
      closedMarketCount: closedMarketDataMissing ? null : (closedMarketCountRaw ?? 0),
      closedMarketDataMissing,
      closedFetchFailed: false,
      totalPnl1y: displayMetrics.accountPnl1y,
      pnlWindowDays: displayMetrics.pnlWindowDays,
      totalReturn1y: displayMetrics.totalReturn1y,
      maxDrawdown1y: displayMetrics.maxDrawdown1y,
      maxDrawdownUsd1y: displayMetrics.maxDrawdownUsd1y,
      medianNotionalUsd: explain.displayProfile?.medianNotionalUsd ?? null,
      dustShare: explain.displayProfile?.dustShare ?? null,
      tradeNotionalSampleCount: explain.displayProfile?.tradeNotionalSampleCount ?? 0,
    });

    const hardFlag = hasCopyPoolHardFlag(scoreResult.riskFlags);
    const blockedReason = !tier1l.passed
      ? 'TIER1L'
      : !early.passed
        ? 'L1_EARLY'
        : !l1.passed
          ? 'L1'
          : hardFlag
            ? 'HARD_FLAG'
            : null;

    if (blockedReason) {
      await removeFromPoolIfPresent(wallet);
      const gateFailReason = tier1l.failReason ?? early.failReason ?? l1.failReason ?? null;
      // 与榜同源：补齐三情景仿跟单后再展示多因子 / 不能入榜原因
      const copyDone = await completeOnDemandCopyability({
        wallet,
        scoreResult,
        signal,
        allowPoolEnter: false,
      });
      const exclusionReasons = await persistBoardEligibility(scoreResult, {
        onBoard: false,
        blockedReason,
        gateFailReason,
        riskFlags: scoreResult.riskFlags,
        traderScore: scoreResult.traderScore,
        score: scoreResult.score,
        copyabilityScore: copyDone.copyabilityScore ?? scoreResult.copyabilityScore,
      });
      return {
        wallet,
        success: true,
        scored: true,
        scoredComplete: copyDone.ok,
        inCopyPool: false,
        enteredCopyPool: false,
        eligibleForPool: false,
        l1FailReason: gateFailReason,
        blockedReason,
        exclusionReasons,
      };
    }

    const tier2e = evaluateTier2Enhanced({
      closedMarketReturnDistribution,
      marketLiquidityProfile,
    });
    const poolScore = resolveCopyPoolMetricScore({
      traderScore: scoreResult.traderScore,
      score: scoreResult.score,
    });
    // 只有达到入榜分时才加入 Raw registry，避免普通查询污染排行榜候选池。
    if (
      (!CONFIG.smartMoneyCopyPoolRequireTier2e || tier2e.passed) &&
      poolScore >= CONFIG.smartMoneyCopyPoolEnterScore
    ) {
      await ingestSmartMoneyRawAddresses([{ wallet, source: 'USER_ANALYZE' }]);
    }
    // 先落 Gate 分到榜行（可能 COPY_NOT_READY），再同步跑 Enrich，与排行榜同款管线
    let copyPool = await syncSmartMoneyCopyPool({
      scoreResult,
      tier2EnhancedPassed: tier2e.passed,
      closedMarketReturnDistribution,
      marketLiquidityProfile,
      enrichPending: !isCopyabilityComputed(scoreResult.copyabilityScore),
      mutatePipelineStage: false,
      allowElimination: false,
    });

    const copyDone = await completeOnDemandCopyability({
      wallet,
      scoreResult,
      signal,
      allowPoolEnter: true,
    });

    // Enrich 后可能已入池，重读状态
    const afterRow = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet },
      select: { inCopyPool: true, rank: true, copyabilityScore: true, traderScore: true },
    });
    const inCopyPool = afterRow?.inCopyPool === true;
    if (inCopyPool) {
      await seedFullSnapshotFromGate(wallet).catch(() => undefined);
      markSmartMoneyRanksDirty();
    } else if (!copyPool.inCopyPool && copyDone.ok) {
      // Enrich 已回写 copyability（含 0）与 traderScore；用更新后的 scoreResult 再 sync
      copyPool = await syncSmartMoneyCopyPool({
        scoreResult,
        tier2EnhancedPassed: tier2e.passed,
        closedMarketReturnDistribution,
        marketLiquidityProfile,
        enrichPending: false,
        mutatePipelineStage: false,
        allowElimination: false,
      });
    }

    const exclusionReasons = await persistBoardEligibility(scoreResult, {
      onBoard: inCopyPool || copyPool.inCopyPool,
      enterBlockedReason: copyPool.enterBlockedReason ?? null,
      exitReason: copyPool.exitReason ?? null,
      riskFlags: scoreResult.riskFlags,
      traderScore:
        afterRow?.traderScore != null
          ? Number(afterRow.traderScore)
          : scoreResult.traderScore,
      score: scoreResult.score,
      copyabilityScore:
        copyDone.copyabilityScore ??
        (afterRow?.copyabilityScore != null ? Number(afterRow.copyabilityScore) : null) ??
        scoreResult.copyabilityScore,
    });

    const finalInPool = inCopyPool || copyPool.inCopyPool;
    return {
      wallet,
      success: true,
      scored: true,
      scoredComplete: copyDone.ok,
      inCopyPool: finalInPool,
      enteredCopyPool: copyPool.entered || (finalInPool && !copyPool.inCopyPool),
      eligibleForPool: finalInPool,
      l1FailReason: null,
      blockedReason: null,
      exclusionReasons: finalInPool ? [] : exclusionReasons,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      wallet,
      success: false,
      scored: false,
      scoredComplete: false,
      inCopyPool: false,
      enteredCopyPool: false,
      eligibleForPool: false,
      l1FailReason: null,
      blockedReason: null,
      exclusionReasons: [],
      error: message,
    };
  }
}
