/**
 * Closed-positions 预热快照存储：Gate/Full 与 Deep 解耦。
 * READY = 扫尽（windowComplete）或 达 targetMaxPages 上限；不满页数不视为失败。
 */
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import type {
  ClosedPositionsFetchMeta,
  ClosedPositionsFetchResult,
  DataApiPosition,
} from '../polymarket/polymarketData';
import { extractClosedPositionAtMs } from '../polymarket/polymarketData';
import { SMART_MONEY_PNL_WINDOW_DAYS } from './smartMoneyPositionStats';
import { recordGateCappedMetric } from './smartMoneyCopyPoolRescoreMetrics';

export type ClosedSnapshotPurpose = 'GATE' | 'FULL';
export type ClosedSnapshotStatus = 'PENDING' | 'FETCHING' | 'READY' | 'FAILED';

export function closedSnapshotTtlMs(purpose: ClosedSnapshotPurpose): number {
  return purpose === 'FULL' ? CONFIG.smartMoneyClosedFullTtlMs : CONFIG.smartMoneyClosedGateTtlMs;
}

export function closedSnapshotTargetMaxPages(purpose: ClosedSnapshotPurpose): number {
  return purpose === 'FULL'
    ? CONFIG.smartMoneyClosedFullMaxPages
    : CONFIG.smartMoneyClosedGateMaxPages;
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

export function parseClosedRowsJson(value: unknown): DataApiPosition[] {
  if (!Array.isArray(value)) return [];
  return value as DataApiPosition[];
}

export function closedBoundsFromRows(rows: DataApiPosition[]): {
  newestClosedAt: Date | null;
  oldestClosedAt: Date | null;
} {
  let newestMs: number | null = null;
  let oldestMs: number | null = null;
  for (const row of rows) {
    const ms = extractClosedPositionAtMs(row);
    if (ms == null) continue;
    if (newestMs == null || ms > newestMs) newestMs = ms;
    if (oldestMs == null || ms < oldestMs) oldestMs = ms;
  }
  return {
    newestClosedAt: newestMs != null ? new Date(newestMs) : null,
    oldestClosedAt: oldestMs != null ? new Date(oldestMs) : null,
  };
}

export function isClosedSnapshotFresh(
  expiresAt: Date | null | undefined,
  nowMs = Date.now()
): boolean {
  if (expiresAt == null) return false;
  return expiresAt.getTime() > nowMs;
}

export function isClosedSnapshotGateReady(input: {
  status: string;
  windowComplete: boolean;
  pageCount: number;
  targetMaxPages: number;
  expiresAt?: Date | null;
  nowMs?: number;
}): boolean {
  if (input.status !== 'READY') return false;
  if (!isClosedSnapshotFresh(input.expiresAt ?? null, input.nowMs)) return false;
  return input.windowComplete || input.pageCount >= Math.max(1, input.targetMaxPages);
}

/** 计算本 tick 后是否应标 READY */
export function shouldMarkClosedSnapshotReady(input: {
  windowComplete: boolean;
  nextPage: number;
  targetMaxPages: number;
}): boolean {
  if (input.windowComplete) return true;
  return input.nextPage >= Math.max(1, input.targetMaxPages);
}

export async function ensureClosedSnapshotRow(
  wallet: string,
  purpose: ClosedSnapshotPurpose,
  options?: { windowDays?: number; resetIfExpired?: boolean }
): Promise<{ wallet: string; purpose: ClosedSnapshotPurpose; created: boolean }> {
  const normalized = normalizeWallet(wallet);
  const windowDays = options?.windowDays ?? SMART_MONEY_PNL_WINDOW_DAYS;
  const targetMaxPages = closedSnapshotTargetMaxPages(purpose);
  const existing = await prisma.smartMoneyClosedSnapshot.findUnique({
    where: {
      wallet_purpose_windowDays: { wallet: normalized, purpose, windowDays },
    },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      nextPage: true,
    },
  });

  if (!existing) {
    await prisma.smartMoneyClosedSnapshot.create({
      data: {
        wallet: normalized,
        purpose,
        windowDays,
        status: 'PENDING',
        targetMaxPages,
      },
    });
    return { wallet: normalized, purpose, created: true };
  }

  const expired = !isClosedSnapshotFresh(existing.expiresAt);
  if (options?.resetIfExpired && expired && existing.status === 'READY') {
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
        targetMaxPages,
      },
    });
  }

  return { wallet: normalized, purpose, created: false };
}

