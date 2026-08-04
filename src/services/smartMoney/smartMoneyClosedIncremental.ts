/**
 * Closed Gate 真增量：从 offset=0 追新页，与存量 merge；过旧则全量重建。
 */
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  CLOSED_POSITIONS_TOTAL_BUDGET_MS,
  CLOSED_POSITIONS_WINDOW_DAYS,
  closedPositionDedupeKey,
  extractClosedPositionAtMs,
  fetchDataApiClosedPositions,
  type DataApiPosition,
} from '../polymarket/polymarketData';
import { SMART_MONEY_PNL_WINDOW_DAYS } from './smartMoneyPositionStats';
import {
  closedBoundsFromRows,
  closedSnapshotTargetMaxPages,
  closedSnapshotTtlMs,
  ensureClosedSnapshotRow,
  isClosedSnapshotFresh,
  parseClosedRowsJson,
  type ClosedSnapshotPurpose,
} from './smartMoneyClosedSnapshot';
import { recordClosedIncrementalMetric, recordGateCappedMetric } from './smartMoneyCopyPoolRescoreMetrics';

export type ClosedIncrementalResult = {
  wallet: string;
  purpose: ClosedSnapshotPurpose;
  /**
   * resume_prefetch：断点续拉中（PENDING/FETCHING），禁止 full rebuild 清零 nextPage。
   */
  mode: 'skip_fresh' | 'incremental' | 'full_rebuild_needed' | 'failed' | 'resume_prefetch';
  ready: boolean;
  pagesFetched: number;
  mergedRowCount: number;
  error?: string;
};

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

export function computeNewestClosedAtMs(rows: DataApiPosition[]): number | null {
  let newest: number | null = null;
  for (const row of rows) {
    const ms = extractClosedPositionAtMs(row);
    if (ms == null) continue;
    if (newest == null || ms > newest) newest = ms;
  }
  return newest;
}

export function mergeClosedRowsIncremental(input: {
  existing: DataApiPosition[];
  incoming: DataApiPosition[];
  nowMs?: number;
  windowDays?: number;
  maxRows?: number;
}): DataApiPosition[] {
  const nowMs = input.nowMs ?? Date.now();
  const windowDays = input.windowDays ?? CLOSED_POSITIONS_WINDOW_DAYS;
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const maxRows = Math.max(1, input.maxRows ?? 80 * 50);

  const byKey = new Map<string, DataApiPosition>();
  for (const row of [...input.existing, ...input.incoming]) {
    const ms = extractClosedPositionAtMs(row);
    if (ms != null && ms < cutoffMs) continue;
    byKey.set(closedPositionDedupeKey(row), row);
  }

  const merged = [...byKey.values()];
  merged.sort((a, b) => {
    const am = extractClosedPositionAtMs(a) ?? 0;
    const bm = extractClosedPositionAtMs(b) ?? 0;
    return bm - am;
  });
  return merged.slice(0, maxRows);
}

function pageCaughtUpToCheckpoint(
  pageRows: DataApiPosition[],
  newestExistingMs: number
): boolean {
  if (pageRows.length === 0) return true;
  let parsed = 0;
  let allAtOrBefore = true;
  for (const row of pageRows) {
    const ms = extractClosedPositionAtMs(row);
    if (ms == null) continue;
    parsed += 1;
    if (ms > newestExistingMs) allAtOrBefore = false;
  }
  if (parsed === 0) return false;
  return allAtOrBefore;
}

// keep helper available for tests / future page-level early-stop
void pageCaughtUpToCheckpoint;

/**
 * 尝试增量刷新 Gate。
 * - 新鲜 READY → skip
 * - 有存量且未超 fullRebuild → 拉新页 merge
 * - 否则 → full_rebuild_needed（调用方走 Prefetch 全量）
 */
