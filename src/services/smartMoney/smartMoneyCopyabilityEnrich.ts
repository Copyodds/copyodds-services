/**
 * 入榜后异步补全窗 trades → copyability 仿真（Deep-Enrich 车道）。
 * F7：默认不再因 copyability&lt;35 / LOW_COPYABILITY 硬踢；按主分 ≤EXIT 走正常出池。
 */
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { waitSmartMoneyRequestGap } from './smartMoneyRequestGap';
import { refreshSmartMoneyCopyabilityForWallet } from './smartMoneyCopyability';
import { fetchDataApiTradesInWindow } from '../polymarket/polymarketTrades';
import { buildCopyPoolHardElimReason, hasCopyPoolHardFlag } from './smartMoneyTierGate';
import { isCopyabilityReadyForPool, isCopyabilityEligibleForPoolEnter } from './smartMoneyCopyReady';
import { removeFromCopyPool } from './smartMoneyCopyPool';
import { moveToEliminated } from './smartMoneyEliminated';
import { resolveCopyPoolMetricScore } from './smartMoneyPoolScore';
import { transitionPipelineStage } from './smartMoneyPipeline';
import {
  computeDualChannelNextDeepAnalyzeAt,
  isDualChannelRescoreMode,
} from './smartMoneyCopyPoolRescoreChannels';
import {
  computeCopyPoolNextDeepAnalyzeAt,
  resolveCopyPoolRescoreRank,
} from './smartMoneyCopyPoolReschedule';
import { assignApproximateRankIfMissing } from './smartMoneyApproxRank';
import { markSmartMoneyRanksDirty } from './smartMoneyLeaderboardWriter';
import { COPY_POOL_HARD_FLAGS } from './smartMoneyPipelineTypes';

export type TryEnterCopyPoolReason =
  | 'ENTERED'
  | 'DISABLED'
  | 'NOT_FOUND'
  | 'ALREADY_IN_POOL'
  | 'COPY_NOT_READY'
  | 'COPY_TOO_LOW'
  | 'HARD_FLAG'
  | 'SCORE_BELOW';

export type TryEnterCopyPoolResult = {
  entered: boolean;
  reason: TryEnterCopyPoolReason;
};

/** Enrich 完成后尝试入池；供复现脚本/测试调用 */
export async function tryEnterCopyPoolAfterCopyReady(
  wallet: string
): Promise<TryEnterCopyPoolResult> {
  if (!CONFIG.smartMoneyCopyReadyRequiredForPool) {
    return { entered: false, reason: 'DISABLED' };
  }
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: {
      inCopyPool: true,
      copyabilityScore: true,
      traderScore: true,
      score: true,
      riskFlags: true,
      tier: true,
    },
  });
  if (!row) return { entered: false, reason: 'NOT_FOUND' };
  if (row.inCopyPool) return { entered: false, reason: 'ALREADY_IN_POOL' };
  const raw = await prisma.smartMoneyRawAddress.findUnique({
    where: { wallet },
    select: { pipelineStage: true },
  });
  // 已进淘汰/阻断/休眠的不再捷径入池（须走淘汰复检 → 正常 Deep）
  if (
    raw?.pipelineStage === 'ELIMINATED' ||
    raw?.pipelineStage === 'BLOCKED' ||
    raw?.pipelineStage === 'DORMANT'
  ) {
    return { entered: false, reason: 'DISABLED' };
  }
  const copyScore =
    row.copyabilityScore != null ? Number(row.copyabilityScore) : null;
  if (!isCopyabilityReadyForPool(copyScore)) {
    return { entered: false, reason: 'COPY_NOT_READY' };
  }
  if (!isCopyabilityEligibleForPoolEnter(copyScore)) {
    return { entered: false, reason: 'COPY_TOO_LOW' };
  }
  if (hasCopyPoolHardFlag(row.riskFlags ?? [])) {
    return { entered: false, reason: 'HARD_FLAG' };
  }
  const poolScore = resolveCopyPoolMetricScore({
    traderScore: row.traderScore != null ? Number(row.traderScore) : null,
    score: row.score != null ? Number(row.score) : 0,
  });
  if (poolScore < CONFIG.smartMoneyCopyPoolEnterScore) {
    return { entered: false, reason: 'SCORE_BELOW' };
  }

  const now = new Date();
  await prisma.smartMoneyLeaderboardRow.update({
    where: { wallet },
    data: {
      inCopyPool: true,
      copyPoolEnteredAt: now,
      copyPoolExitedAt: null,
      copyPoolMissCount: 0,
      activeCandidate: true,
      eligible: true,
      enrichPending: false,
    },
  });
  await assignApproximateRankIfMissing({
    wallet,
    score: row.score != null ? Number(row.score) : 0,
    traderScore: row.traderScore != null ? Number(row.traderScore) : null,
    tier: row.tier,
  }).catch(() => null);

  if (isDualChannelRescoreMode()) {
    const lb = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet },
      select: { rank: true },
    });
    const channel =
      lb?.rank != null &&
      lb.rank >= 1 &&
      lb.rank <= CONFIG.smartMoneyCopyPoolDailyTopN
        ? 'priority'
        : 'background';
    await transitionPipelineStage(wallet, 'COPY_POOL', {
      nextDeepAnalyzeAt: computeDualChannelNextDeepAnalyzeAt(now, channel),
      scoredMissCount: 0,
    });
  } else {
    const effectiveRank = await resolveCopyPoolRescoreRank({ wallet, rank: null });
    await transitionPipelineStage(wallet, 'COPY_POOL', {
      nextDeepAnalyzeAt: computeCopyPoolNextDeepAnalyzeAt(effectiveRank, now),
      scoredMissCount: 0,
    });
  }
  markSmartMoneyRanksDirty();
  return { entered: true, reason: 'ENTERED' };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const failureCooldownUntilByWallet = new Map<string, number>();