export async function loadReadyClosedFetchResult(
  wallet: string,
  purpose: ClosedSnapshotPurpose,
  options?: { windowDays?: number; nowMs?: number }
): Promise<ClosedPositionsFetchResult | null> {
  const normalized = normalizeWallet(wallet);
  const windowDays = options?.windowDays ?? SMART_MONEY_PNL_WINDOW_DAYS;
  const nowMs = options?.nowMs ?? Date.now();
  const row = await prisma.smartMoneyClosedSnapshot.findUnique({
    where: {
      wallet_purpose_windowDays: { wallet: normalized, purpose, windowDays },
    },
  });
  if (!row) return null;
  if (
    !isClosedSnapshotGateReady({
      status: row.status,
      windowComplete: row.windowComplete,
      pageCount: row.pageCount,
      targetMaxPages: row.targetMaxPages,
      expiresAt: row.expiresAt,
      nowMs,
    })
  ) {
    return null;
  }

  const rows = parseClosedRowsJson(row.rowsJson);
  const meta: ClosedPositionsFetchMeta = {
    rowCount: row.rowCount,
    pageCount: row.pageCount,
    capped: row.capped,
    timedOut: row.timedOut,
    windowComplete: row.windowComplete,
    nextPage: row.nextPage,
    startPage: 0,
    windowDays: row.windowDays,
    fetchOk: row.fetchOk,
  };
  return { rows, meta };
}

/** 兼容旧逻辑：Deep 优先 Full，其次 Gate（新逻辑建议 Deep 只读 Gate） */
export async function loadBestReadyClosedFetchResult(
  wallet: string,
  options?: { windowDays?: number; nowMs?: number }
): Promise<{ purpose: ClosedSnapshotPurpose; result: ClosedPositionsFetchResult } | null> {
  const full = await loadReadyClosedFetchResult(wallet, 'FULL', options);
  if (full) return { purpose: 'FULL', result: full };
  const gate = await loadReadyClosedFetchResult(wallet, 'GATE', options);
  if (gate) return { purpose: 'GATE', result: gate };
  return null;
}

export async function appendClosedSnapshotPages(input: {
  wallet: string;
  purpose: ClosedSnapshotPurpose;
  windowDays?: number;
  newRows: DataApiPosition[];
  pageCountDelta: number;
  nextPage: number;
  windowComplete: boolean;
  timedOut: boolean;
  fetchError?: string | null;
}): Promise<{ status: ClosedSnapshotStatus; ready: boolean }> {
  const normalized = normalizeWallet(input.wallet);
  const windowDays = input.windowDays ?? SMART_MONEY_PNL_WINDOW_DAYS;
  const purpose = input.purpose;
  const targetMaxPages = closedSnapshotTargetMaxPages(purpose);
  const ttlMs = closedSnapshotTtlMs(purpose);
  const now = new Date();

  const existing = await prisma.smartMoneyClosedSnapshot.findUnique({
    where: {
      wallet_purpose_windowDays: { wallet: normalized, purpose, windowDays },
    },
  });

  const prevRows = existing ? parseClosedRowsJson(existing.rowsJson) : [];
  const mergedRows = [...prevRows, ...input.newRows];
  const pageCount = (existing?.pageCount ?? 0) + Math.max(0, input.pageCountDelta);
  const nextPage = Math.max(0, input.nextPage);
  const windowComplete = Boolean(input.windowComplete || existing?.windowComplete);
  const timedOut = Boolean(input.timedOut);
  const ready = shouldMarkClosedSnapshotReady({
    windowComplete,
    nextPage,
    targetMaxPages,
  });
  const capped = !windowComplete && nextPage >= targetMaxPages;
  if (capped && ready) recordGateCappedMetric();
  const status: ClosedSnapshotStatus = input.fetchError
    ? 'FAILED'
    : ready
      ? 'READY'
      : 'FETCHING';
  const bounds = closedBoundsFromRows(mergedRows);

  const data = {
    status,
    rowsJson: mergedRows as unknown as Prisma.InputJsonValue,
    rowCount: mergedRows.length,
    pageCount,
    nextPage,
    targetMaxPages,
    capped,
    timedOut,
    windowComplete,
    fetchOk: !input.fetchError,
    lastError: input.fetchError ? input.fetchError.slice(0, 240) : null,
    newestClosedAt: bounds.newestClosedAt,
    oldestClosedAt: bounds.oldestClosedAt,
    fetchedAt: now,
    readyAt: ready ? now : existing?.readyAt ?? null,
    expiresAt: ready ? new Date(now.getTime() + ttlMs) : existing?.expiresAt ?? null,
    updatedAt: now,
  };

  if (!existing) {
    await prisma.smartMoneyClosedSnapshot.create({
      data: {
        wallet: normalized,
        purpose,
        windowDays,
        ...data,
      },
    });
  } else {
    await prisma.smartMoneyClosedSnapshot.update({
      where: { id: existing.id },
      data,
    });
  }

  return { status, ready };
}