export async function refreshClosedGateIncremental(
  wallet: string,
  options?: { signal?: AbortSignal; forceFull?: boolean }
): Promise<ClosedIncrementalResult> {
  const normalized = normalizeWallet(wallet);
  const purpose: ClosedSnapshotPurpose = 'GATE';
  const windowDays = SMART_MONEY_PNL_WINDOW_DAYS;
  const targetMaxPages = closedSnapshotTargetMaxPages(purpose);
  const maxRows = targetMaxPages * 50;
  const nowMs = Date.now();

  if (!CONFIG.smartMoneyClosedIncrementalEnabled) {
    recordClosedIncrementalMetric('full_rebuild_needed');
    return {
      wallet: normalized,
      purpose,
      mode: 'full_rebuild_needed',
      ready: false,
      pagesFetched: 0,
      mergedRowCount: 0,
    };
  }

  const row = await prisma.smartMoneyClosedSnapshot.findUnique({
    where: {
      wallet_purpose_windowDays: { wallet: normalized, purpose, windowDays },
    },
  });

  if (!row) {
    recordClosedIncrementalMetric('full_rebuild_needed');
    return {
      wallet: normalized,
      purpose,
      mode: 'full_rebuild_needed',
      ready: false,
      pagesFetched: 0,
      mergedRowCount: 0,
    };
  }

  // 断点续拉中：绝不能 full_rebuild 清零，否则会每轮重采 0..PAGES_PER_TICK-1，永远到不了 MAX_PAGES。
  if (row.status === 'PENDING' || row.status === 'FETCHING') {
    return {
      wallet: normalized,
      purpose,
      mode: 'resume_prefetch',
      ready: false,
      pagesFetched: 0,
      mergedRowCount: row.rowCount,
    };
  }

  if (row.status !== 'READY' || row.rowCount <= 0) {
    recordClosedIncrementalMetric('full_rebuild_needed');
    return {
      wallet: normalized,
      purpose,
      mode: 'full_rebuild_needed',
      ready: false,
      pagesFetched: 0,
      mergedRowCount: 0,
    };
  }

  const existingRows = parseClosedRowsJson(row.rowsJson);
  if (existingRows.length === 0) {
    recordClosedIncrementalMetric('full_rebuild_needed');
    return {
      wallet: normalized,
      purpose,
      mode: 'full_rebuild_needed',
      ready: false,
      pagesFetched: 0,
      mergedRowCount: 0,
    };
  }

  const fetchedAtMs = row.fetchedAt?.getTime() ?? row.readyAt?.getTime() ?? row.updatedAt.getTime();
  const ageMs = nowMs - fetchedAtMs;
  if (options?.forceFull || ageMs > CONFIG.smartMoneyClosedFullRebuildMs) {
    recordClosedIncrementalMetric('full_rebuild_needed');
    return {
      wallet: normalized,
      purpose,
      mode: 'full_rebuild_needed',
      ready: false,
      pagesFetched: 0,
      mergedRowCount: existingRows.length,
    };
  }

  // 刚刷新过则跳过（防同批抖动）；否则即使 TTL 未到也追新，保证日复评吃到新成交
  if (ageMs < CONFIG.smartMoneyClosedIncrementalMinAgeMs) {
    // 软过期时仍需延长 TTL 才可被 loadReady 读到
    if (!isClosedSnapshotFresh(row.expiresAt, nowMs)) {
      const ttlMs = closedSnapshotTtlMs(purpose);
      await prisma.smartMoneyClosedSnapshot.update({
        where: { id: row.id },
        data: {
          status: 'READY',
          expiresAt: new Date(nowMs + ttlMs),
          fetchedAt: row.fetchedAt ?? new Date(nowMs),
          readyAt: row.readyAt ?? new Date(nowMs),
        },
      });
    }
    recordClosedIncrementalMetric('skip_fresh');
    return {
      wallet: normalized,
      purpose,
      mode: 'skip_fresh',
      ready: true,
      pagesFetched: 0,
      mergedRowCount: existingRows.length,
    };
  }

  const newestExistingMs = computeNewestClosedAtMs(existingRows);
  const incrementalMaxPages = CONFIG.smartMoneyClosedIncrementalMaxPages;

  try {
    const fetched = await fetchDataApiClosedPositions(normalized, {
      limit: 50,
      startPage: 0,
      maxPages: incrementalMaxPages,
      windowDays,
      totalBudgetMs: Math.min(
        CONFIG.smartMoneyClosedPrefetchTickBudgetMs,
        CLOSED_POSITIONS_TOTAL_BUDGET_MS
      ),
      signal: options?.signal,
      nowMs,
    });

    // 若能判定已追上 checkpoint；封顶仍全新于 checkpoint → 缺口，改全量
    const incoming = fetched.rows;
    if (newestExistingMs != null && fetched.meta.pageCount >= incrementalMaxPages) {
      const allNewerThanCheckpoint =
        incoming.length > 0 &&
        incoming.every((r) => {
          const ms = extractClosedPositionAtMs(r);
          return ms == null || ms > newestExistingMs;
        });
      if (allNewerThanCheckpoint) {
        recordClosedIncrementalMetric('full_rebuild_needed');
        return {
          wallet: normalized,
          purpose,
          mode: 'full_rebuild_needed',
          ready: false,
          pagesFetched: fetched.meta.pageCount,
          mergedRowCount: existingRows.length,
        };
      }
    }

    const merged = mergeClosedRowsIncremental({
      existing: existingRows,
      incoming,
      nowMs,
      windowDays,
      maxRows,
    });

    const ttlMs = closedSnapshotTtlMs(purpose);
    const now = new Date(nowMs);
    // 增量不得用「行数变少」推断窗已扫尽；保留原 windowComplete，或本次 fetch 真扫尽
    const windowComplete =
      row.windowComplete === true || fetched.meta.windowComplete === true;
    const capped = row.capped === true || (!windowComplete && (fetched.meta.capped || merged.length >= maxRows));
    if (capped && !row.capped) recordGateCappedMetric();
    const bounds = closedBoundsFromRows(merged);

    await prisma.smartMoneyClosedSnapshot.update({
      where: { id: row.id },
      data: {
        status: 'READY',
        rowsJson: merged as unknown as Prisma.InputJsonValue,
        rowCount: merged.length,
        // 增量不改变历史翻页断点语义；保留 pageCount 观测为「存量规模折合」
        pageCount: Math.min(targetMaxPages, Math.max(row.pageCount, Math.ceil(merged.length / 50))),
        nextPage: Math.min(targetMaxPages, Math.max(row.nextPage, Math.ceil(merged.length / 50))),
        targetMaxPages,
        capped,
        timedOut: fetched.meta.timedOut,
        windowComplete,
        fetchOk: true,
        lastError: null,
        newestClosedAt: bounds.newestClosedAt,
        oldestClosedAt: bounds.oldestClosedAt,
        lastIncrementalAt: now,
        fetchedAt: now,
        readyAt: now,
        expiresAt: new Date(nowMs + ttlMs),
        updatedAt: now,
      },
    });

    recordClosedIncrementalMetric('incremental');
    return {
      wallet: normalized,
      purpose,
      mode: 'incremental',
      ready: true,
      pagesFetched: fetched.meta.pageCount,
      mergedRowCount: merged.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordClosedIncrementalMetric('failed');
    return {
      wallet: normalized,
      purpose,
      mode: 'failed',
      ready: false,
      pagesFetched: 0,
      mergedRowCount: existingRows.length,
      error: message,
    };
  }
}

/**
 * Prefetch / Deep 前置：优先增量；需要全量时 reset 后由 Prefetch 断点拉。
 */
export async function forceResetGateSnapshotForFullRebuild(wallet: string): Promise<void> {
  const normalized = normalizeWallet(wallet);
  await ensureClosedSnapshotRow(normalized, 'GATE', { resetIfExpired: false });
  const existing = await prisma.smartMoneyClosedSnapshot.findUnique({
    where: {
      wallet_purpose_windowDays: {
        wallet: normalized,
        purpose: 'GATE',
        windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
      },
    },
    select: { id: true, status: true, rowCount: true, incrementalEpoch: true },
  });

  if (existing) {
    await prisma.smartMoneyClosedSnapshot.update({
      where: { id: existing.id },
      data: {
        status: 'PENDING',
        rowsJson: Prisma.DbNull,
        rowCount: 0,
        pageCount: 0,
        nextPage: 0,
        capped: false,
        timedOut: false,
        windowComplete: false,
        fetchOk: false,
        lastError: null,
        newestClosedAt: null,
        oldestClosedAt: null,
        lastIncrementalAt: null,
        incrementalEpoch: { increment: 1 },
        fetchedAt: null,
        readyAt: null,
        expiresAt: null,
        targetMaxPages: closedSnapshotTargetMaxPages('GATE'),
      },
    });
  } else {
    await ensureClosedSnapshotRow(normalized, 'GATE');
  }
}

export async function ensureGateReadyPreferIncremental(
  wallet: string,
  options?: { signal?: AbortSignal }
): Promise<ClosedIncrementalResult> {
  const normalized = normalizeWallet(wallet);
  const result = await refreshClosedGateIncremental(normalized, options);
  if (result.mode === 'skip_fresh' || result.mode === 'incremental') {
    return result;
  }
  if (result.mode === 'failed') {
    return result;
  }

  await forceResetGateSnapshotForFullRebuild(normalized);

  return {
    wallet: normalized,
    purpose: 'GATE',
    mode: 'full_rebuild_needed',
    ready: false,
    pagesFetched: 0,
    mergedRowCount: 0,
  };
}