export type CopyabilityEnrichResult = {
  wallet: string;
  success: boolean;
  exitedCopyPool?: boolean;
  enteredCopyPool?: boolean;
  enterReason?: TryEnterCopyPoolReason | null;
  tradeCount?: number;
  truncated?: boolean;
  copyabilityScore?: number | null;
  error?: string;
};

export function selectActiveCopyabilityCooldownWallets(
  entries: Iterable<readonly [string, number]>,
  nowMs = Date.now()
): string[] {
  const active: string[] = [];
  for (const [wallet, cooldownUntilMs] of entries) {
    if (cooldownUntilMs > nowMs) active.push(wallet.toLowerCase());
  }
  return active;
}

function activeFailureCooldownWallets(nowMs = Date.now()): string[] {
  for (const [wallet, cooldownUntilMs] of failureCooldownUntilByWallet) {
    if (cooldownUntilMs <= nowMs) failureCooldownUntilByWallet.delete(wallet);
  }
  return selectActiveCopyabilityCooldownWallets(failureCooldownUntilByWallet, nowMs);
}

function markCopyabilityFailureCooldown(wallet: string): void {
  failureCooldownUntilByWallet.set(
    wallet.toLowerCase(),
    Date.now() + CONFIG.smartMoneyCopyabilityEnrichFailureCooldownMs
  );
}

export async function withCopyabilityWalletTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  wallet: string
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      factory(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`copyability_wallet_timeout:${wallet}:${timeoutMs}ms`));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hardFlagsSql(): Prisma.Sql {
  return Prisma.sql`ARRAY[${Prisma.join(
    COPY_POOL_HARD_FLAGS.map((flag) => Prisma.sql`${flag}`)
  )}]::text[]`;
}

/**
 * 达线且仿跟单已算出、无硬旗、却未入池的搁浅户：直接 tryEnter（避免再走全窗 trades）。
 */
