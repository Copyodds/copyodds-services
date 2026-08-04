/**
 * 发现源游标 + 日榜增量优先队列（设计 §3.3）。
 * 含 TopN 新进 / 名次上升≥K / 多源长尾游标。
 */
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';

export const DISCOVERY_PRIORITY_SOURCE = 'PRIORITY_QUEUE';
export const DISCOVERY_WEEK_SOURCE = 'OFFICIAL:OVERALL:WEEK';
export const DISCOVERY_ALL_SOURCE = 'OFFICIAL:OVERALL:ALL';
export const DISCOVERY_PREDICTING_ALL = 'PREDICTING_TOP:ALL';
export const DISCOVERY_ANALYTICS_30D = 'ANALYTICS:30D';
export const DISCOVERY_RANK_SNAPSHOT = 'RANK_SNAPSHOT:WEEK';
export const DISCOVERY_SHORTFALL = 'REFILL_SHORTFALL';

export const OFFICIAL_CATEGORY_ALL_SOURCES = [
  'OFFICIAL:POLITICS:ALL',
  'OFFICIAL:SPORTS:ALL',
  'OFFICIAL:CRYPTO:ALL',
  'OFFICIAL:CULTURE:ALL',
  'OFFICIAL:MENTIONS:ALL',
  'OFFICIAL:WEATHER:ALL',
  'OFFICIAL:ECONOMICS:ALL',
  'OFFICIAL:TECH:ALL',
  'OFFICIAL:FINANCE:ALL',
] as const;

type PriorityEntry = {
  wallet: string;
  reason: 'REVIVE|OFFICIAL_TOP' | 'REVIVE|RANK_JUMP' | 'NEW';
};

type PriorityMeta = {
  wallets: string[];
  entries?: PriorityEntry[];
  builtAt?: string;
  syncVersion?: number | null;
};

type RankSnapshotMeta = {
  ranks: Record<string, number>;
  syncVersion?: number | null;
};

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function parseCategorySource(source: string): { category: string; timePeriod: string } | null {
  if (source.startsWith('OFFICIAL:') && source.endsWith(':ALL')) {
    const parts = source.split(':');
    if (parts.length === 3 && parts[1] && parts[1] !== 'OVERALL') {
      return { category: parts[1], timePeriod: 'ALL' };
    }
  }
  if (source === DISCOVERY_WEEK_SOURCE) return { category: 'OVERALL', timePeriod: 'WEEK' };
  if (source === DISCOVERY_ALL_SOURCE) return { category: 'OVERALL', timePeriod: 'ALL' };
  return null;
}

export async function getDiscoveryCursor(source: string): Promise<{
  cursor: string;
  syncVersion: number | null;
  meta: Record<string, unknown> | null;
}> {
  const row = await prisma.smartMoneyDiscoveryCursor.findUnique({ where: { source } });
  if (!row) {
    return { cursor: '0', syncVersion: null, meta: null };
  }
  const meta =
    row.meta != null && typeof row.meta === 'object' && !Array.isArray(row.meta)
      ? (row.meta as Record<string, unknown>)
      : null;
  return { cursor: row.cursor, syncVersion: row.syncVersion, meta };
}

