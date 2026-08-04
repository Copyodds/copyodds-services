/**
 * Closed Prefetch：限速断点拉取 closed-positions 落库，供 Deep-Gate 只读算分。
 */
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  CLOSED_POSITIONS_TOTAL_BUDGET_MS,
  fetchDataApiClosedPositions,
} from '../polymarket/polymarketData';
import { mapPool } from '../../copyTrading/services/mapPool';
import { waitSmartMoneyRequestGap } from './smartMoneyRequestGap';
import { SMART_MONEY_PNL_WINDOW_DAYS } from './smartMoneyPositionStats';
import {
  appendClosedSnapshotPages,
  closedSnapshotTargetMaxPages,
  ensureClosedSnapshotRow,
  isClosedSnapshotFresh,
  markClosedSnapshotFailed,
  type ClosedSnapshotPurpose,
} from './smartMoneyClosedSnapshot';
import { refreshClosedGateIncremental, forceResetGateSnapshotForFullRebuild } from './smartMoneyClosedIncremental';
import { rawPoolActiveWhere } from './smartMoneyRawPoolActive';
import {
  finishSmartMoneyBatchRun,
  inferPipelineBottleneck,
  startSmartMoneyBatchRun,
  type SmartMoneyBatchBacklog,
} from './smartMoneyBatchObservability';
import { snapshotConsumableBacklog } from './smartMoneyConsumableBacklog';

export type ClosedPrefetchWalletResult = {
  wallet: string;
  purpose: ClosedSnapshotPurpose;
  success: boolean;
  ready: boolean;
  pagesFetched: number;
  error?: string;
};