export async function promoteStrandedCopyReadyToPool(
  limit = Math.max(20, CONFIG.smartMoneyCopyabilityEnrichBatchSize * 10)
): Promise<number> {
  if (!CONFIG.smartMoneyCopyReadyRequiredForPool) return 0;
  const enterScore = CONFIG.smartMoneyCopyPoolEnterScore;
  const hard = hardFlagsSql();
  // 仅排除已淘汰/阻断/休眠：避免 ops 进 ELIMINATED 后又被 promote 拉回（非「旧分」特殊门）
  const rows = CONFIG.smartMoneyTraderScoreAsPrimary
    ? await prisma.$queryRaw<Array<{ wallet: string }>>`
        SELECT sm.wallet
        FROM "SmartMoneyLeaderboardRow" sm
        JOIN "SmartMoneyRawAddress" ra ON ra.wallet = sm.wallet
        WHERE sm."inCopyPool" = false
          AND ra."pipelineStage" NOT IN ('ELIMINATED', 'BLOCKED', 'DORMANT')
          AND sm."copyabilityScore" IS NOT NULL
          AND sm."copyabilityScore" > 0
          AND COALESCE(sm."traderScore", sm.score) >= ${enterScore}
          AND NOT (sm."riskFlags" && ${hard})
        ORDER BY sm."lastScoredAt" ASC NULLS FIRST
        LIMIT ${limit}
      `
    : await prisma.$queryRaw<Array<{ wallet: string }>>`
        SELECT sm.wallet
        FROM "SmartMoneyLeaderboardRow" sm
        JOIN "SmartMoneyRawAddress" ra ON ra.wallet = sm.wallet
        WHERE sm."inCopyPool" = false
          AND ra."pipelineStage" NOT IN ('ELIMINATED', 'BLOCKED', 'DORMANT')
          AND sm."copyabilityScore" IS NOT NULL
          AND sm."copyabilityScore" > 0
          AND sm.score >= ${enterScore}
          AND NOT (sm."riskFlags" && ${hard})
        ORDER BY sm."lastScoredAt" ASC NULLS FIRST
        LIMIT ${limit}
      `;

  let promoted = 0;
  for (const row of rows) {
    const result = await tryEnterCopyPoolAfterCopyReady(row.wallet);
    if (result.entered) {
      promoted += 1;
    } else if (result.reason !== 'SCORE_BELOW' && result.reason !== 'ALREADY_IN_POOL') {
      console.warn('[smart-money-copyability-enrich] stranded_promote_failed', {
        wallet: row.wallet,
        reason: result.reason,
      });
    }
  }
  return promoted;
}

/**
 * 修复 Enrich/运维清 pending 后的空转：
 * 1) copy 未算：回填 enrichPending
 * 2) copy 已算且达线干净：直接 promote 入池
 */
export async function requeueOrphanCopyabilityPending(): Promise<number> {
  if (!CONFIG.smartMoneyCopyReadyRequiredForPool) return 0;
  const enterScore = CONFIG.smartMoneyCopyPoolEnterScore;
  const updated = CONFIG.smartMoneyTraderScoreAsPrimary
    ? await prisma.$executeRaw`
        UPDATE "SmartMoneyLeaderboardRow" sm
        SET "enrichPending" = true
        FROM "SmartMoneyRawAddress" ra
        WHERE sm.wallet = ra.wallet
          AND ra."pipelineStage" = 'SCORED'
          AND sm."inCopyPool" = false
          AND sm."enrichPending" = false
          AND sm."copyabilityScore" IS NULL
          AND COALESCE(sm."traderScore", sm.score) >= ${enterScore}
      `
    : await prisma.$executeRaw`
        UPDATE "SmartMoneyLeaderboardRow" sm
        SET "enrichPending" = true
        FROM "SmartMoneyRawAddress" ra
        WHERE sm.wallet = ra.wallet
          AND ra."pipelineStage" = 'SCORED'
          AND sm."inCopyPool" = false
          AND sm."enrichPending" = false
          AND sm."copyabilityScore" IS NULL
          AND sm.score >= ${enterScore}
      `;
  const promoted = await promoteStrandedCopyReadyToPool();
  return Number(updated) + promoted;
}

export async function pickCopyabilityEnrichmentBatch(
  limit = CONFIG.smartMoneyCopyabilityEnrichBatchSize
): Promise<string[]> {
  const coolingWallets = activeFailureCooldownWallets();
  const orderBy = [
    { copyabilityComputedAt: { sort: 'asc' as const, nulls: 'first' as const } },
    { lastScoredAt: 'asc' as const },
    { rank: { sort: 'asc' as const, nulls: 'last' as const } },
  ];

  // 未入池排队优先，避免池内复刷饿死晋级车道
  const outPool = await prisma.smartMoneyLeaderboardRow.findMany({
    where: {
      ...(coolingWallets.length > 0 ? { wallet: { notIn: coolingWallets } } : {}),
      inCopyPool: false,
      enrichPending: true,
    },
    orderBy,
    take: limit,
    select: { wallet: true },
  });
  if (outPool.length >= limit) return outPool.map((r) => r.wallet);

  const exclude = [...coolingWallets, ...outPool.map((r) => r.wallet)];
  const inPool = await prisma.smartMoneyLeaderboardRow.findMany({
    where: {
      ...(exclude.length > 0 ? { wallet: { notIn: exclude } } : {}),
      inCopyPool: true,
      OR: [
        { enrichPending: true },
        { copyabilityComputedAt: null },
        { copyabilityScore: null },
      ],
    },
    orderBy,
    take: limit - outPool.length,
    select: { wallet: true },
  });
  return [...outPool, ...inPool].map((r) => r.wallet);
}