export async function upsertDiscoveryCursor(input: {
  source: string;
  cursor: string;
  syncVersion?: number | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  await prisma.smartMoneyDiscoveryCursor.upsert({
    where: { source: input.source },
    create: {
      source: input.source,
      cursor: input.cursor,
      syncVersion: input.syncVersion ?? null,
      meta: (input.meta ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    update: {
      cursor: input.cursor,
      ...(input.syncVersion !== undefined ? { syncVersion: input.syncVersion } : {}),
      ...(input.meta !== undefined
        ? { meta: (input.meta ?? Prisma.JsonNull) as Prisma.InputJsonValue }
        : {}),
    },
  });
}

export async function getShortfallStreak(): Promise<number> {
  const row = await getDiscoveryCursor(DISCOVERY_SHORTFALL);
  const n = row.meta && typeof row.meta.streak === 'number' ? row.meta.streak : 0;
  return Math.max(0, Math.floor(n));
}

export async function bumpShortfallStreak(shortfall: number): Promise<number> {
  const prev = await getShortfallStreak();
  const next = shortfall > 0 ? prev + 1 : 0;
  await upsertDiscoveryCursor({
    source: DISCOVERY_SHORTFALL,
    cursor: String(next),
    meta: { streak: next, shortfall, updatedAt: new Date().toISOString() },
  });
  return next;
}

export function cursorStepForShortfall(streak: number, baseStep: number): number {
  if (streak < CONFIG.smartMoneyRawRefillShortfallBoostAfter) return baseStep;
  return Math.max(1, Math.floor(baseStep * CONFIG.smartMoneyRawRefillShortfallStepMul));
}

/**
 * 榜 sync 后：WEEK syncVersion/日切重置游标；构建日榜增量优先队列（含名次跳升）。
 */
export async function refreshDiscoveryAfterLeaderboardSync(options?: {
  weekSyncVersion?: number | null;
  allSyncVersion?: number | null;
}): Promise<{ priorityCount: number; weekReset: boolean; rankJumps: number }> {
  const topN = CONFIG.smartMoneyDiscoveryReviveTopN;
  const jumpMin = CONFIG.smartMoneyDiscoveryRankJumpMin;
  const weekCursor = await getDiscoveryCursor(DISCOVERY_WEEK_SOURCE);
  const weekVersion = options?.weekSyncVersion ?? weekCursor.syncVersion;
  const dayKey = utcDayKey();
  const prevDay =
    weekCursor.meta && typeof weekCursor.meta.dayKey === 'string'
      ? weekCursor.meta.dayKey
      : null;
  const versionChanged =
    weekVersion != null && weekCursor.syncVersion != null && weekVersion !== weekCursor.syncVersion;
  const dayChanged = prevDay != null && prevDay !== dayKey;
  const weekReset = weekCursor.syncVersion == null || versionChanged || dayChanged;

  if (weekReset) {
    await upsertDiscoveryCursor({
      source: DISCOVERY_WEEK_SOURCE,
      cursor: '0',
      syncVersion: weekVersion,
      meta: { dayKey },
    });
  } else if (weekVersion != null) {
    await upsertDiscoveryCursor({
      source: DISCOVERY_WEEK_SOURCE,
      cursor: weekCursor.cursor,
      syncVersion: weekVersion,
      meta: { ...(weekCursor.meta ?? {}), dayKey },
    });
  }

  if (options?.allSyncVersion != null) {
    const allCursor = await getDiscoveryCursor(DISCOVERY_ALL_SOURCE);
    await upsertDiscoveryCursor({
      source: DISCOVERY_ALL_SOURCE,
      cursor: allCursor.cursor,
      syncVersion: options.allSyncVersion,
      meta: allCursor.meta,
    });
  }

  // 分类 ALL 游标：仅刷新 syncVersion，跨天保留 cursor
  for (const source of OFFICIAL_CATEGORY_ALL_SOURCES) {
    const cur = await getDiscoveryCursor(source);
    await upsertDiscoveryCursor({
      source,
      cursor: cur.cursor,
      syncVersion: options?.allSyncVersion ?? cur.syncVersion,
      meta: cur.meta,
    });
  }

  const weekRows = await prisma.leaderboardRow.findMany({
    where: {
      category: 'OVERALL',
      timePeriod: 'WEEK',
      orderBy: 'PNL',
      rank: { lte: Math.max(topN, 200) },
    },
    orderBy: [{ syncVersion: 'desc' }, { rank: 'asc' }],
    take: Math.max(topN, 200) * 3,
    select: { proxyWallet: true, rank: true, syncVersion: true },
  });
  const maxVersion = weekRows.reduce((m, r) => Math.max(m, r.syncVersion), 0);
  const latestAll = weekRows.filter((r) => r.syncVersion === maxVersion);
  const latestTop = latestAll.slice(0, topN);

  const prevSnap = await getDiscoveryCursor(DISCOVERY_RANK_SNAPSHOT);
  const prevRanks =
    prevSnap.meta &&
    prevSnap.meta.ranks &&
    typeof prevSnap.meta.ranks === 'object' &&
    !Array.isArray(prevSnap.meta.ranks)
      ? (prevSnap.meta.ranks as Record<string, number>)
      : {};

  const entries: PriorityEntry[] = [];
  const seen = new Set<string>();
  const pushEntry = (wallet: string, reason: PriorityEntry['reason']) => {
    if (seen.has(wallet)) return;
    seen.add(wallet);
    entries.push({ wallet, reason });
  };

  for (const row of latestTop) {
    const wallet = row.proxyWallet.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) continue;
    const prev = prevRanks[wallet];
    if (prev == null) {
      pushEntry(wallet, 'REVIVE|OFFICIAL_TOP');
    } else if (prev - row.rank >= jumpMin) {
      pushEntry(wallet, 'REVIVE|RANK_JUMP');
    } else if (row.rank <= topN) {
      // 仍在 TopN：仅当管道中无记录时作为 NEW 优先
      pushEntry(wallet, 'NEW');
    }
  }

  // 名次跳升也可能发生在 TopN 外但进入可观测带
  for (const row of latestAll) {
    const wallet = row.proxyWallet.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) continue;
    const prev = prevRanks[wallet];
    if (prev != null && prev - row.rank >= jumpMin) {
      pushEntry(wallet, 'REVIVE|RANK_JUMP');
    }
  }

  const wallets = entries.map((e) => e.wallet);
  const existing = wallets.length
    ? await prisma.smartMoneyRawAddress.findMany({
        where: { wallet: { in: wallets } },
        select: { wallet: true, pipelineStage: true },
      })
    : [];
  const byWallet = new Map(existing.map((r) => [r.wallet, r]));
  const busy = new Set([
    'COPY_POOL',
    'SCORED',
    'QUALIFIED',
    'LIGHT_ANALYZING',
    'FULL_ANALYZING',
    'RAW',
    'BLOCKED',
  ]);

  const filtered: PriorityEntry[] = [];
  for (const entry of entries) {
    const row = byWallet.get(entry.wallet);
    if (!row) {
      filtered.push(entry);
      continue;
    }
    if (busy.has(row.pipelineStage)) continue;
    if (
      row.pipelineStage === 'ELIMINATED' ||
      row.pipelineStage === 'DORMANT' ||
      entry.reason === 'REVIVE|RANK_JUMP' ||
      entry.reason === 'REVIVE|OFFICIAL_TOP'
    ) {
      filtered.push(entry);
    }
  }

  const rankJumps = filtered.filter((e) => e.reason === 'REVIVE|RANK_JUMP').length;

  await upsertDiscoveryCursor({
    source: DISCOVERY_PRIORITY_SOURCE,
    cursor: '0',
    syncVersion: maxVersion || weekVersion || null,
    meta: {
      wallets: filtered.map((e) => e.wallet),
      entries: filtered,
      builtAt: new Date().toISOString(),
      syncVersion: maxVersion || weekVersion || null,
    } satisfies PriorityMeta,
  });

  // 保存本轮 rank 快照供下次跳升比较
  const nextRanks: Record<string, number> = {};
  for (const row of latestAll) {
    const wallet = row.proxyWallet.trim().toLowerCase();
    if (/^0x[a-f0-9]{40}$/.test(wallet)) nextRanks[wallet] = row.rank;
  }
  await upsertDiscoveryCursor({
    source: DISCOVERY_RANK_SNAPSHOT,
    cursor: '0',
    syncVersion: maxVersion || weekVersion || null,
    meta: { ranks: nextRanks, syncVersion: maxVersion || weekVersion || null } satisfies RankSnapshotMeta,
  });

  return { priorityCount: filtered.length, weekReset, rankJumps };
}

export async function consumePriorityQueue(
  limit: number
): Promise<Array<{ wallet: string; reason: string }>> {
  if (limit <= 0) return [];
  const row = await getDiscoveryCursor(DISCOVERY_PRIORITY_SOURCE);
  const meta = (row.meta ?? {}) as PriorityMeta;
  const entries: PriorityEntry[] =
    Array.isArray(meta.entries) && meta.entries.length > 0
      ? meta.entries
      : (Array.isArray(meta.wallets) ? meta.wallets : []).map((wallet) => ({
          wallet,
          reason: 'NEW' as const,
        }));
  if (entries.length === 0) return [];
  const taken = entries.slice(0, limit);
  const rest = entries.slice(limit);
  await upsertDiscoveryCursor({
    source: DISCOVERY_PRIORITY_SOURCE,
    cursor: String(Number(row.cursor || '0') + taken.length),
    syncVersion: row.syncVersion,
    meta: {
      ...meta,
      wallets: rest.map((e) => e.wallet),
      entries: rest,
    },
  });
  return taken.map((e) => ({ wallet: e.wallet, reason: e.reason }));
}

/**
 * 从官方榜 / 第三方缓存按游标下探取一段候选（只读缓存）。
 */
export async function takeBoardCursorSlice(options: {
  source: string;
  step: number;
}): Promise<string[]> {
  const { source, step } = options;
  if (step <= 0) return [];

  const official = parseCategorySource(source);
  if (official) {
    const state = await getDiscoveryCursor(source);
    const offset = Math.max(0, Number.parseInt(state.cursor || '0', 10) || 0);
    const latest = await prisma.leaderboardRow.findFirst({
      where: {
        category: official.category,
        timePeriod: official.timePeriod,
        orderBy: 'PNL',
      },
      orderBy: { syncVersion: 'desc' },
      select: { syncVersion: true, batchId: true },
    });
    if (!latest) return [];
    const rows = await prisma.leaderboardRow.findMany({
      where: {
        category: official.category,
        timePeriod: official.timePeriod,
        orderBy: 'PNL',
        syncVersion: latest.syncVersion,
        batchId: latest.batchId,
        rank: { gt: offset, lte: offset + step },
      },
      orderBy: { rank: 'asc' },
      select: { proxyWallet: true, rank: true },
    });
    // F1：空切回绕到 0，禁止 offset+step 空推进冲飞游标
    const nextCursor =
      rows.length > 0 ? String(rows[rows.length - 1]!.rank) : '0';
    if (rows.length === 0 && offset > 0) {
      console.info('[smart-money-discovery] cursor wrap', {
        source,
        previousCursor: offset,
        action: 'wrap',
      });
    }
    await upsertDiscoveryCursor({
      source,
      cursor: nextCursor,
      syncVersion: latest.syncVersion,
      meta: state.meta,
    });
    return [
      ...new Set(
        rows
          .map((r) => r.proxyWallet.trim().toLowerCase())
          .filter((w) => /^0x[a-f0-9]{40}$/.test(w))
      ),
    ];
  }

  if (source === DISCOVERY_PREDICTING_ALL) {
    return takeExternalCursorSlice({
      source,
      step,
      table: 'predicting',
    });
  }
  if (source === DISCOVERY_ANALYTICS_30D) {
    return takeExternalCursorSlice({
      source,
      step,
      table: 'analytics',
    });
  }
  return [];
}

async function takeExternalCursorSlice(options: {
  source: string;
  step: number;
  table: 'predicting' | 'analytics';
}): Promise<string[]> {
  const state = await getDiscoveryCursor(options.source);
  const offset = Math.max(0, Number.parseInt(state.cursor || '0', 10) || 0);
  if (options.table === 'predicting') {
    const latest = await prisma.predictingTopLeaderboardRow.findFirst({
      where: { period: 'ALL' },
      orderBy: { syncVersion: 'desc' },
      select: { syncVersion: true },
    });
    if (!latest) return [];
    const rows = await prisma.predictingTopLeaderboardRow.findMany({
      where: {
        period: 'ALL',
        syncVersion: latest.syncVersion,
        rank: { gt: offset, lte: offset + options.step },
      },
      orderBy: { rank: 'asc' },
      select: { wallet: true, rank: true },
    });
    // F1：空切回绕到 0
    const next = rows.length > 0 ? String(rows[rows.length - 1]!.rank) : '0';
    if (rows.length === 0 && offset > 0) {
      console.info('[smart-money-discovery] cursor wrap', {
        source: options.source,
        previousCursor: offset,
        action: 'wrap',
      });
    }
    await upsertDiscoveryCursor({
      source: options.source,
      cursor: next,
      syncVersion: latest.syncVersion,
      meta: state.meta,
    });
    return [
      ...new Set(
        rows.map((r) => r.wallet.trim().toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w))
      ),
    ];
  }

  const latest = await prisma.polymarketAnalyticsLeaderboardRow.findFirst({
    where: { period: '30D' },
    orderBy: { syncVersion: 'desc' },
    select: { syncVersion: true },
  });
  if (!latest) return [];
  const rows = await prisma.polymarketAnalyticsLeaderboardRow.findMany({
    where: {
      period: '30D',
      syncVersion: latest.syncVersion,
      rank: { gt: offset, lte: offset + options.step },
    },
    orderBy: { rank: 'asc' },
    select: { wallet: true, rank: true },
  });
  // F1：空切回绕到 0
  const next = rows.length > 0 ? String(rows[rows.length - 1]!.rank) : '0';
  if (rows.length === 0 && offset > 0) {
    console.info('[smart-money-discovery] cursor wrap', {
      source: options.source,
      previousCursor: offset,
      action: 'wrap',
    });
  }
  await upsertDiscoveryCursor({
    source: options.source,
    cursor: next,
    syncVersion: latest.syncVersion,
    meta: state.meta,
  });
  return [
    ...new Set(
      rows.map((r) => r.wallet.trim().toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w))
    ),
  ];
}

/** 榜缓存是否 stale（补池只读路径用） */
export async function isOfficialLeaderboardCacheStale(
  staleMs = CONFIG.smartMoneyRawRefillCacheStaleMs
): Promise<boolean> {
  const latest = await prisma.leaderboardRow.findFirst({
    orderBy: { syncedAt: 'desc' },
    select: { syncedAt: true },
  });
  if (!latest?.syncedAt) return true;
  return Date.now() - latest.syncedAt.getTime() > staleMs;
}