/** 僵死 FETCHING → PENDING，保留 nextPage 断点，供后续 tick 续拉 */
export async function resetStaleClosedFetchingSnapshots(
  maxAgeMs = CONFIG.smartMoneyClosedPrefetchStaleFetchingMs
): Promise<number> {
  if (maxAgeMs <= 0) return 0;
  const cutoff = new Date(Date.now() - maxAgeMs);
  const updated = await prisma.smartMoneyClosedSnapshot.updateMany({
    where: {
      purpose: 'GATE',
      windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
      status: 'FETCHING',
      updatedAt: { lt: cutoff },
    },
    data: {
      status: 'PENDING',
      lastError: 'stale_fetching_reset',
    },
  });
  if (updated.count > 0) {
    console.warn('[smart-money-closed-prefetch] reset stale FETCHING', {
      count: updated.count,
      maxAgeMs,
    });
  }
  return updated.count;
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

/** QUALIFIED/SCORED/COPY_POOL 且 Gate 未 READY/过期 → 预热；并优先续拉已有 PENDING/FETCHING/FAILED */
export async function pickClosedGatePrefetchBatch(
  limit = CONFIG.smartMoneyClosedPrefetchBatchSize
): Promise<string[]> {
  const now = new Date();
  const need: string[] = [];
  const seen = new Set<string>();

  const push = (wallet: string) => {
    const w = normalizeWallet(wallet);
    if (seen.has(w)) return;
    seen.add(w);
    need.push(w);
  };

  // 优先续拉已建档但未齐 / 失败 / 过期的 Gate
  const resume = await prisma.smartMoneyClosedSnapshot.findMany({
    where: {
      purpose: 'GATE',
      windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
      OR: [
        { status: { in: ['PENDING', 'FETCHING', 'FAILED'] } },
        { status: 'READY', expiresAt: { lte: now } },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: Math.max(limit * 4, limit),
    select: { wallet: true },
  });
  if (resume.length > 0) {
    const resumeWallets = resume.map((row) => normalizeWallet(row.wallet));
    const qualifiedRows = await prisma.smartMoneyRawAddress.findMany({
      where: {
        wallet: { in: resumeWallets },
        pipelineStage: 'QUALIFIED',
        dormant: false,
      },
      select: { wallet: true },
    });
    const qualifiedSet = new Set(qualifiedRows.map((row) => normalizeWallet(row.wallet)));
    for (const row of resume) {
      const wallet = normalizeWallet(row.wallet);
      if (qualifiedSet.has(wallet)) push(wallet);
      if (need.length >= limit) break;
    }
  }

  if (need.length >= limit) return need.slice(0, limit);

  const appendMissingCandidates = async (stages: string[], scanLimit: number): Promise<void> => {
    if (need.length >= limit) return;
    const candidates = await prisma.smartMoneyRawAddress.findMany({
      where: {
        pipelineStage: { in: stages },
        dormant: false,
      },
      orderBy: [{ nextDeepAnalyzeAt: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'asc' }],
      take: scanLimit,
      select: { wallet: true },
    });
    if (candidates.length === 0) return;

    const wallets = candidates.map((candidate) => normalizeWallet(candidate.wallet));
    const snapshots = await prisma.smartMoneyClosedSnapshot.findMany({
      where: {
        wallet: { in: wallets },
        purpose: 'GATE',
        windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
      },
      select: {
        wallet: true,
        status: true,
        expiresAt: true,
      },
    });
    const byWallet = new Map(snapshots.map((snapshot) => [normalizeWallet(snapshot.wallet), snapshot]));

    for (const wallet of wallets) {
      if (need.length >= limit) break;
      const snap = byWallet.get(wallet);
      if (snap?.status === 'READY' && isClosedSnapshotFresh(snap.expiresAt, now.getTime())) {
        continue;
      }
      push(wallet);
    }
  };

  // Light 恢复后 QUALIFIED 产出远高于 Gate。必须先扫描 QUALIFIED，避免前 80 个
  // SCORED/COPY_POOL READY 存量污染候选窗口，造成 batch=20 实际只 picked 1~5。
  await appendMissingCandidates(
    ['QUALIFIED'],
    Math.max((limit - need.length) * 8, 80)
  );
  if (need.length >= limit) return need.slice(0, limit);

  // QUALIFIED 无缺口后再为存量评分池/榜单补 Gate。
  await appendMissingCandidates(
    ['SCORED', 'COPY_POOL'],
    Math.max((limit - need.length) * 16, 160)
  );
  return need.slice(0, limit);
}

export async function runClosedPrefetchForWallet(
  wallet: string,
  purpose: ClosedSnapshotPurpose = 'GATE'
): Promise<ClosedPrefetchWalletResult> {
  const normalized = normalizeWallet(wallet);
  try {
    await waitSmartMoneyRequestGap();

    // Gate：过期 READY 优先真增量，禁止无脑清空重拉
    if (purpose === 'GATE' && CONFIG.smartMoneyClosedIncrementalEnabled) {
      const incremental = await refreshClosedGateIncremental(normalized);
      if (incremental.mode === 'skip_fresh' || incremental.mode === 'incremental') {
        return {
          wallet: normalized,
          purpose,
          success: true,
          ready: incremental.ready,
          pagesFetched: incremental.pagesFetched,
        };
      }
      // 断点续拉中：禁止 full_rebuild 清零 nextPage
      if (incremental.mode === 'resume_prefetch') {
        await ensureClosedSnapshotRow(normalized, purpose, { resetIfExpired: false });
      } else if (incremental.mode === 'full_rebuild_needed') {
        await forceResetGateSnapshotForFullRebuild(normalized);
      } else {
        await ensureClosedSnapshotRow(normalized, purpose, { resetIfExpired: false });
      }
    } else {
      await ensureClosedSnapshotRow(normalized, purpose, { resetIfExpired: true });
    }

    const existing = await prisma.smartMoneyClosedSnapshot.findUnique({
      where: {
        wallet_purpose_windowDays: {
          wallet: normalized,
          purpose,
          windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
        },
      },
      select: {
        status: true,
        nextPage: true,
        expiresAt: true,
        windowComplete: true,
        targetMaxPages: true,
      },
    });

    if (
      existing?.status === 'READY' &&
      isClosedSnapshotFresh(existing.expiresAt) &&
      (existing.windowComplete || existing.nextPage >= existing.targetMaxPages)
    ) {
      return { wallet: normalized, purpose, success: true, ready: true, pagesFetched: 0 };
    }

    const targetMaxPages = closedSnapshotTargetMaxPages(purpose);
    const startPage = Math.max(0, existing?.nextPage ?? 0);
    if (startPage >= targetMaxPages) {
      const marked = await appendClosedSnapshotPages({
        wallet: normalized,
        purpose,
        newRows: [],
        pageCountDelta: 0,
        nextPage: startPage,
        windowComplete: existing?.windowComplete === true,
        timedOut: false,
      });
      return {
        wallet: normalized,
        purpose,
        success: true,
        ready: marked.ready,
        pagesFetched: 0,
      };
    }

    const pagesThisTick = Math.min(
      CONFIG.smartMoneyClosedPrefetchPagesPerTick,
      Math.max(1, targetMaxPages - startPage)
    );

    await prisma.smartMoneyClosedSnapshot.updateMany({
      where: {
        wallet: normalized,
        purpose,
        windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
      },
      data: { status: 'FETCHING' },
    });

    const fetched = await fetchDataApiClosedPositions(normalized, {
      limit: 50,
      startPage,
      maxPages: pagesThisTick,
      windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
      totalBudgetMs: Math.min(
        CONFIG.smartMoneyClosedPrefetchTickBudgetMs,
        CLOSED_POSITIONS_TOTAL_BUDGET_MS
      ),
    });

    const marked = await appendClosedSnapshotPages({
      wallet: normalized,
      purpose,
      newRows: fetched.rows,
      pageCountDelta: fetched.meta.pageCount,
      nextPage: fetched.meta.nextPage,
      windowComplete: fetched.meta.windowComplete,
      timedOut: fetched.meta.timedOut,
    });

    return {
      wallet: normalized,
      purpose,
      success: true,
      ready: marked.ready,
      pagesFetched: fetched.meta.pageCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markClosedSnapshotFailed(normalized, purpose, message).catch(() => undefined);
    return {
      wallet: normalized,
      purpose,
      success: false,
      ready: false,
      pagesFetched: 0,
      error: message,
    };
  }
}

export async function runSmartMoneyClosedPrefetchBatch(
  reason = 'interval:closed-prefetch'
): Promise<{
  picked: number;
  ok: number;
  failed: number;
  ready: number;
  pagesFetched: number;
  reason: string;
}> {
  const run = startSmartMoneyBatchRun('gate_prefetch', reason);
  if (!CONFIG.smartMoneyClosedPrefetchEnabled) {
    finishSmartMoneyBatchRun(run, {
      skipped: true,
      skipReason: 'disabled',
    });
    return { picked: 0, ok: 0, failed: 0, ready: 0, pagesFetched: 0, reason: `${reason}:disabled` };
  }

  const yieldAt = CONFIG.smartMoneyClosedPrefetchYieldRawActive;
  if (yieldAt > 0) {
    const activeRaw = await prisma.smartMoneyRawAddress.count({
      where: rawPoolActiveWhere,
    });
    if (activeRaw >= yieldAt) {
      const now = new Date();
      // 仅当确有到期 Light 工作时让路；避免 RAW 水位常驻高位时永久饿死 Gate
      const lightDue = await prisma.smartMoneyRawAddress.count({
        where: {
          ...rawPoolActiveWhere,
          pipelineStage: 'RAW',
          OR: [{ nextLightAnalyzeAt: null }, { nextLightAnalyzeAt: { lte: now } }],
        },
      });
      if (lightDue > 0) {
        const yieldReason = `${reason}:yield_raw=${activeRaw}>=${yieldAt},lightDue=${lightDue}`;
        finishSmartMoneyBatchRun(run, {
          skipped: true,
          skipReason: yieldReason,
        });
        return {
          picked: 0,
          ok: 0,
          failed: 0,
          ready: 0,
          pagesFetched: 0,
          reason: yieldReason,
        };
      }
    }
  }

  const staleReset = await resetStaleClosedFetchingSnapshots().catch((error) => {
    console.warn('[smart-money-closed-prefetch] stale FETCHING reset failed', { error });
    return 0;
  });

  const backlogBefore = await snapshotConsumableBacklog().catch(
    (): SmartMoneyBatchBacklog => ({})
  );
  const wallets = await pickClosedGatePrefetchBatch();
  const batchBudgetMs = CONFIG.smartMoneyClosedPrefetchBatchBudgetMs;
  let timedOut = false;
  let results: ClosedPrefetchWalletResult[] = [];
  try {
    results = await Promise.race([
      mapPool(wallets, CONFIG.smartMoneyClosedPrefetchConcurrency, (wallet) =>
        runClosedPrefetchForWallet(wallet, 'GATE')
      ),
      new Promise<ClosedPrefetchWalletResult[]>((_, reject) => {
        setTimeout(() => reject(new Error(`gate_prefetch_batch_timeout:${batchBudgetMs}ms`)), batchBudgetMs);
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    timedOut = message.includes('gate_prefetch_batch_timeout');
    console.warn('[smart-money-closed-prefetch] batch aborted', {
      timedOut,
      message,
      picked: wallets.length,
      batchBudgetMs,
    });
    // 超时后仍尽量回收本批已写成 FETCHING 的半成品，避免再等 stale 窗口
    if (timedOut && wallets.length > 0) {
      await prisma.smartMoneyClosedSnapshot
        .updateMany({
          where: {
            wallet: { in: wallets.map(normalizeWallet) },
            purpose: 'GATE',
            windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
            status: 'FETCHING',
          },
          data: {
            status: 'PENDING',
            lastError: 'batch_timeout_reset',
          },
        })
        .catch(() => undefined);
    }
  }

  let ok = 0;
  let failed = 0;
  let ready = 0;
  let pagesFetched = 0;
  for (const r of results) {
    if (r.success) ok += 1;
    else failed += 1;
    if (r.ready) ready += 1;
    pagesFetched += r.pagesFetched;
  }

  const backlogAfter = await snapshotConsumableBacklog().catch(
    (): SmartMoneyBatchBacklog => backlogBefore
  );
  const { bottleneck, backpressure } = inferPipelineBottleneck({
    stage: 'gate_prefetch',
    backlogBefore,
    backlogAfter,
    produced: ready,
    consumed:
      Number(backlogBefore.qualifiedGateMissing ?? 0) -
      Number(backlogAfter.qualifiedGateMissing ?? 0),
  });
  const batchTarget = CONFIG.smartMoneyClosedPrefetchBatchSize;
  finishSmartMoneyBatchRun(run, {
    picked: wallets.length,
    succeeded: ok,
    failed: timedOut ? Math.max(failed, wallets.length - ok) : failed,
    passed: ready,
    converted: ready,
    pagesFetched,
    backlogBefore,
    backlogAfter,
    bottleneck: timedOut
      ? 'gate_batch_timeout'
      : wallets.length < batchTarget && Number(backlogBefore.qualifiedGateMissing ?? 0) > batchTarget
        ? 'gate_picker_underfill'
        : bottleneck,
    backpressure: timedOut ? true : backpressure,
    extras: {
      batchTarget,
      pickerFillRate: batchTarget > 0 ? Number((wallets.length / batchTarget).toFixed(3)) : 0,
      staleFetchingReset: staleReset,
      batchTimedOut: timedOut,
      batchBudgetMs,
    },
  });

  return {
    picked: wallets.length,
    ok,
    failed: timedOut ? Math.max(failed, wallets.length - ok) : failed,
    ready,
    pagesFetched,
    reason: timedOut ? `${reason}:batch_timeout` : reason,
  };
}