export async function markClosedSnapshotFailed(
  wallet: string,
  purpose: ClosedSnapshotPurpose,
  error: string,
  options?: { windowDays?: number }
): Promise<void> {
  const normalized = normalizeWallet(wallet);
  const windowDays = options?.windowDays ?? SMART_MONEY_PNL_WINDOW_DAYS;
  await prisma.smartMoneyClosedSnapshot.upsert({
    where: {
      wallet_purpose_windowDays: { wallet: normalized, purpose, windowDays },
    },
    create: {
      wallet: normalized,
      purpose,
      windowDays,
      status: 'FAILED',
      targetMaxPages: closedSnapshotTargetMaxPages(purpose),
      lastError: error.slice(0, 240),
      fetchOk: false,
      fetchedAt: new Date(),
    },
    update: {
      status: 'FAILED',
      lastError: error.slice(0, 240),
      fetchOk: false,
      fetchedAt: new Date(),
    },
  });
}

/** 从 Gate 播种 Full（续拉剩余页，避免入池后从 0 重拉） */
export async function seedFullSnapshotFromGate(wallet: string): Promise<boolean> {
  const normalized = normalizeWallet(wallet);
  const windowDays = SMART_MONEY_PNL_WINDOW_DAYS;
  const gate = await prisma.smartMoneyClosedSnapshot.findUnique({
    where: {
      wallet_purpose_windowDays: { wallet: normalized, purpose: 'GATE', windowDays },
    },
  });
  if (!gate || gate.status !== 'READY') return false;

  const existingFull = await prisma.smartMoneyClosedSnapshot.findUnique({
    where: {
      wallet_purpose_windowDays: { wallet: normalized, purpose: 'FULL', windowDays },
    },
    select: { id: true, status: true, expiresAt: true },
  });
  if (
    existingFull &&
    existingFull.status === 'READY' &&
    isClosedSnapshotFresh(existingFull.expiresAt)
  ) {
    return true;
  }

  const targetMaxPages = closedSnapshotTargetMaxPages('FULL');
  const alreadyFullReady = shouldMarkClosedSnapshotReady({
    windowComplete: gate.windowComplete,
    nextPage: gate.nextPage,
    targetMaxPages,
  });

  const data = {
    status: alreadyFullReady ? ('READY' as const) : ('FETCHING' as const),
    rowsJson: gate.rowsJson as Prisma.InputJsonValue,
    rowCount: gate.rowCount,
    pageCount: gate.pageCount,
    nextPage: gate.nextPage,
    targetMaxPages,
    capped: !gate.windowComplete && gate.nextPage >= targetMaxPages,
    timedOut: gate.timedOut,
    windowComplete: gate.windowComplete,
    fetchOk: gate.fetchOk,
    lastError: null,
    fetchedAt: gate.fetchedAt ?? new Date(),
    readyAt: alreadyFullReady ? gate.readyAt ?? new Date() : null,
    expiresAt: alreadyFullReady
      ? new Date(Date.now() + closedSnapshotTtlMs('FULL'))
      : null,
  };

  await prisma.smartMoneyClosedSnapshot.upsert({
    where: {
      wallet_purpose_windowDays: { wallet: normalized, purpose: 'FULL', windowDays },
    },
    create: {
      wallet: normalized,
      purpose: 'FULL',
      windowDays,
      ...data,
    },
    update: data,
  });
  return true;
}

