import { CONFIG } from '../../config/env';
import {
  evaluateL1CandidateGate,
  evaluateL1CurveEarlyReject,
  evaluateTier1L,
  evaluateTier2Enhanced,
  extractL1DisplayAlignedMetrics,
  extractResolvedTotalPnl,
  hasCopyPoolHardFlag,
  buildCopyPoolHardElimReason,
} from './smartMoneyTierGate';
import { transitionPipelineStage } from './smartMoneyPipeline';
import { markDeepQueued, pickDeepAnalyzeBatch } from './smartMoneyFetchScheduler';
import { bumpPipelineCursor } from './smartMoneyPipeline';
import { executeSmartMoneyFullScore } from './smartMoneyScoreRunner';
import { upsertSmartMoneyScoreCache } from './smartMoneyScoreCache';
import { removeFromCopyPool, syncSmartMoneyCopyPool } from './smartMoneyCopyPool';
import { isCopyabilityComputed } from './smartMoneyCopyReady';
import { resolvePolymarketProfileForAnalyze } from './smartMoneyProfilePersist';
import { markBlockScanDiscoveryScored } from './blockScanDiscoveryIngest';
import { markSmartMoneyRanksDirty } from './smartMoneyLeaderboardWriter';
import { extractLeaderboardDisplayColumns } from './smartMoneyLeaderboardWriter';
import { mapPool } from '../../copyTrading/services/mapPool';
import { waitSmartMoneyRequestGap } from './smartMoneyRequestGap';
import { moveToEliminated } from './smartMoneyEliminated';
import {
  computeCopyPoolNextDeepAnalyzeAt,
  resolveCopyPoolRescoreRank,
} from './smartMoneyCopyPoolReschedule';
import {
  computeDualChannelNextDeepAnalyzeAt,
  isDualChannelRescoreMode,
} from './smartMoneyCopyPoolRescoreChannels';
import { prisma } from '../../db';
import {
  ensureGateUserPnlCurves,
} from './smartMoneyUserPnlCurves';
import type { PipelineStage } from './smartMoneyPipelineTypes';
import {
  ensureClosedSnapshotRow,
  filterDeepBatchByClosedReady,
  loadReadyClosedFetchResult,
  seedFullSnapshotFromGate,
  topUpDeepBatchWithReadyQualified,
} from './smartMoneyClosedSnapshot';
import { refreshClosedGateIncremental, forceResetGateSnapshotForFullRebuild } from './smartMoneyClosedIncremental';

const DATA_FETCH_RETRY_MS = 15 * 60 * 1000;

export type DeepAnalyzeResult = {
  wallet: string;
  success: boolean;
  scored: boolean;
  inCopyPool: boolean;
  /** 已入池但 rank 可能仍待 flush */
  rankPending?: boolean;
  profileSource?: 'snapshot' | 'live';
  l1FailReason?: string | null;
  copyPoolBlockedReason?: string | null;
  closedSnapshotPurpose?: 'GATE' | 'FULL' | null;
  error?: string;
};

/**
 * 钱包级硬超时：超时不仅向上层抛错，还 abort 传给任务的 signal，
 * 让底层 HTTP 分页/后续阶段真正终止，不留孤儿任务继续占内存与连接。
 */
async function withWalletTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveRestoreStage(previousStage: string): PipelineStage | null {
  const stage = previousStage.toUpperCase();
  if (stage === 'FULL_ANALYZING' || stage === 'LIGHT_ANALYZING') return 'QUALIFIED';
  if (
    stage === 'QUALIFIED' ||
    stage === 'SCORED' ||
    stage === 'COPY_POOL' ||
    stage === 'RAW'
  ) {
    return stage;
  }
  return null;
}

async function scheduleDataFetchRetry(
  wallet: string,
  previousStage: string,
  reason: string
): Promise<void> {
  const restore = resolveRestoreStage(previousStage);
  if (!restore) return;
  await transitionPipelineStage(wallet, restore, {
    nextDeepAnalyzeAt: new Date(Date.now() + DATA_FETCH_RETRY_MS),
    tierFailReason: reason.slice(0, 240),
  }).catch(() => undefined);
}