export async function runCopyabilityEnrichmentForWallet(
  wallet: string,
  options?: { signal?: AbortSignal; /** false：仅补仿跟单分，不尝试入池（按需 L1 失败） */ allowPoolEnter?: boolean }
): Promise<CopyabilityEnrichResult> {
  const normalized = wallet.trim().toLowerCase();
  const signal = options?.signal;
  const allowPoolEnter = options?.allowPoolEnter !== false;
  try {
    await waitSmartMoneyRequestGap();
    signal?.throwIfAborted();
    const end = Date.now();
    const start = end - Math.max(30, CONFIG.smartMoneyCopyLookbackDays) * DAY_MS;
    const { trades, truncated } = await fetchDataApiTradesInWindow(normalized, start, end, {
      signal,
    });
    signal?.throwIfAborted();
    const row = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet: normalized },
      select: { score: true, inCopyPool: true },
    });
    signal?.throwIfAborted();
    const refreshed = await refreshSmartMoneyCopyabilityForWallet({
      wallet: normalized,
      smartMoneyScore: row?.score != null ? Number(row.score) : 0,
      inCopyPool: row?.inCopyPool === true,
      tradesWindow: { trades, windowEndMs: end },
      signal,
    });

    const after = await prisma.smartMoneyLeaderboardRow.findUnique({
      where: { wallet: normalized },
      select: { riskFlags: true, inCopyPool: true, traderScore: true, score: true },
    });
    let exitedCopyPool = false;
    let enteredCopyPool = false;
    let enterReason: TryEnterCopyPoolReason | null = null;
    const hardReason = buildCopyPoolHardElimReason(after?.riskFlags ?? []);
    if (after?.inCopyPool === true && hardReason != null) {
      await removeFromCopyPool(normalized);
      await moveToEliminated(normalized, hardReason);
      exitedCopyPool = true;
    } else if (
      CONFIG.smartMoneyCopyabilityKickOnLowScore &&
      after?.inCopyPool === true &&
      refreshed.copyabilityScore != null &&
      refreshed.copyabilityScore < CONFIG.smartMoneyMinCopyabilityForPool
    ) {
      await removeFromCopyPool(normalized);
      await moveToEliminated(
        normalized,
        buildCopyPoolHardElimReason([...(after.riskFlags ?? []), 'LOW_COPYABILITY']) ??
          'COPY_HARD|LOW_COPYABILITY'
      );
      exitedCopyPool = true;
    } else if (after?.inCopyPool === true) {
      const copyScore = refreshed.copyabilityScore;
      // 榜前必算：仿跟单尚未落库则出池等 Enrich；已算出含 0 则只看出榜分线
      if (
        CONFIG.smartMoneyCopyReadyRequiredForPool &&
        (copyScore == null || !isCopyabilityReadyForPool(copyScore))
      ) {
        await removeFromCopyPool(normalized);
        exitedCopyPool = true;
      } else if (
        CONFIG.smartMoneyCopyReadyRequiredForPool &&
        !isCopyabilityEligibleForPoolEnter(copyScore)
      ) {
        // 综合分 < MIN：出池并淘汰，不占 SCORED
        await removeFromCopyPool(normalized);
        await moveToEliminated(
          normalized,
          `COPY_TOO_LOW|copyability=${copyScore ?? 'null'}|min=${CONFIG.smartMoneyCopyPoolMinComposite}`
        );
        exitedCopyPool = true;
      } else {
        // Enrich 已回写 traderScore；主分 ≤ EXIT 走正常出池（非低 copy 专用淘汰）
        const poolScore = resolveCopyPoolMetricScore({
          traderScore: after.traderScore != null ? Number(after.traderScore) : null,
          score: after.score != null ? Number(after.score) : 0,
        });
        if (poolScore <= CONFIG.smartMoneyCopyPoolExitScore) {
          await removeFromCopyPool(normalized);
          exitedCopyPool = true;
        }
      }
    } else if (allowPoolEnter && !after?.inCopyPool && hardReason != null) {
      // Enrich 补旗后即使已不在榜，也不要留在 SCORED 占 Deep 配额
      await moveToEliminated(normalized, hardReason);
    } else if (allowPoolEnter && !after?.inCopyPool && hardReason == null) {
      // 榜前 Copy 完成：达线且仿跟单已算出；综合分 < MIN 则直接淘汰
      const enter = await tryEnterCopyPoolAfterCopyReady(normalized);
      enteredCopyPool = enter.entered;
      enterReason = enter.reason;
      if (!enter.entered && enter.reason === 'COPY_TOO_LOW') {
        await moveToEliminated(
          normalized,
          `COPY_TOO_LOW|copyability=${refreshed.copyabilityScore ?? 'null'}|min=${CONFIG.smartMoneyCopyPoolMinComposite}`
        );
      } else if (
        !enter.entered &&
        enter.reason !== 'SCORE_BELOW' &&
        enter.reason !== 'DISABLED' &&
        enter.reason !== 'COPY_TOO_LOW'
      ) {
        console.warn('[smart-money-copyability-enrich] try_enter_failed', {
          wallet: normalized,
          reason: enter.reason,
        });
      }
    }

    const poolScoreAfter = resolveCopyPoolMetricScore({
      traderScore: after?.traderScore != null ? Number(after.traderScore) : null,
      score: after?.score != null ? Number(after.score) : 0,
    });
    const belowEnter = poolScoreAfter < CONFIG.smartMoneyCopyPoolEnterScore;
    // 出池：尊重 removeFromCopyPool 已写的 enrichPending（可能 keep 排队）。
    // 其余：已入池/硬淘/分不够/copy=0 才清；达线仍未进则保持排队，避免搁浅。
    if (!exitedCopyPool) {
      const clearPending =
        (after?.inCopyPool === true && !enteredCopyPool) ||
        enteredCopyPool ||
        hardReason != null ||
        !allowPoolEnter ||
        belowEnter ||
        enterReason === 'DISABLED' ||
        enterReason === 'ALREADY_IN_POOL' ||
        enterReason === 'SCORE_BELOW' ||
        enterReason === 'COPY_TOO_LOW';

      if (clearPending) {
        await prisma.smartMoneyLeaderboardRow.updateMany({
          where: { wallet: normalized },
          data: { enrichPending: false },
        });
      } else if (allowPoolEnter) {
        await prisma.smartMoneyLeaderboardRow.updateMany({
          where: { wallet: normalized },
          data: { enrichPending: true },
        });
        console.warn('[smart-money-copyability-enrich] keep_enrich_pending', {
          wallet: normalized,
          enterReason,
          poolScoreAfter,
        });
      }
    }

    return {
      wallet: normalized,
      success: true,
      exitedCopyPool,
      enteredCopyPool,
      enterReason,
      tradeCount: trades.length,
      truncated,
      copyabilityScore: refreshed.copyabilityScore,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { wallet: normalized, success: false, error: message };
  }
}

