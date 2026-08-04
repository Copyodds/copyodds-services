import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  fetchLeaderboardWithRetry,
  type LeaderboardApiEntry,
} from '../polymarket/polymarketLeaderboard';
import {
  getLatestCompleteOfficialLeaderboardBatch,
  type LeaderboardPreset,
} from '../polymarket/leaderboardCache';
import { syncPredictingTopLeaderboards } from '../polymarket/predictingTopLeaderboard';
import { syncPolymarketAnalyticsLeaderboards } from '../polymarket/polymarketAnalyticsLeaderboard';
import { runSmartMoneyCandidatePipeline } from '../smartMoney/smartMoneyCron';
import { refreshDiscoveryAfterLeaderboardSync } from '../smartMoney/smartMoneyDiscoveryCursor';

let syncRunning = false;
/** candidate follow-up 上次触发时间：窗口化后每 5min sync 都会成功，follow-up 必须限频 */
let lastCandidateFollowUpAt = 0;
/** 第三方榜上次同步时间（默认与官方错峰 2h） */
let lastExternalLeaderboardSyncAt = 0;

const PAGE_LIMIT = 50;
const MIN_HEALTHY_ROWS = 500;
const LEADERBOARD_CREATE_CHUNK_SIZE = 500;
const LEADERBOARD_DELETE_CHUNK_SIZE = 500;