/**
 * Deep-Gate：候选 → 评分/展示
 * 1) 复检 Tier1L
 * 1b) 曲线早杀 L1-PNL/L1-DD（零 HTTP，省 closed+trades）
 * 1c) Closed Prefetch：无 READY Gate 完整快照 → 短冷却，不现场翻 closed
 * 2) Gate 打分（读快照 + trades 早停，跳过 Gamma/全窗仿真）
 * 2b) closed/trades 上游失败 → 短冷却重试，不进 COLD
 * 3) L1 不过 → ELIMINATED
 * 3b) CopyPool 硬旗（HFT/bot/对冲等）→ ELIMINATED（不占 SCORED）
 * 4) 过门 → ScoreCache → CopyPool（enrichPending）→ markRanksDirty → 播种 Full
 */
export async function runDeepAnalyzeForWallet(
  wallet: string,
  options?: {
    signal?: AbortSignal;
    forceLive?: boolean;
    /** Deep 排队前的 stage，供 SCORED miss 计数 */
    previousStage?: string;
  }
): Promise<DeepAnalyzeResult> {
  const signal = options?.signal;
  const previousStage = (options?.previousStage ?? 'QUALIFIED').toUpperCase();
  try {
    await waitSmartMoneyRequestGap();
    signal?.throwIfAborted();
    const resolved = await resolvePolymarketProfileForAnalyze(wallet, {
      forceLive: options?.forceLive,
    });
    signal?.throwIfAborted();
    // Gate 曲线：TTL/已填周期跳过，禁止无条件双拉 ALL+1W（否则 QUALIFIED 易堆积）
    await ensureGateUserPnlCurves(wallet, {
      profileFilledPeriods: resolved.profile.profilePnlApiFilledPeriods ?? null,
    }).catch(() => undefined);
    signal?.throwIfAborted();
    const profile = resolved.profile;

    const tier1l = evaluateTier1L(profile);
    if (!tier1l.passed) {
      await removeFromCopyPool(profile.wallet).catch(() => undefined);
      await moveToEliminated(profile.wallet, tier1l.failReason ?? 'T1L_FAIL', {
        clearTier1l: true,
      });
      markSmartMoneyRanksDirty();
      return {
        wallet: profile.wallet,
        success: true,
        scored: false,
        inCopyPool: false,
        profileSource: resolved.source,
        l1FailReason: tier1l.failReason ?? 'T1L_FAIL',
        copyPoolBlockedReason: null,
        closedSnapshotPurpose: null,
      };
    }

    // 曲线早杀：不过门则不打 closed/trades
    const early = evaluateL1CurveEarlyReject(profile);
    if (!early.passed) {
      await removeFromCopyPool(profile.wallet).catch(() => undefined);
      await moveToEliminated(
        profile.wallet,
        `L1-EARLY|${early.failReason}|pnl1y=${early.totalPnl1y}|mddUsd1y=${early.maxDrawdownUsd1y}|ret1y=${early.totalReturn1y}|mdd1y=${early.maxDrawdown1y}`
      );
      markSmartMoneyRanksDirty();
      return {
        wallet: profile.wallet,
        success: true,
        scored: false,
        inCopyPool: false,
        profileSource: resolved.source,
        l1FailReason: early.failReason ?? 'L1_EARLY_REJECT',
        copyPoolBlockedReason: null,
        closedSnapshotPurpose: null,
      };
    }

    let closedOverride: Awaited<ReturnType<typeof loadReadyClosedFetchResult>> = null;
    if (CONFIG.smartMoneyClosedPrefetchEnabled && CONFIG.smartMoneyDeepRequireClosedSnapshot) {
      // 复评：先增量追新（短间隔内 skip）；新人 QUALIFIED 仍走 Prefetch 全量
      if (
        CONFIG.smartMoneyClosedIncrementalEnabled &&
        (previousStage === 'SCORED' || previousStage === 'COPY_POOL')
      ) {
        const incremental = await refreshClosedGateIncremental(profile.wallet, {
          signal,
        }).catch(() => null);
        if (incremental?.ready) {
          closedOverride = await loadReadyClosedFetchResult(profile.wallet, 'GATE');
        } else if (incremental?.mode === 'full_rebuild_needed') {
          // 禁止继续读旧 READY；强制清空后交 Prefetch 重建
          await forceResetGateSnapshotForFullRebuild(profile.wallet).catch(() => undefined);
        }
      }
      if (closedOverride == null) {
        closedOverride = await loadReadyClosedFetchResult(profile.wallet, 'GATE');
      }
      if (closedOverride == null) {
        await ensureClosedSnapshotRow(profile.wallet, 'GATE').catch(() => undefined);
        if (previousStage === 'SCORED' || previousStage === 'COPY_POOL') {
          const { runClosedPrefetchForWallet } = await import('./smartMoneyClosedPrefetch.js');
          await runClosedPrefetchForWallet(profile.wallet, 'GATE').catch(() => undefined);
        }
        const reason = 'data_fetch:closed_prefetch';
        await scheduleDataFetchRetry(profile.wallet, previousStage, reason);
        return {
          wallet: profile.wallet,
          success: false,
          scored: false,
          inCopyPool: false,
          profileSource: resolved.source,
          l1FailReason: null,
          copyPoolBlockedReason: null,
          closedSnapshotPurpose: 'GATE',
          error: reason,
        };
      }
    }

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

    // 数据平面失败：短冷却重试，禁止缺数冒充不合格进 COLD
    if (closedFetchOk === false || tradesFetchOk === false) {
      const parts: string[] = [];
      if (closedFetchOk === false) parts.push('closed');
      if (tradesFetchOk === false) parts.push('trades');
      const reason = `data_fetch:${parts.join('+')}`;
      await upsertSmartMoneyScoreCache(scoreResult).catch(() => undefined);
      await scheduleDataFetchRetry(profile.wallet, previousStage, reason);
      return {
        wallet: profile.wallet,
        success: false,
        scored: false,
        inCopyPool: false,
        profileSource: resolved.source,
        l1FailReason: null,
        copyPoolBlockedReason: null,
        closedSnapshotPurpose: closedOverride ? 'GATE' : null,
        error: reason,
      };
    }

    const totalVolume =
      scoreResult.metrics.totalVolume ??
      (profile.totalVolume != null ? Number(profile.totalVolume) : null);
    const aligned = extractL1DisplayAlignedMetrics(scoreResult);
    const closedWinRate =
      (scoreResult.scoreExplain as { closedPositions?: { marketWinRate?: number | null } })
        ?.closedPositions?.marketWinRate ??
      (scoreResult.scoreExplain as { displayProfile?: { winRate?: number | null } })?.displayProfile
        ?.winRate ??
      scoreResult.externalWinRate;
    const closedProfitFactor =
      (scoreResult.scoreExplain as { displayProfile?: { profitFactor?: number | null } })
        ?.displayProfile?.profitFactor ?? null;
    const closedMarketCountRaw =
      (scoreResult.scoreExplain as { closedPositions?: { marketCount?: number; decisiveMarkets?: number } })
        ?.closedPositions?.decisiveMarkets ??
      (scoreResult.scoreExplain as { closedPositions?: { marketCount?: number } })?.closedPositions
        ?.marketCount ??
      closedMarketReturnDistribution?.sampledMarketCount ??
      null;
    const closedMarketDataMissing =
      scoreResult.riskFlags.includes('CLOSED_POSITIONS_FETCH_FAILED') ||
      scoreResult.riskFlags.includes('CLOSED_RETURN_DATA_MISSING');
    // 数据缺失时传 null，避免 L1 把「未知」当成 0 误杀
    const closedMarketCount = closedMarketDataMissing ? null : (closedMarketCountRaw ?? 0);
    const profitFactorNoLoss =
      (scoreResult.scoreExplain as { displayProfile?: { profitFactorNoLoss?: boolean } })
        ?.displayProfile?.profitFactorNoLoss === true ||
      (scoreResult.scoreExplain as { closedPositions?: { profitFactorNoLoss?: boolean } })
        ?.closedPositions?.profitFactorNoLoss === true;
    const displayMetrics = extractLeaderboardDisplayColumns(scoreResult.scoreExplain);

    const l1 = evaluateL1CandidateGate({
      profile,
      resolvedTotalPnl: extractResolvedTotalPnl(scoreResult),
      totalVolume,
      effectiveTotalReturn: aligned.effectiveTotalReturn,
      effectiveMaxDrawdown: aligned.effectiveMaxDrawdown,
      winRate: closedWinRate,
      profitFactor: closedProfitFactor,
      profitFactorNoLoss,
      trades7d: tradeCount7d,
      trades30d: tradeCount30d,
      tradesFetchOk,
      closedMarketCount,
      closedMarketDataMissing,
      // layer2 已对 closedFetchOk===false 提前 return；此处恒为 false，保留参数供单测/兼容
      closedFetchFailed: false,
      // 与 MDD$ 同源：ALL×1Y 曲线盈亏；勿用 closed Σpnl（展示字段 totalPnl1y）
      totalPnl1y: displayMetrics.accountPnl1y,
      pnlWindowDays: displayMetrics.pnlWindowDays,
      totalReturn1y: displayMetrics.totalReturn1y,
      maxDrawdown1y: displayMetrics.maxDrawdown1y,
      maxDrawdownUsd1y: displayMetrics.maxDrawdownUsd1y,
      medianNotionalUsd:
        (scoreResult.scoreExplain as { displayProfile?: { medianNotionalUsd?: number | null } })
          ?.displayProfile?.medianNotionalUsd ?? null,
      dustShare:
        (scoreResult.scoreExplain as { displayProfile?: { dustShare?: number | null } })
          ?.displayProfile?.dustShare ?? null,
      tradeNotionalSampleCount:
        (scoreResult.scoreExplain as {
          displayProfile?: { tradeNotionalSampleCount?: number };
        })?.displayProfile?.tradeNotionalSampleCount ?? 0,
    });
    if (!l1.passed) {
      // 仍写入 ScoreCache，便于详情「分析」读到刚算的 displayProfile（含最大投入等）
      await upsertSmartMoneyScoreCache(scoreResult).catch(() => undefined);
      await removeFromCopyPool(profile.wallet).catch(() => undefined);
      await moveToEliminated(
        profile.wallet,
        `${l1.failReason}|ret1y=${displayMetrics.totalReturn1y}|mdd1y=${displayMetrics.maxDrawdown1y}|mddUsd1y=${displayMetrics.maxDrawdownUsd1y}|accountPnl1y=${displayMetrics.accountPnl1y}|closedPnl1y=${displayMetrics.totalPnl1y}|wr=${closedWinRate}|pf=${closedProfitFactor}|pfNoLoss=${profitFactorNoLoss}|t30=${tradeCount30d}|closedMissing=${closedMarketDataMissing}|src=${aligned.sourceHint}`
      );
      markSmartMoneyRanksDirty();
      return {
        wallet: profile.wallet,
        success: true,
        scored: true,
        inCopyPool: false,
        profileSource: resolved.source,
        l1FailReason: l1.failReason ?? 'L1_REJECT',
        copyPoolBlockedReason: null,
        closedSnapshotPurpose: closedOverride ? 'GATE' : null,
      };
    }

    // HFT / bot / 对冲等硬旗：不占 SCORED Deep 复评配额，直接进淘汰池
    if (hasCopyPoolHardFlag(scoreResult.riskFlags)) {
      const now = new Date();
      await upsertSmartMoneyScoreCache(scoreResult, {
        tier1fPassedAt: now,
        tier2CorePassedAt: now,
        tier2EnhancedPassedAt: null,
      });
      await removeFromCopyPool(profile.wallet).catch(() => undefined);
      await moveToEliminated(
        profile.wallet,
        buildCopyPoolHardElimReason(scoreResult.riskFlags) ?? 'COPY_HARD'
      );
      await markBlockScanDiscoveryScored(profile.wallet);
      markSmartMoneyRanksDirty();
      return {
        wallet: profile.wallet,
        success: true,
        scored: true,
        inCopyPool: false,
        profileSource: resolved.source,
        l1FailReason: null,
        copyPoolBlockedReason: 'HARD_FLAG',
        closedSnapshotPurpose: closedOverride ? 'GATE' : null,
      };
    }

    const now = new Date();
    const tier2e = evaluateTier2Enhanced({
      closedMarketReturnDistribution,
      marketLiquidityProfile,
    });

    await upsertSmartMoneyScoreCache(scoreResult, {
      tier1fPassedAt: now,
      tier2CorePassedAt: now,
      tier2EnhancedPassedAt: tier2e.passed ? now : null,
    });

    const priorRow = await prisma.smartMoneyRawAddress.findUnique({
      where: { wallet: profile.wallet },
      select: { scoredMissCount: true },
    });
    const priorMiss = priorRow?.scoredMissCount ?? 0;

    const copyPool = await syncSmartMoneyCopyPool({
      scoreResult,
      tier2EnhancedPassed: tier2e.passed,
      closedMarketReturnDistribution,
      marketLiquidityProfile,
      // copy 未算出才占 Enrich；copy=0 已算完但不可入池，勿反复排队
      enrichPending: !isCopyabilityComputed(scoreResult.copyabilityScore),
    });

    if (copyPool.inCopyPool) {
      let nextDeepAnalyzeAt: Date;
      if (isDualChannelRescoreMode()) {
        const lb = await prisma.smartMoneyLeaderboardRow.findUnique({
          where: { wallet: profile.wallet },
          select: { rank: true },
        });
        const channel =
          lb?.rank != null &&
          lb.rank >= 1 &&
          lb.rank <= CONFIG.smartMoneyCopyPoolDailyTopN
            ? 'priority'
            : 'background';
        nextDeepAnalyzeAt = computeDualChannelNextDeepAnalyzeAt(now, channel);
      } else {
        const lb = await prisma.smartMoneyLeaderboardRow.findUnique({
          where: { wallet: profile.wallet },
          select: { rank: true },
        });
        nextDeepAnalyzeAt = computeCopyPoolNextDeepAnalyzeAt(
          await resolveCopyPoolRescoreRank({
            wallet: profile.wallet,
            rank: lb?.rank ?? null,
          }),
          now
        );
      }
      await transitionPipelineStage(profile.wallet, 'COPY_POOL', {
        tierFailReason: null,
        tier1fPassedAt: now,
        tier2CorePassedAt: now,
        tier2EnhancedPassedAt: tier2e.passed ? now : null,
        nextDeepAnalyzeAt,
        elimFailCount: 0,
        elimFrozenUntil: null,
        nextElimCheckAt: null,
        scoredMissCount: 0,
      });
      // 入池后播种 Full（从 Gate 续拉），由 closed-full-enrich cron 补齐并刷新展示
      await seedFullSnapshotFromGate(profile.wallet).catch(() => undefined);
      markSmartMoneyRanksDirty();
    } else if (copyPool.exited && copyPool.exitReason === 'INACTIVE') {
      // sync 已 moveToEliminated(INACTIVE_FLAT_EXIT)；禁止再写 SCORE_BELOW / SCORED 覆盖
      markSmartMoneyRanksDirty();
    } else if (copyPool.exited && copyPool.exitReason === 'EXIT_SCORE') {
      // removeFromCopyPool 已落 SCORED；≤EXIT 立即出池，不再走 SCORE_BELOW miss 淘汰
      markSmartMoneyRanksDirty();
    } else if (copyPool.exited && copyPool.exitReason === 'COPY_TOO_LOW') {
      // sync 已在允许淘汰时 moveToEliminated(COPY_TOO_LOW)；勿再写 SCORED miss
      markSmartMoneyRanksDirty();
    } else if (copyPool.exited && copyPool.exitReason === 'HARD_FLAG') {
      markSmartMoneyRanksDirty();
    } else if (copyPool.enterBlockedReason === 'COPY_NOT_READY') {
      // 分数已达线，仅待三情景 Copy Enrich：禁止计入 scoredMiss，避免 Enrich 积压时误淘
      await transitionPipelineStage(profile.wallet, 'SCORED', {
        tierFailReason: null,
        tier1fPassedAt: now,
        tier2CorePassedAt: now,
        tier2EnhancedPassedAt: tier2e.passed ? now : null,
        nextDeepAnalyzeAt: new Date(now.getTime() + CONFIG.smartMoneyScoredRecheckMs),
        elimFailCount: 0,
        elimFrozenUntil: null,
        nextElimCheckAt: null,
        scoredMissCount: priorMiss,
      });
    } else if (copyPool.enterBlockedReason === 'COPY_TOO_LOW') {
      // 综合分已算出但 < MIN：sync 已直接淘汰，勿再占 SCORED
      markSmartMoneyRanksDirty();
    } else {
      // Phase G：QUALIFIED 首次未入榜 miss=0；SCORED/COPY 复评仍未入榜则累加，超限淘汰
      // SCORE_BELOW / TIER2E 走此路径（COPY_TOO_LOW 已上提直接淘）
      const recheckMiss =
        previousStage === 'SCORED' || previousStage === 'COPY_POOL' ? priorMiss + 1 : 0;

      if (recheckMiss > CONFIG.smartMoneyScoredMaxMiss) {
        await removeFromCopyPool(profile.wallet).catch(() => undefined);
        await moveToEliminated(
          profile.wallet,
          `SCORE_BELOW_ENTER|score=${scoreResult.score}|traderScore=${scoreResult.traderScore ?? 'null'}|miss=${recheckMiss}|blocked=${copyPool.enterBlockedReason ?? 'SCORE_BELOW'}`
        );
        markSmartMoneyRanksDirty();
      } else {
        await transitionPipelineStage(profile.wallet, 'SCORED', {
          tierFailReason: null,
          tier1fPassedAt: now,
          tier2CorePassedAt: now,
          tier2EnhancedPassedAt: tier2e.passed ? now : null,
          nextDeepAnalyzeAt: new Date(now.getTime() + CONFIG.smartMoneyScoredRecheckMs),
          elimFailCount: 0,
          elimFrozenUntil: null,
          nextElimCheckAt: null,
          scoredMissCount: recheckMiss,
        });
      }
    }

    await markBlockScanDiscoveryScored(profile.wallet);

    const rankPending = copyPool.inCopyPool === true;

    return {
      wallet: profile.wallet,
      success: true,
      scored: true,
      inCopyPool: copyPool.inCopyPool,
      rankPending,
      profileSource: resolved.source,
      l1FailReason: null,
      copyPoolBlockedReason: copyPool.enterBlockedReason ?? null,
      closedSnapshotPurpose: closedOverride ? 'GATE' : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      wallet,
      success: false,
      scored: false,
      inCopyPool: false,
      l1FailReason: null,
      copyPoolBlockedReason: null,
      closedSnapshotPurpose: null,
      error: message,
    };
  }
}