/** Deep 批：QUALIFIED 无 READY Gate 快照则让出配额；COPY_POOL/SCORED 仍可进（缺则内部 defer） */
export async function filterDeepBatchByClosedReady(wallets: string[]): Promise<string[]> {
  if (
    !CONFIG.smartMoneyClosedPrefetchEnabled ||
    !CONFIG.smartMoneyDeepRequireClosedSnapshot ||
    wallets.length === 0
  ) {
    return wallets;
  }

  const normalized = wallets.map((w) => w.trim().toLowerCase());
  const stageRows = await prisma.smartMoneyRawAddress.findMany({
    where: { wallet: { in: normalized } },
    select: { wallet: true, pipelineStage: true },
  });
  const stageBy = new Map(stageRows.map((r) => [r.wallet.toLowerCase(), r.pipelineStage]));

  const readyRows = await prisma.smartMoneyClosedSnapshot.findMany({
    where: {
      wallet: { in: normalized },
      purpose: 'GATE',
      status: 'READY',
      expiresAt: { gt: new Date() },
      windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
    },
    select: {
      wallet: true,
      status: true,
      windowComplete: true,
      pageCount: true,
      targetMaxPages: true,
      expiresAt: true,
    },
  });
  const nowMs = Date.now();
  const readySet = new Set(
    readyRows
      .filter((row) =>
        isClosedSnapshotGateReady({
          status: row.status,
          windowComplete: row.windowComplete,
          pageCount: row.pageCount,
          targetMaxPages: row.targetMaxPages,
          expiresAt: row.expiresAt,
          nowMs,
        })
      )
      .map((row) => row.wallet.toLowerCase())
  );

  return normalized.filter((wallet) => {
    const stage = (stageBy.get(wallet) ?? '').toUpperCase();
    if (stage === 'COPY_POOL' || stage === 'SCORED') return true;
    return readySet.has(wallet);
  });
}

/**
 * Deep 补位：当 pickDeepAnalyzeBatch 抽到大量未 READY 地址时，
 * 从「已 READY Gate 且可 Deep」的 QUALIFIED 中补满本批，避免 Deep 配额空转。
 */
export async function topUpDeepBatchWithReadyQualified(
  limit: number,
  options?: { excludeWallets?: string[] }
): Promise<string[]> {
  if (
    limit <= 0 ||
    !CONFIG.smartMoneyClosedPrefetchEnabled ||
    !CONFIG.smartMoneyDeepRequireClosedSnapshot
  ) {
    return [];
  }
  const exclude = new Set((options?.excludeWallets ?? []).map((w) => normalizeWallet(w)));
  const now = new Date();
  const take = limit + exclude.size;
  const candidates = await prisma.$queryRaw<Array<{ wallet: string }>>`
    SELECT ra.wallet
    FROM "SmartMoneyRawAddress" ra
    INNER JOIN "SmartMoneyClosedSnapshot" cs
      ON cs.wallet = ra.wallet
      AND cs.purpose = 'GATE'
      AND cs."windowDays" = ${SMART_MONEY_PNL_WINDOW_DAYS}
    WHERE ra."pipelineStage" = 'QUALIFIED'
      AND ra.dormant = false
      AND (ra."nextDeepAnalyzeAt" IS NULL OR ra."nextDeepAnalyzeAt" <= ${now})
      AND cs.status = 'READY'
      AND cs."expiresAt" > ${now}
      AND (
        cs."windowComplete" = true
        OR cs."pageCount" >= GREATEST(1, cs."targetMaxPages")
      )
    ORDER BY ra."nextDeepAnalyzeAt" ASC NULLS FIRST, ra."updatedAt" ASC
    LIMIT ${take}
  `;
  return candidates
    .map((row) => normalizeWallet(row.wallet))
    .filter((wallet) => !exclude.has(wallet))
    .slice(0, limit);
}