function getMaxRowsPerPreset(): number {
  return Math.max(1000, CONFIG.smartMoneyDiscoveryMaxRowsPerPreset);
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function parseLeaderboardRank(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function apiEntryToCreateInput(
  e: LeaderboardApiEntry,
  preset: LeaderboardPreset,
  batchId: string,
  syncedAt: Date,
  syncVersion: number
): Prisma.LeaderboardRowCreateManyInput | null {
  const rank = parseLeaderboardRank(e.rank);
  const raw = typeof e.proxyWallet === 'string' ? e.proxyWallet.trim().toLowerCase() : '';
  if (rank == null || !/^0x[a-f0-9]{40}$/.test(raw)) {
    return null;
  }
  const vol = e.vol != null ? String(e.vol) : '0';
  const pnl = e.pnl != null ? String(e.pnl) : '0';
  return {
    category: preset.category,
    timePeriod: preset.timePeriod,
    orderBy: preset.orderBy,
    batchId,
    syncVersion,
    rank,
    proxyWallet: raw,
    userName: e.userName ?? null,
    profileImage: typeof e.profileImage === 'string' ? e.profileImage : null,
    xUsername: xUsernameFromEntry(e),
    vol: new Prisma.Decimal(vol),
    pnl: new Prisma.Decimal(pnl),
    syncedAt,
  };
}

function xUsernameFromEntry(e: LeaderboardApiEntry): string | null {
  const v = e.xUsername;
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

function getPageSignature(page: LeaderboardApiEntry[]): string {
  if (page.length === 0) return 'empty';
  const first = page[0];
  const last = page[page.length - 1];
  return JSON.stringify({
    len: page.length,
    firstRank: first?.rank ?? null,
    firstWallet: first?.proxyWallet ?? null,
    lastRank: last?.rank ?? null,
    lastWallet: last?.proxyWallet ?? null,
  });
}

type PresetFetchResult = {
  preset: LeaderboardPreset;
  rows: Prisma.LeaderboardRowCreateManyInput[];
  syncVersion: number;
  previousCount: number;
  fetchedCount: number;
  acceptedCount: number;
  filteredCount: number;
  duplicateCount: number;
  pageCount: number;
  stoppedByRepeat: boolean;
  firstPageEmpty: boolean;
  healthy: boolean;
  healthReason: string | null;
  elapsedMs: number;
};

function getPresetLabel(preset: LeaderboardPreset): string {
  return `${preset.category}:${preset.timePeriod}:${preset.orderBy}`;
}

function createLeaderboardBatchId(syncedAt: Date): string {
  return `official-${syncedAt.getTime()}`;
}

function getHealthyRowThreshold(previousCount: number): number {
  const maxRows = getMaxRowsPerPreset();
  if (previousCount <= 0) {
    return Math.min(MIN_HEALTHY_ROWS, maxRows);
  }
  return Math.min(maxRows, Math.max(MIN_HEALTHY_ROWS, Math.ceil(previousCount * 0.8)));
}

function getPresetHealthyRowThreshold(preset: LeaderboardPreset, previousCount: number): number {
  if (preset.category === 'OVERALL') {
    return getHealthyRowThreshold(previousCount);
  }
  if (previousCount <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(previousCount * 0.5));
}

function evaluatePresetHealth(input: {
  preset: LeaderboardPreset;
  previousCount: number;
  acceptedCount: number;
  firstPageEmpty: boolean;
  stoppedByRepeat: boolean;
}): { healthy: boolean; reason: string | null } {
  if (input.firstPageEmpty) {
    return { healthy: false, reason: 'first page is empty' };
  }

  if (input.acceptedCount === 0) {
    return { healthy: false, reason: 'no valid rows accepted' };
  }

  const threshold = getPresetHealthyRowThreshold(input.preset, input.previousCount);
  if (input.acceptedCount < threshold) {
    return {
      healthy: false,
      reason: `accepted rows ${input.acceptedCount} below threshold ${threshold}`,
    };
  }

  if (input.stoppedByRepeat && input.acceptedCount < getMaxRowsPerPreset()) {
    return {
      healthy: false,
      reason: 'stopped by repeated page before reaching safe row count',
    };
  }

  return { healthy: true, reason: null };
}

async function fetchAllPagesForPreset(
  preset: LeaderboardPreset,
  gapMs: number,
  batchId: string,
  syncedAt: Date,
  syncVersion: number,
  previousCount: number
): Promise<PresetFetchResult> {
  const rows: Prisma.LeaderboardRowCreateManyInput[] = [];
  const seenPageSignatures = new Set<string>();
  const seenRanks = new Set<number>();
  const seenWallets = new Set<string>();
  let offset = 0;
  let pageCount = 0;
  let stoppedByRepeat = false;
  let fetchedCount = 0;
  let filteredCount = 0;
  let duplicateCount = 0;
  let firstPageEmpty = false;
  const startedAt = Date.now();
  for (;;) {
    const page = await fetchLeaderboardWithRetry(
      {
        category: preset.category,
        timePeriod: preset.timePeriod,
        orderBy: preset.orderBy,
        limit: PAGE_LIMIT,
        offset,
      },
      { gapMs }
    );
    if (page.length === 0) {
      if (pageCount === 0) {
        firstPageEmpty = true;
      }
      break;
    }
    pageCount += 1;
    fetchedCount += page.length;
    const pageSignature = getPageSignature(page);
    if (seenPageSignatures.has(pageSignature)) {
      stoppedByRepeat = true;
      console.warn('[leaderboard-cron] repeated tail page detected, stopping pagination', {
        preset,
        offset,
        pageCount,
        signature: pageSignature,
      });
      break;
    }
    seenPageSignatures.add(pageSignature);
    for (const entry of page) {
      const row = apiEntryToCreateInput(entry, preset, batchId, syncedAt, syncVersion);
      if (!row) {
        filteredCount += 1;
        continue;
      }
      if (seenRanks.has(row.rank) || seenWallets.has(row.proxyWallet)) {
        duplicateCount += 1;
        continue;
      }
      seenRanks.add(row.rank);
      seenWallets.add(row.proxyWallet);
      rows.push(row);
      if (rows.length >= getMaxRowsPerPreset()) {
        const health = evaluatePresetHealth({
          previousCount,
          preset,
          acceptedCount: rows.length,
          firstPageEmpty,
          stoppedByRepeat,
        });
        return {
          preset,
          rows,
          syncVersion,
          previousCount,
          fetchedCount,
          acceptedCount: rows.length,
          filteredCount,
          duplicateCount,
          pageCount,
          stoppedByRepeat,
          firstPageEmpty,
          healthy: health.healthy,
          healthReason: health.reason,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }

  const health = evaluatePresetHealth({
    previousCount,
    preset,
    acceptedCount: rows.length,
    firstPageEmpty,
    stoppedByRepeat,
  });
  return {
    preset,
    rows,
    syncVersion,
    previousCount,
    fetchedCount,
    acceptedCount: rows.length,
    filteredCount,
    duplicateCount,
    pageCount,
    stoppedByRepeat,
    firstPageEmpty,
    healthy: health.healthy,
    healthReason: health.reason,
    elapsedMs: Date.now() - startedAt,
  };
}

async function getPresetSyncState(preset: LeaderboardPreset): Promise<{ previousCount: number; syncVersion: number }> {
  const aggregate = await prisma.leaderboardRow.aggregate({
    where: {
      category: preset.category,
      timePeriod: preset.timePeriod,
      orderBy: preset.orderBy,
    },
    _count: { _all: true },
    _max: { syncVersion: true },
  });

  return {
    previousCount: aggregate._count._all,
    syncVersion: (aggregate._max.syncVersion ?? 0) + 1,
  };
}

async function pruneStaleOfficialLeaderboardBatches(batchId: string, results: PresetFetchResult[]): Promise<number> {
  let deletedRows = 0;

  for (const { preset } of results) {
    for (;;) {
      const staleRows = await prisma.leaderboardRow.findMany({
        where: {
          category: preset.category,
          timePeriod: preset.timePeriod,
          orderBy: preset.orderBy,
          batchId: { not: batchId },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: LEADERBOARD_DELETE_CHUNK_SIZE,
      });

      if (staleRows.length === 0) {
        break;
      }

      const deleted = await prisma.leaderboardRow.deleteMany({
        where: { id: { in: staleRows.map((row) => row.id) } },
      });
      deletedRows += deleted.count;
      if (staleRows.length < LEADERBOARD_DELETE_CHUNK_SIZE) {
        break;
      }
    }
  }

  return deletedRows;
}

async function applyOfficialLeaderboardBatch(
  batchId: string,
  results: PresetFetchResult[]
): Promise<{ writtenRows: number; deletedRows: number }> {
  const rows = results.flatMap((result) => result.rows);
  let writtenRows = 0;

  for (let offset = 0; offset < rows.length; offset += LEADERBOARD_CREATE_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + LEADERBOARD_CREATE_CHUNK_SIZE);
    if (chunk.length === 0) {
      continue;
    }
    const result = await prisma.leaderboardRow.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    writtenRows += result.count;
  }

  const deletedRows = await pruneStaleOfficialLeaderboardBatches(batchId, results);
  return { writtenRows, deletedRows };
}

// ---------------------------------------------------------------------------
// 窗口化拉取（LEADERBOARD_WINDOW_FETCH=true，默认路径）
// 每轮 cron 每个 preset 只拉 [nextOffset, nextOffset + windowSize)，merge 入库；
// 扫到尾部或硬顶后 offset 回 0，持续轮询。整批替换语义仅保留在 legacy 回滚路径。
// ---------------------------------------------------------------------------

/**
 * 窗口化 merge 写入的稳定批次 ID：同 category 三个周期共用，
 * 读侧 getLatestCompleteOfficialLeaderboardBatch 的「完整批」语义保持不变。
 */
function getStableBatchId(category: string): string {
  return `official-merged-${category}`;
}

type WindowFetchResult = {
  preset: LeaderboardPreset;
  rows: Prisma.LeaderboardRowCreateManyInput[];
  fromOffset: number;
  windowSize: number;
  fetchedCount: number;
  filteredCount: number;
  duplicateCount: number;
  pageCount: number;
  stoppedByRepeat: boolean;
  firstPageEmpty: boolean;
  /** 本窗已到尾部（空页/短页/重复页/硬顶），游标应回 0 开启下一轮 */
  reachedEnd: boolean;
  elapsedMs: number;
};

async function fetchWindowForPreset(
  preset: LeaderboardPreset,
  gapMs: number,
  fromOffset: number,
  cycleId: number,
  syncedAt: Date
): Promise<WindowFetchResult> {
  const windowSize = CONFIG.leaderboardWindowSize;
  const hardMaxOffset = CONFIG.leaderboardHardMaxOffset;
  const windowEnd = Math.min(fromOffset + windowSize, hardMaxOffset);
  const stableBatchId = getStableBatchId(preset.category);

  const rows: Prisma.LeaderboardRowCreateManyInput[] = [];
  const seenPageSignatures = new Set<string>();
  const seenRanks = new Set<number>();
  const seenWallets = new Set<string>();
  let offset = fromOffset;
  let pageCount = 0;
  let fetchedCount = 0;
  let filteredCount = 0;
  let duplicateCount = 0;
  let stoppedByRepeat = false;
  let firstPageEmpty = false;
  let reachedEnd = false;
  const startedAt = Date.now();

  while (offset < windowEnd) {
    const page = await fetchLeaderboardWithRetry(
      {
        category: preset.category,
        timePeriod: preset.timePeriod,
        orderBy: preset.orderBy,
        limit: PAGE_LIMIT,
        offset,
      },
      { gapMs }
    );
    if (page.length === 0) {
      if (pageCount === 0) firstPageEmpty = true;
      reachedEnd = true;
      break;
    }
    pageCount += 1;
    fetchedCount += page.length;
    const pageSignature = getPageSignature(page);
    if (seenPageSignatures.has(pageSignature)) {
      stoppedByRepeat = true;
      reachedEnd = true;
      break;
    }
    seenPageSignatures.add(pageSignature);
    for (const entry of page) {
      const row = apiEntryToCreateInput(entry, preset, stableBatchId, syncedAt, cycleId);
      if (!row) {
        filteredCount += 1;
        continue;
      }
      if (seenRanks.has(row.rank) || seenWallets.has(row.proxyWallet)) {
        duplicateCount += 1;
        continue;
      }
      seenRanks.add(row.rank);
      seenWallets.add(row.proxyWallet);
      rows.push(row);
    }
    if (page.length < PAGE_LIMIT) {
      reachedEnd = true;
      break;
    }
    offset += PAGE_LIMIT;
  }

  if (fromOffset + windowSize >= hardMaxOffset) {
    reachedEnd = true;
  }

  return {
    preset,
    rows,
    fromOffset,
    windowSize,
    fetchedCount,
    filteredCount,
    duplicateCount,
    pageCount,
    stoppedByRepeat,
    firstPageEmpty,
    reachedEnd,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * merge 写入：只替换本窗 rank 区间，其它区间旧行保留。
 * 同 rank 的旧批次行也在删除范围内，legacy 批次会随窗口推进逐步迁移到稳定批次。
 */
async function applyOfficialLeaderboardWindow(result: WindowFetchResult): Promise<number> {
  const { preset, rows, fromOffset, windowSize } = result;
  const rowRanks = rows.map((row) => row.rank);
  const maxRowRank = Math.max(0, ...rowRanks);
  // lowRank 取「窗口理论起点」与「实际返回最小 rank」的较小值，避免 API offset/rank 未严格对齐时漏删；
  // highRank 同理取较大值，确保本窗覆盖区间被完整替换
  const lowRank = Math.min(fromOffset + 1, ...rowRanks);
  const highRank = Math.max(fromOffset + windowSize, maxRowRank);

  // 删除 + 写入放同一事务：前端 /leaderboard 直接读本表，非原子会让用户瞬时看到该 rank 区间为空。
  // 单窗 ~1000 行、单条 createMany 批量语句，持连亚秒级，不会长期占用连接。
  let writtenRows = 0;
  await prisma.$transaction(
    async (tx) => {
      await tx.leaderboardRow.deleteMany({
        where: {
          category: preset.category,
          timePeriod: preset.timePeriod,
          orderBy: preset.orderBy,
          rank: { gte: lowRank, lte: highRank },
        },
      });
      for (let i = 0; i < rows.length; i += LEADERBOARD_CREATE_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + LEADERBOARD_CREATE_CHUNK_SIZE);
        const created = await tx.leaderboardRow.createMany({ data: chunk, skipDuplicates: true });
        writtenRows += created.count;
      }
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  return writtenRows;
}

/**
 * 首次切换窗口模式时，把最近一个完整 legacy 批次的行改挂到稳定批次下，
 * 避免读侧在首个完整扫描周期（约 1 小时）内只能看到已覆盖的窗口。
 */
async function adoptLegacyBatchForCategory(category: string): Promise<number> {
  const stableBatchId = getStableBatchId(category);
  const existing = await prisma.leaderboardRow.count({
    where: { category, batchId: stableBatchId },
  });
  if (existing > 0) return 0;

  const latest = await getLatestCompleteOfficialLeaderboardBatch(category);
  if (!latest || latest.batchId === stableBatchId) return 0;

  // 同步刷新 syncedAt：legacy 行的时间戳可能已超过僵尸行保留时长，
  // 不刷新会在收养后第一轮 prune 被整批删掉，头部要等窗口扫完一轮才回来
  const updated = await prisma.leaderboardRow.updateMany({
    where: { category, batchId: latest.batchId },
    data: { batchId: stableBatchId, syncedAt: new Date() },
  });
  return updated.count;
}

async function loadOrCreateCursor(preset: LeaderboardPreset) {
  return prisma.leaderboardSyncCursor.upsert({
    where: {
      category_timePeriod_orderBy: {
        category: preset.category,
        timePeriod: preset.timePeriod,
        orderBy: preset.orderBy,
      },
    },
    create: {
      category: preset.category,
      timePeriod: preset.timePeriod,
      orderBy: preset.orderBy,
      nextOffset: 0,
      cycleId: 1,
    },
    update: {},
  });
}

async function advanceCursor(
  cursorId: number,
  cycleId: number,
  result: WindowFetchResult
): Promise<{ nextOffset: number; cycleId: number }> {
  const wrapped = result.reachedEnd;
  const next = wrapped
    ? { nextOffset: 0, cycleId: cycleId + 1 }
    : { nextOffset: result.fromOffset + result.windowSize, cycleId };
  await prisma.leaderboardSyncCursor.update({
    where: { id: cursorId },
    data: { ...next, lastWindowAt: new Date() },
  });
  return next;
}

/** 僵尸行清理：超过保留时长未被任何窗口刷新的 rank 行（含 legacy 残留、榜尾缩短后的旧行） */
async function pruneStaleLeaderboardWindowRows(presets: LeaderboardPreset[]): Promise<number> {
  const cutoff = new Date(Date.now() - CONFIG.leaderboardStaleRowRetentionMs);
  let deletedRows = 0;
  for (const preset of presets) {
    const deleted = await prisma.leaderboardRow.deleteMany({
      where: {
        category: preset.category,
        timePeriod: preset.timePeriod,
        orderBy: preset.orderBy,
        syncedAt: { lt: cutoff },
      },
    });
    deletedRows += deleted.count;
  }
  return deletedRows;
}

/** 窗口化官方榜同步：串行处理每个 preset 的当前窗口，返回是否有任何写入 */
async function runOfficialWindowSync(
  presets: LeaderboardPreset[],
  gapMs: number
): Promise<boolean> {
  let anyApplied = false;
  const adoptedCategories = new Set<string>();
  const syncedAt = new Date();

  for (const preset of presets) {
    const presetStartedAt = Date.now();
    try {
      if (!adoptedCategories.has(preset.category)) {
        adoptedCategories.add(preset.category);
        const adopted = await adoptLegacyBatchForCategory(preset.category);
        if (adopted > 0) {
          console.log('[leaderboard-cron] legacy batch adopted into merged batch', {
            category: preset.category,
            rows: adopted,
          });
        }
      }

      const cursor = await loadOrCreateCursor(preset);
      const result = await fetchWindowForPreset(
        preset,
        gapMs,
        cursor.nextOffset,
        cursor.cycleId,
        syncedAt
      );

      // offset=0 空首页视为 API 异常：不写入、不推进游标，下轮原窗重试
      const unhealthy = result.firstPageEmpty && result.fromOffset === 0;
      let writtenRows = 0;
      let nextCursor = { nextOffset: cursor.nextOffset, cycleId: cursor.cycleId };
      if (!unhealthy) {
        if (result.rows.length > 0) {
          writtenRows = await applyOfficialLeaderboardWindow(result);
          anyApplied = true;
        }
        nextCursor = await advanceCursor(cursor.id, cursor.cycleId, result);
      }

      console[unhealthy ? 'warn' : 'log'](
        unhealthy
          ? '[leaderboard-cron] window unhealthy (empty first page at offset 0)'
          : '[leaderboard-cron] window fetched',
        {
          preset: getPresetLabel(preset),
          cycleId: cursor.cycleId,
          fromOffset: result.fromOffset,
          windowSize: result.windowSize,
          fetchedCount: result.fetchedCount,
          acceptedCount: result.rows.length,
          writtenRows,
          filteredCount: result.filteredCount,
          duplicateCount: result.duplicateCount,
          stoppedByRepeat: result.stoppedByRepeat,
          reachedEnd: result.reachedEnd,
          nextOffset: nextCursor.nextOffset,
          elapsed: formatDurationMs(result.elapsedMs),
        }
      );
    } catch (err) {
      console.warn('[leaderboard-cron] window preset failed', {
        preset: getPresetLabel(preset),
        elapsed: formatDurationMs(Date.now() - presetStartedAt),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    const prunedRows = await pruneStaleLeaderboardWindowRows(presets);
    if (prunedRows > 0) {
      console.log('[leaderboard-cron] stale window rows pruned', { prunedRows });
    }
  } catch (err) {
    console.warn('[leaderboard-cron] stale window row prune failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return anyApplied;
}

/** legacy 全量路径（LEADERBOARD_WINDOW_FETCH=false 时的回滚开关）：每轮尽量全量 + 整批替换 */
async function runOfficialFullSync(
  presets: LeaderboardPreset[],
  gapMs: number,
  batchId: string,
  batchSyncedAt: Date
): Promise<boolean> {
  const presetResults: PresetFetchResult[] = [];
  for (const preset of presets) {
    const presetStartedAt = Date.now();
    try {
      const syncState = await getPresetSyncState(preset);
      const result = await fetchAllPagesForPreset(
        preset,
        gapMs,
        batchId,
        batchSyncedAt,
        syncState.syncVersion,
        syncState.previousCount
      );
      presetResults.push(result);
      const logPrefix = result.healthy ? '[leaderboard-cron] preset fetched' : '[leaderboard-cron] preset unhealthy';
      console[result.healthy ? 'log' : 'warn'](logPrefix, {
        preset,
        batchId,
        syncVersion: result.syncVersion,
        previousCount: result.previousCount,
        fetchedCount: result.fetchedCount,
        acceptedCount: result.acceptedCount,
        filteredCount: result.filteredCount,
        duplicateCount: result.duplicateCount,
        pageCount: result.pageCount,
        stoppedByRepeat: result.stoppedByRepeat,
        firstPageEmpty: result.firstPageEmpty,
        healthy: result.healthy,
        healthReason: result.healthReason,
        elapsed: formatDurationMs(result.elapsedMs),
      });
    } catch (err) {
      console.warn('[leaderboard-cron] preset failed', {
        preset,
        elapsed: formatDurationMs(Date.now() - presetStartedAt),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const healthyResults = presetResults.filter((result) => result.healthy);
  let applied = false;
  if (healthyResults.length > 0) {
    const appliedStats = await applyOfficialLeaderboardBatch(batchId, healthyResults);
    applied = true;
    console.log('[leaderboard-cron] official batch applied (partial ok)', {
      batchId,
      appliedPresetCount: healthyResults.length,
      expectedPresetCount: presets.length,
      rowCount: appliedStats.writtenRows,
      deletedRows: appliedStats.deletedRows,
    });
  }

  if (healthyResults.length !== presets.length) {
    const unhealthy = presetResults
      .filter((result) => !result.healthy)
      .map((result) => ({
        preset: getPresetLabel(result.preset),
        reason: result.healthReason,
      }));
    const missingPresets = presets
      .filter(
        (preset) =>
          !presetResults.some((result) => getPresetLabel(result.preset) === getPresetLabel(preset)),
      )
      .map((preset) => getPresetLabel(preset));

    console.warn('[leaderboard-cron] official batch incomplete', {
      batchId,
      fetchedPresetCount: presetResults.length,
      expectedPresetCount: presets.length,
      appliedPresetCount: healthyResults.length,
      unhealthy,
      missingPresets,
    });
  }

  return applied;
}

/**
 * 按 CONFIG.leaderboardSyncPresets 串行拉取，全部 preset 健康时才整批切换。
 * 当前仅有单进程内防重入；若部署多副本，应配合外部锁避免重复抓取。
 */
export async function runLeaderboardSync(): Promise<void> {
  if (syncRunning) return;
  syncRunning = true;
  const gapMs = CONFIG.leaderboardRequestGapMs;
  const presets = CONFIG.leaderboardSyncPresets;
  const syncStartedAt = Date.now();
  const batchSyncedAt = new Date();
  const batchId = createLeaderboardBatchId(batchSyncedAt);
  let officialBatchApplied = false;
  let externalSynced = false;

  try {
    console.log('[leaderboard-cron] sync started', {
      presetCount: presets.length,
      pageLimit: PAGE_LIMIT,
      windowFetch: CONFIG.leaderboardWindowFetchEnabled,
      windowSize: CONFIG.leaderboardWindowSize,
      hardMaxOffset: CONFIG.leaderboardHardMaxOffset,
      maxRowsPerPreset: getMaxRowsPerPreset(),
      gapMs,
      batchId,
    });

    if (CONFIG.leaderboardWindowFetchEnabled) {
      officialBatchApplied = await runOfficialWindowSync(presets, gapMs);
    } else {
      officialBatchApplied = await runOfficialFullSync(presets, gapMs, batchId, batchSyncedAt);
    }

    if (officialBatchApplied) {
      try {
        const [weekRow, allRow] = await Promise.all([
          prisma.leaderboardRow.findFirst({
            where: { category: 'OVERALL', timePeriod: 'WEEK', orderBy: 'PNL' },
            orderBy: [{ syncVersion: 'desc' }, { syncedAt: 'desc' }],
            select: { syncVersion: true },
          }),
          prisma.leaderboardRow.findFirst({
            where: { category: 'OVERALL', timePeriod: 'ALL', orderBy: 'PNL' },
            orderBy: [{ syncVersion: 'desc' }, { syncedAt: 'desc' }],
            select: { syncVersion: true },
          }),
        ]);
        const discovery = await refreshDiscoveryAfterLeaderboardSync({
          weekSyncVersion: weekRow?.syncVersion ?? null,
          allSyncVersion: allRow?.syncVersion ?? null,
        });
        console.log('[leaderboard-cron] discovery cursor refreshed', discovery);
      } catch (err) {
        console.warn('[leaderboard-cron] discovery cursor refresh failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const externalMin = CONFIG.leaderboardExternalMinIntervalMs;
    const sinceExternal = Date.now() - lastExternalLeaderboardSyncAt;
    const shouldSyncExternal = externalMin <= 0 || sinceExternal >= externalMin;

    if (!shouldSyncExternal) {
      console.log('[leaderboard-cron] external sync throttled', {
        sinceLastExternalMs: sinceExternal,
        minIntervalMs: externalMin,
      });
    } else {
      try {
        const predictingTopResults = await syncPredictingTopLeaderboards({
          delayBetweenPeriodsMs: gapMs,
        });
        for (const result of predictingTopResults) {
          console.log('[leaderboard-cron] external predicting.top synced', {
            period: result.period,
            syncVersion: result.syncVersion,
            fetchedCount: result.fetchedCount,
            rowCount: result.rowCount,
          });
        }
        if (predictingTopResults.some((result) => result.rowCount > 0)) {
          externalSynced = true;
        }
      } catch (err) {
        console.warn('[leaderboard-cron] external predicting.top sync failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (CONFIG.polymarketAnalyticsApiKey) {
        try {
          const analyticsResults = await syncPolymarketAnalyticsLeaderboards({
            delayBetweenPeriodsMs: gapMs,
          });
          for (const result of analyticsResults) {
            console.log('[leaderboard-cron] polymarket analytics synced', {
              period: result.period,
              syncVersion: result.syncVersion,
              fetchedCount: result.fetchedCount,
              rowCount: result.rowCount,
            });
          }
          if (analyticsResults.some((result) => result.rowCount > 0)) {
            externalSynced = true;
          }
        } catch (err) {
          console.warn('[leaderboard-cron] polymarket analytics sync failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (externalSynced || shouldSyncExternal) {
        lastExternalLeaderboardSyncAt = Date.now();
      }
    }
  } finally {
    console.log('[leaderboard-cron] sync finished', {
      elapsed: formatDurationMs(Date.now() - syncStartedAt),
      officialBatchApplied,
      externalSynced,
      batchId,
    });

    if ((officialBatchApplied || externalSynced) && CONFIG.smartMoneyCronEnabled) {
      // 窗口化后每个 sync tick 都会成功写入，candidate follow-up 按最小间隔限频，
      // 避免每 5 分钟做一次全量候选合并把发现层省下的资源吃回去
      const sinceLastFollowUp = Date.now() - lastCandidateFollowUpAt;
      if (sinceLastFollowUp >= CONFIG.leaderboardCandidateFollowUpMinIntervalMs) {
        lastCandidateFollowUpAt = Date.now();
        try {
          const stats = await runSmartMoneyCandidatePipeline('leaderboard-sync');
          console.log('[leaderboard-cron] smart-money follow-up finished', {
            candidateSynced: stats?.candidateSynced ?? null,
            candidateCount: stats?.candidateCount ?? null,
            elapsedMs: stats?.elapsedMs ?? null,
          });
        } catch (err) {
          // NOTE: smart-money follow-up failures used to be silent, which makes test env debugging painful.
          // Keep this log terse; detailed per-wallet failures are handled inside smart-money pipeline.
          console.warn('[leaderboard-cron] smart-money follow-up failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        console.log('[leaderboard-cron] smart-money follow-up throttled', {
          sinceLastFollowUpMs: sinceLastFollowUp,
          minIntervalMs: CONFIG.leaderboardCandidateFollowUpMinIntervalMs,
        });
      }
    }

    syncRunning = false;
  }
}