export async function runSmartMoneyDeepAnalyzeBatch(
  limit = CONFIG.smartMoneyDeepFetchBatchSize
): Promise<DeepAnalyzeResult[]> {
  const picked = await pickDeepAnalyzeBatch(limit);
  const filtered = await filterDeepBatchByClosedReady(picked);
  const missing = Math.max(0, limit - filtered.length);
  const topup =
    missing > 0 ? await topUpDeepBatchWithReadyQualified(missing, { excludeWallets: filtered }) : [];
  const wallets = [...new Set([...filtered, ...topup])].slice(0, limit);
  await bumpPipelineCursor('deep', BigInt(wallets.length));

  const results = await mapPool(
    wallets,
    CONFIG.smartMoneyAnalyzeConcurrency,
    async (wallet) => {
      const previousStages = await markDeepQueued([wallet]);
      const prev = previousStages.get(wallet.toLowerCase()) ?? 'QUALIFIED';
      const forceLive =
        CONFIG.smartMoneyDeepForceLiveOnFirstQualified &&
        (prev === 'QUALIFIED' || prev === 'FULL_ANALYZING');
      try {
        const result = await withWalletTimeout(
          (signal) =>
            runDeepAnalyzeForWallet(wallet, {
              signal,
              forceLive,
              previousStage: prev,
            }),
          CONFIG.smartMoneyDeepGateWalletTimeoutMs,
          `deep-gate:${wallet}`
        );
        if (!result.success) {
          // 瞬时错误：恢复原阶段短冷却，不淘汰
          // data_fetch:* 已在 runDeepAnalyzeForWallet 内 scheduleDataFetchRetry
          if (!(result.error ?? '').startsWith('data_fetch:')) {
            const restoreStage =
              prev === 'FULL_ANALYZING' || prev === 'LIGHT_ANALYZING' ? 'QUALIFIED' : prev;
            if (restoreStage !== 'ELIMINATED' && restoreStage !== 'BLOCKED') {
              await transitionPipelineStage(
                wallet,
                restoreStage as 'QUALIFIED' | 'SCORED' | 'COPY_POOL' | 'RAW',
                {
                  nextDeepAnalyzeAt: new Date(Date.now() + 15 * 60 * 1000),
                  tierFailReason: `deep_error:${result.error ?? 'unknown'}`.slice(0, 240),
                }
              ).catch(() => undefined);
            }
          }
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const restoreStage =
          prev === 'FULL_ANALYZING' || prev === 'LIGHT_ANALYZING' ? 'QUALIFIED' : prev;
        if (restoreStage !== 'ELIMINATED' && restoreStage !== 'BLOCKED') {
          await transitionPipelineStage(
            wallet,
            restoreStage as 'QUALIFIED' | 'SCORED' | 'COPY_POOL' | 'RAW',
            {
              nextDeepAnalyzeAt: new Date(Date.now() + 15 * 60 * 1000),
              tierFailReason: `deep_error:${message}`.slice(0, 240),
            }
          ).catch(() => undefined);
        }
        return {
          wallet,
          success: false,
          scored: false,
          inCopyPool: false,
          error: message,
        } satisfies DeepAnalyzeResult;
      }
    }
  );

  if (results.some((row) => row.inCopyPool || row.scored || row.rankPending)) {
    markSmartMoneyRanksDirty();
  }

  const l1FailByReason: Record<string, number> = {};
  const copyPoolBlockedByReason: Record<string, number> = {};
  for (const row of results) {
    if (row.l1FailReason) {
      l1FailByReason[row.l1FailReason] = (l1FailByReason[row.l1FailReason] ?? 0) + 1;
    }
    if (row.copyPoolBlockedReason) {
      copyPoolBlockedByReason[row.copyPoolBlockedReason] =
        (copyPoolBlockedByReason[row.copyPoolBlockedReason] ?? 0) + 1;
    }
  }
  console.log('[smart-money-pipeline] deep funnel', {
    deep_picked_total: picked.length,
    deep_filtered_ready_pass: filtered.length,
    deep_filtered_ready_fail: Math.max(0, picked.length - filtered.length),
    deep_topup_added: topup.length,
    deep_executed: wallets.length,
    deep_l1_fail_by_reason: l1FailByReason,
    copy_pool_blocked_by_reason: copyPoolBlockedByReason,
  });

  return results;
}