export async function runSmartMoneyCopyabilityEnrichmentBatch(
  reason = 'interval:copyability-enrich'
): Promise<{
  picked: number;
  attempted: number;
  ok: number;
  failed: number;
  timedOut: number;
  deferred: number;
  exited: number;
  entered: number;
  promoted: number;
  elapsedMs: number;
  reason: string;
}> {
  const batchStartedAt = Date.now();
  const batchBudgetMs = CONFIG.smartMoneyCopyabilityEnrichBatchBudgetMs;
  const walletTimeoutMs = CONFIG.smartMoneyCopyabilityEnrichWalletTimeoutMs;
  const orphanRequeued = await requeueOrphanCopyabilityPending().catch((err) => {
    console.warn('[smart-money-copyability-enrich] orphan_requeue_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  });
  if (orphanRequeued > 0) {
    console.log('[smart-money-copyability-enrich] orphan_requeued', {
      reason,
      orphanRequeued,
    });
  }

  console.log('[smart-money-copyability-enrich] batch_started', {
    reason,
    batchBudgetMs,
    walletTimeoutMs,
  });
  let wallets: string[];
  try {
    wallets = await withCopyabilityWalletTimeout(
      () => pickCopyabilityEnrichmentBatch(),
      Math.min(30_000, batchBudgetMs),
      'batch_picker'
    );
  } catch (error) {
    const elapsedMs = Date.now() - batchStartedAt;
    const message = error instanceof Error ? error.message : String(error);
    const pickerTimedOut = message.startsWith('copyability_wallet_timeout:');
    console.error('[smart-money-copyability-enrich] batch_picker_failed', {
      reason,
      elapsedMs,
      error: message,
    });
    return {
      picked: 0,
      attempted: 0,
      ok: 0,
      failed: 1,
      timedOut: pickerTimedOut ? 1 : 0,
      deferred: 0,
      exited: 0,
      entered: 0,
      promoted: orphanRequeued,
      elapsedMs,
      reason,
    };
  }
  console.log('[smart-money-copyability-enrich] batch_picked', {
    reason,
    picked: wallets.length,
  });
  let attempted = 0;
  let ok = 0;
  let failed = 0;
  let timedOut = 0;
  let deferred = 0;
  let exited = 0;
  let entered = 0;
  const walletElapsedMsList: number[] = [];
  // 并发 1，不抢 Gate 主配额
  for (let index = 0; index < wallets.length; index += 1) {
    const wallet = wallets[index];
    const remainingMs = batchBudgetMs - (Date.now() - batchStartedAt);
    if (remainingMs <= 0) {
      deferred = wallets.length - index;
      break;
    }

    attempted += 1;
    const walletStartedAt = Date.now();
    console.log('[smart-money-copyability-enrich] wallet_started', {
      reason,
      wallet,
      index,
      timeoutMs: Math.min(walletTimeoutMs, remainingMs),
    });
    try {
      const r = await withCopyabilityWalletTimeout(
        (signal) => runCopyabilityEnrichmentForWallet(wallet, { signal }),
        Math.min(walletTimeoutMs, remainingMs),
        wallet
      );
      const elapsedMs = Date.now() - walletStartedAt;
      walletElapsedMsList.push(elapsedMs);
      if (r.success) {
        failureCooldownUntilByWallet.delete(wallet.toLowerCase());
        ok += 1;
        if (r.exitedCopyPool) exited += 1;
        if (r.enteredCopyPool) entered += 1;
        console.log('[smart-money-copyability-enrich] wallet_succeeded', {
          reason,
          wallet,
          elapsedMs,
          tradeCount: r.tradeCount ?? null,
          truncated: r.truncated ?? null,
          copyabilityScore: r.copyabilityScore ?? null,
          exitedCopyPool: r.exitedCopyPool === true,
          enteredCopyPool: r.enteredCopyPool === true,
          enterReason: r.enterReason ?? null,
        });
      } else {
        markCopyabilityFailureCooldown(wallet);
        failed += 1;
        console.warn('[smart-money-copyability-enrich] wallet_failed', {
          reason,
          wallet,
          elapsedMs,
          error: r.error ?? 'unknown',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markCopyabilityFailureCooldown(wallet);
      failed += 1;
      const isTimeout = message.startsWith('copyability_wallet_timeout:');
      if (isTimeout) timedOut += 1;
      walletElapsedMsList.push(Date.now() - walletStartedAt);
      console.warn(
        `[smart-money-copyability-enrich] ${isTimeout ? 'wallet_timeout' : 'wallet_failed'}`,
        {
          reason,
          wallet,
          elapsedMs: Date.now() - walletStartedAt,
          error: message,
        }
      );
    }
  }
  const elapsedMs = Date.now() - batchStartedAt;
  const sortedElapsed = [...walletElapsedMsList].sort((a, b) => a - b);
  const percentile = (p: number): number | null => {
    if (sortedElapsed.length === 0) return null;
    const idx = Math.min(
      sortedElapsed.length - 1,
      Math.max(0, Math.ceil((p / 100) * sortedElapsed.length) - 1)
    );
    return sortedElapsed[idx] ?? null;
  };
  console.log('[smart-money-copyability-enrich] batch_finished', {
    reason,
    picked: wallets.length,
    attempted,
    ok,
    failed,
    timedOut,
    deferred,
    exited,
    entered,
    promoted: orphanRequeued,
    elapsedMs,
    batchBudgetMs,
    walletElapsedP50Ms: percentile(50),
    walletElapsedP95Ms: percentile(95),
  });
  return {
    picked: wallets.length,
    attempted,
    ok,
    failed,
    timedOut,
    deferred,
    exited,
    entered,
    promoted: orphanRequeued,
    elapsedMs,
    reason,
  };
}
