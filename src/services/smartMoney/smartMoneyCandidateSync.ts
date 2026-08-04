import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  listLatestOfficialLeaderboardCategoryCandidateRows,
  listLatestOfficialLeaderboardCandidateRows,
  OFFICIAL_LEADERBOARD_CATEGORIES,
  OFFICIAL_LEADERBOARD_PERIODS,
} from '../polymarket/leaderboardCache';
import {
  syncSmartMoneyLeaderboardActiveCandidateFlags,
  syncSmartMoneyLeaderboardCandidateMetadata,
} from './smartMoneyActiveCandidate';
import { computeDiscoveryIngestBudget } from './smartMoneyDiscoveryBudget.js';
import { ingestSmartMoneyRawAddresses } from './smartMoneyRawIngest.js';
import { bumpBoardBacklogLightQueue } from './smartMoneyBoardBootstrap.js';
import { rawPoolActiveWhere } from './smartMoneyRawPoolActive.js';
import { canAttemptStrongRevive } from './smartMoneyEliminated.js';

const SMART_MONEY_SOURCE_PERIODS = OFFICIAL_LEADERBOARD_PERIODS;
const EXTERNAL_PERIOD_MAP = {
  '7D': 'WEEK',
  '30D': 'MONTH',
  ALL: 'ALL',
} as const;

const ANALYTICS_PERIOD_MAP = EXTERNAL_PERIOD_MAP;

type SmartMoneySourcePeriod = (typeof SMART_MONEY_SOURCE_PERIODS)[number];
type SmartMoneySourceCategory = (typeof OFFICIAL_LEADERBOARD_CATEGORIES)[number];
type CandidateSource = 'OFFICIAL' | 'EXTERNAL';

type CandidateAccumulator = {
  wallet: string;
  sourceRankWeek: number | null;
  sourceRankMonth: number | null;
  sourceRankAll: number | null;
  officialSourceRankWeek: number | null;
  officialSourceRankMonth: number | null;
  officialSourceRankAll: number | null;
  externalSourceRankWeek: number | null;
  externalSourceRankMonth: number | null;
  externalSourceRankAll: number | null;
  candidatePeriods: SmartMoneySourcePeriod[];
  candidateCategories: SmartMoneySourceCategory[];
};

type CandidateSourceRow = {
  proxyWallet: string;
  timePeriod: SmartMoneySourcePeriod;
  rank: number;
  source: CandidateSource;
  category: SmartMoneySourceCategory;
};

export type SmartMoneyCandidateSyncStats = {
  mode: 'watermark' | 'full';
  fetchedRows: number;
  uniqueWallets: number;
  createdCount: number;
  updatedCount: number;
  deactivatedCount: number;
  blacklistedCount: number;
  candidateSourceVersion: number;
  ingestedRaw: number;
  reactivatedRaw: number;
  metadataRefreshed: number;
  discoveryPaused: boolean;
  discoverySlots: number;
  activeRawCount: number;
  elapsedMs: number;
};

let syncRunning = false;

function normalizeWallet(wallet: string): string | null {
  const normalized = wallet.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function pushCandidatePeriod(periods: SmartMoneySourcePeriod[], period: SmartMoneySourcePeriod): void {
  if (!periods.includes(period)) {
    periods.push(period);
  }
}

function pushCandidateCategory(
  categories: SmartMoneySourceCategory[],
  category: SmartMoneySourceCategory
): void {
  if (!categories.includes(category)) {
    categories.push(category);
  }
}

function assignRank(
  candidate: CandidateAccumulator,
  source: CandidateSource,
  period: SmartMoneySourcePeriod,
  rank: number
): void {
  const assign = (key: 'WEEK' | 'MONTH' | 'ALL', value: number) => {
    if (key === 'WEEK') {
      if (source === 'OFFICIAL') {
        candidate.officialSourceRankWeek =
          candidate.officialSourceRankWeek == null
            ? value
            : Math.min(candidate.officialSourceRankWeek, value);
      } else {
        candidate.externalSourceRankWeek =
          candidate.externalSourceRankWeek == null
            ? value
            : Math.min(candidate.externalSourceRankWeek, value);
      }
      return;
    }
    if (key === 'MONTH') {
      if (source === 'OFFICIAL') {
        candidate.officialSourceRankMonth =
          candidate.officialSourceRankMonth == null
            ? value
            : Math.min(candidate.officialSourceRankMonth, value);
      } else {
        candidate.externalSourceRankMonth =
          candidate.externalSourceRankMonth == null
            ? value
            : Math.min(candidate.externalSourceRankMonth, value);
      }
      return;
    }
    if (source === 'OFFICIAL') {
      candidate.officialSourceRankAll =
        candidate.officialSourceRankAll == null ? value : Math.min(candidate.officialSourceRankAll, value);
    } else {
      candidate.externalSourceRankAll =
        candidate.externalSourceRankAll == null ? value : Math.min(candidate.externalSourceRankAll, value);
    }
  };

  assign(period, rank);

  if (period === 'WEEK') {
    candidate.sourceRankWeek =
      candidate.sourceRankWeek == null ? rank : Math.min(candidate.sourceRankWeek, rank);
    return;
  }
  if (period === 'MONTH') {
    candidate.sourceRankMonth =
      candidate.sourceRankMonth == null ? rank : Math.min(candidate.sourceRankMonth, rank);
    return;
  }
  candidate.sourceRankAll = candidate.sourceRankAll == null ? rank : Math.min(candidate.sourceRankAll, rank);
}

function getBestRank(candidate: CandidateAccumulator): number {
  return Math.min(
    candidate.officialSourceRankWeek ?? Number.MAX_SAFE_INTEGER,
    candidate.officialSourceRankMonth ?? Number.MAX_SAFE_INTEGER,
    candidate.officialSourceRankAll ?? Number.MAX_SAFE_INTEGER,
    candidate.externalSourceRankWeek ?? Number.MAX_SAFE_INTEGER,
    candidate.externalSourceRankMonth ?? Number.MAX_SAFE_INTEGER,
    candidate.externalSourceRankAll ?? Number.MAX_SAFE_INTEGER
  );
}

function mergeLeaderboardRows(rows: CandidateSourceRow[]): CandidateAccumulator[] {
  const byWallet = new Map<string, CandidateAccumulator>();
  for (const row of rows) {
    const wallet = normalizeWallet(row.proxyWallet);
    if (!wallet) continue;
    if (!SMART_MONEY_SOURCE_PERIODS.includes(row.timePeriod)) continue;
    const existing = byWallet.get(wallet) ?? {
      wallet,
      sourceRankWeek: null,
      sourceRankMonth: null,
      sourceRankAll: null,
      officialSourceRankWeek: null,
      officialSourceRankMonth: null,
      officialSourceRankAll: null,
      externalSourceRankWeek: null,
      externalSourceRankMonth: null,
      externalSourceRankAll: null,
      candidatePeriods: [],
      candidateCategories: [],
    };
    if (row.category === 'OVERALL') {
      assignRank(existing, row.source, row.timePeriod, row.rank);
    }
    pushCandidatePeriod(existing.candidatePeriods, row.timePeriod);
    pushCandidateCategory(existing.candidateCategories, row.category);
    byWallet.set(wallet, existing);
  }

  return [...byWallet.values()].sort((a, b) => {
    const leftBest = getBestRank(a);
    const rightBest = getBestRank(b);
    if (leftBest !== rightBest) return leftBest - rightBest;
    return a.wallet.localeCompare(b.wallet);
  });
}

async function fetchLatestPredictingTopCandidateRows(): Promise<CandidateSourceRow[]> {
  const versionRows = await prisma.predictingTopLeaderboardRow.groupBy({
    by: ['period'],
    _max: { syncVersion: true },
  });
  if (versionRows.length === 0) {
    return [];
  }

  const latestRows = await prisma.predictingTopLeaderboardRow.findMany({
    where: {
      OR: versionRows
        .filter(
          (row): row is typeof row & { _max: { syncVersion: number } } => row._max.syncVersion != null
        )
        .map((row) => ({
          period: row.period,
          syncVersion: row._max.syncVersion,
        })),
    },
    select: {
      wallet: true,
      period: true,
      rank: true,
    },
    orderBy: [{ period: 'asc' }, { rank: 'asc' }],
  });

  const mappedRows: Array<CandidateSourceRow | null> = latestRows.map((row) => {
    const mappedPeriod = EXTERNAL_PERIOD_MAP[row.period as keyof typeof EXTERNAL_PERIOD_MAP];
    if (!mappedPeriod) return null;
    return {
      proxyWallet: row.wallet,
      timePeriod: mappedPeriod,
      rank: row.rank,
      category: 'OVERALL',
      source: 'EXTERNAL',
    };
  });

  return mappedRows.filter((row): row is CandidateSourceRow => row != null);
}

async function fetchLatestAnalyticsCandidateRows(): Promise<CandidateSourceRow[]> {
  const versionRows = await prisma.polymarketAnalyticsLeaderboardRow.groupBy({
    by: ['period'],
    _max: { syncVersion: true },
  });
  if (versionRows.length === 0) {
    return [];
  }

  const latestRows = await prisma.polymarketAnalyticsLeaderboardRow.findMany({
    where: {
      OR: versionRows
        .filter(
          (row): row is typeof row & { _max: { syncVersion: number } } => row._max.syncVersion != null
        )
        .map((row) => ({
          period: row.period,
          syncVersion: row._max.syncVersion,
        })),
    },
    select: {
      wallet: true,
      period: true,
      rank: true,
    },
    orderBy: [{ period: 'asc' }, { rank: 'asc' }],
  });

  const mappedRows: Array<CandidateSourceRow | null> = latestRows.map((row) => {
    const mappedPeriod = ANALYTICS_PERIOD_MAP[row.period as keyof typeof ANALYTICS_PERIOD_MAP];
    if (!mappedPeriod) return null;
    return {
      proxyWallet: row.wallet,
      timePeriod: mappedPeriod,
      rank: row.rank,
      category: 'OVERALL',
      source: 'EXTERNAL',
    };
  });

  return mappedRows.filter((row): row is CandidateSourceRow => row != null);
}

async function fetchLatestExternalCandidateRows(): Promise<CandidateSourceRow[]> {
  const [predictingTopRows, analyticsRows] = await Promise.all([
    fetchLatestPredictingTopCandidateRows(),
    fetchLatestAnalyticsCandidateRows(),
  ]);
  return [...predictingTopRows, ...analyticsRows];
}

async function getNextCandidateSourceVersion(): Promise<number> {
  const aggregate = await prisma.observedTrader.aggregate({
    _max: { candidateSourceVersion: true },
  });
  return (aggregate._max.candidateSourceVersion ?? 0) + 1;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('candidate sync aborted');
    err.name = 'AbortError';
    throw err;
  }
}

async function loadMergedCandidates(signal?: AbortSignal): Promise<{
  rows: CandidateSourceRow[];
  candidates: CandidateAccumulator[];
  byWallet: Map<string, CandidateAccumulator>;
}> {
  throwIfAborted(signal);
  const [officialRows, officialCategoryRows, externalRows] = await Promise.all([
    listLatestOfficialLeaderboardCandidateRows().then((result) => result.rows),
    listLatestOfficialLeaderboardCategoryCandidateRows().then((result) => result.rows),
    fetchLatestExternalCandidateRows(),
  ]);
  throwIfAborted(signal);

  const officialSourceRows: CandidateSourceRow[] = officialRows.map((row) => ({
    proxyWallet: row.proxyWallet,
    timePeriod: row.timePeriod as SmartMoneySourcePeriod,
    rank: row.rank,
    category: 'OVERALL',
    source: 'OFFICIAL',
  }));
  const officialCategorySourceRows: CandidateSourceRow[] = officialCategoryRows.map((row) => ({
    proxyWallet: row.proxyWallet,
    timePeriod: row.timePeriod as SmartMoneySourcePeriod,
    rank: row.category === 'OVERALL' ? row.rank : Number.MAX_SAFE_INTEGER,
    category: row.category,
    source: 'OFFICIAL',
  }));
  const rows = [...officialSourceRows, ...officialCategorySourceRows, ...externalRows];
  const candidates = mergeLeaderboardRows(rows);
  const byWallet = new Map(candidates.map((c) => [c.wallet, c]));
  return { rows, candidates, byWallet };
}

async function countActiveRawPool(): Promise<number> {
  return prisma.smartMoneyRawAddress.count({ where: rawPoolActiveWhere });
}

/**
 * 线 A：按 bestRank 优先，只挑选可进 RAW 的新鲜地址（去重/冷却/管道忙跳过）。
 */
async function pickDiscoveryIngestWallets(
  candidates: CandidateAccumulator[],
  slots: number,
  signal?: AbortSignal
): Promise<string[]> {
  if (slots <= 0) return [];

  const picked: string[] = [];
  const LOOKUP_CHUNK = 400;
  const scanCap = Math.min(candidates.length, Math.max(slots * 50, 10_000));
  const cooldownMs = CONFIG.smartMoneyRawIngestCooldownDays * 24 * 60 * 60 * 1000;
  const cooldownCutoff = new Date(Date.now() - cooldownMs);
  const busyStages = new Set([
    'COPY_POOL',
    'SCORED',
    'QUALIFIED',
    'LIGHT_ANALYZING',
    'FULL_ANALYZING',
    'RAW',
    'DORMANT',
  ]);

  for (let i = 0; i < scanCap && picked.length < slots; i += LOOKUP_CHUNK) {
    throwIfAborted(signal);
    const chunk = candidates.slice(i, Math.min(i + LOOKUP_CHUNK, scanCap));
    const existing = await prisma.smartMoneyRawAddress.findMany({
      where: { wallet: { in: chunk.map((c) => c.wallet) } },
      select: {
        wallet: true,
        pipelineStage: true,
        dormant: true,
        lastIngestedAt: true,
        updatedAt: true,
        elimFrozenUntil: true,
        tierFailReason: true,
      },
    });
    const byWallet = new Map(existing.map((row) => [row.wallet, row]));

    for (const candidate of chunk) {
      if (picked.length >= slots) break;
      const row = byWallet.get(candidate.wallet);
      if (!row) {
        picked.push(candidate.wallet);
        continue;
      }
      if (row.dormant && (row.pipelineStage === 'RAW' || row.pipelineStage === 'DORMANT')) {
        picked.push(candidate.wallet);
        continue;
      }
      if (busyStages.has(row.pipelineStage) && row.pipelineStage !== 'ELIMINATED') {
        continue;
      }
      if (
        cooldownMs > 0 &&
        row.lastIngestedAt != null &&
        row.lastIngestedAt > cooldownCutoff &&
        row.pipelineStage !== 'ELIMINATED'
      ) {
        continue;
      }
      // 淘汰池交给 ingest 强信号复活
      if (
        row.pipelineStage === 'ELIMINATED' &&
        canAttemptStrongRevive({
          source: 'LEADERBOARD_SYNC',
          updatedAt: row.updatedAt,
          elimFrozenUntil: row.elimFrozenUntil,
          tierFailReason: row.tierFailReason,
        })
      ) {
        picked.push(candidate.wallet);
      }
    }
  }

  return picked;
}

async function upsertObservedTraderRanks(options: {
  candidate: CandidateAccumulator;
  syncedAt: Date;
  candidateSourceVersion: number;
  walletBlacklist: Set<string>;
  tagBlacklist: Set<string>;
}): Promise<'created' | 'updated' | 'blacklisted'> {
  const { candidate, syncedAt, candidateSourceVersion, walletBlacklist, tagBlacklist } = options;
  const existing = await prisma.observedTrader.findUnique({
    where: { wallet: candidate.wallet },
    select: {
      wallet: true,
      profileSlug: true,
      enabled: true,
      blacklisted: true,
      noiseTags: true,
    },
  });

  const noiseTags = [...new Set(existing?.noiseTags ?? [])];
  const blacklistedByTag = noiseTags.some((tag) => tagBlacklist.has(tag));
  const blacklisted =
    Boolean(existing?.blacklisted) || walletBlacklist.has(candidate.wallet) || blacklistedByTag;

  await prisma.observedTrader.upsert({
    where: { wallet: candidate.wallet },
    create: {
      wallet: candidate.wallet,
      profileSlug: existing?.profileSlug ?? null,
      sourceRankWeek: candidate.sourceRankWeek,
      sourceRankMonth: candidate.sourceRankMonth,
      sourceRankAll: candidate.sourceRankAll,
      officialSourceRankWeek: candidate.officialSourceRankWeek,
      officialSourceRankMonth: candidate.officialSourceRankMonth,
      officialSourceRankAll: candidate.officialSourceRankAll,
      externalSourceRankWeek: candidate.externalSourceRankWeek,
      externalSourceRankMonth: candidate.externalSourceRankMonth,
      externalSourceRankAll: candidate.externalSourceRankAll,
      candidatePeriods: candidate.candidatePeriods,
      candidateCategories: candidate.candidateCategories,
      candidateActive: true,
      candidateSourceVersion,
      candidateLastSeenAt: syncedAt,
      enabled: existing?.enabled ?? true,
      blacklisted,
      noiseTags,
      lastSeenAt: syncedAt,
      lastFetchStatus: existing ? 'CANDIDATE_REFRESHED' : 'NEW_CANDIDATE',
    },
    update: {
      sourceRankWeek: candidate.sourceRankWeek,
      sourceRankMonth: candidate.sourceRankMonth,
      sourceRankAll: candidate.sourceRankAll,
      officialSourceRankWeek: candidate.officialSourceRankWeek,
      officialSourceRankMonth: candidate.officialSourceRankMonth,
      officialSourceRankAll: candidate.officialSourceRankAll,
      externalSourceRankWeek: candidate.externalSourceRankWeek,
      externalSourceRankMonth: candidate.externalSourceRankMonth,
      externalSourceRankAll: candidate.externalSourceRankAll,
      candidatePeriods: candidate.candidatePeriods,
      candidateCategories: candidate.candidateCategories,
      candidateActive: true,
      candidateSourceVersion,
      candidateLastSeenAt: syncedAt,
      blacklisted,
      noiseTags,
      lastSeenAt: syncedAt,
      lastFetchStatus: 'CANDIDATE_REFRESHED',
    },
  });

  if (blacklisted) return 'blacklisted';
  return existing ? 'updated' : 'created';
}

/**
 * 线 B：只刷新已在 QUALIFIED / SCORED / CopyPool 的钱包元数据（单条短 upsert）。
 */
async function refreshActivePipelineMetadata(options: {
  byWallet: Map<string, CandidateAccumulator>;
  syncedAt: Date;
  candidateSourceVersion: number;
  signal?: AbortSignal;
}): Promise<{ createdCount: number; updatedCount: number; blacklistedCount: number; refreshed: number }> {
  const max = CONFIG.smartMoneyCandidateMetadataRefreshMax;
  if (max <= 0) {
    return { createdCount: 0, updatedCount: 0, blacklistedCount: 0, refreshed: 0 };
  }

  const [qualifiedOrScored, copyPool] = await Promise.all([
    prisma.smartMoneyRawAddress.findMany({
      where: {
        dormant: false,
        pipelineStage: { in: ['QUALIFIED', 'SCORED'] },
      },
      select: { wallet: true },
      take: max,
      orderBy: { lastSeenAt: 'desc' },
    }),
    prisma.smartMoneyLeaderboardRow.findMany({
      where: { inCopyPool: true },
      select: { wallet: true },
      take: max,
      orderBy: { rank: 'asc' },
    }),
  ]);

  const walletSet = new Set<string>();
  for (const row of [...copyPool, ...qualifiedOrScored]) {
    walletSet.add(row.wallet);
    if (walletSet.size >= max) break;
  }

  const walletBlacklist = new Set(CONFIG.smartMoneyBlacklistWallets);
  const tagBlacklist = new Set(CONFIG.smartMoneyBlacklistTags);

  let createdCount = 0;
  let updatedCount = 0;
  let blacklistedCount = 0;
  let refreshed = 0;

  for (const wallet of walletSet) {
    throwIfAborted(options.signal);
    const candidate = options.byWallet.get(wallet);
    if (!candidate) continue;

    const result = await upsertObservedTraderRanks({
      candidate,
      syncedAt: options.syncedAt,
      candidateSourceVersion: options.candidateSourceVersion,
      walletBlacklist,
      tagBlacklist,
    });
    refreshed += 1;
    if (result === 'created') createdCount += 1;
    else if (result === 'updated') updatedCount += 1;
    else blacklistedCount += 1;
  }

  return { createdCount, updatedCount, blacklistedCount, refreshed };
}

/** 遗留全量路径（默认关闭）：仅 SMART_MONEY_CANDIDATE_FULL_UPSERT=true 时使用。 */
async function runFullObservedTraderUpsert(options: {
  candidates: CandidateAccumulator[];
  syncedAt: Date;
  candidateSourceVersion: number;
  signal?: AbortSignal;
}): Promise<{
  createdCount: number;
  updatedCount: number;
  deactivatedCount: number;
  blacklistedCount: number;
}> {
  const { candidates, syncedAt, candidateSourceVersion, signal } = options;
  const walletBlacklist = new Set(CONFIG.smartMoneyBlacklistWallets);
  const tagBlacklist = new Set(CONFIG.smartMoneyBlacklistTags);
  const UPSERT_BATCH_SIZE = 10;
  const TX_TIMEOUT_MS = 60_000;

  const wallets = candidates.map((candidate) => candidate.wallet);
  const existingTraders =
    wallets.length > 0
      ? await prisma.observedTrader.findMany({
          where: { wallet: { in: wallets } },
          select: {
            wallet: true,
            profileSlug: true,
            enabled: true,
            blacklisted: true,
            noiseTags: true,
          },
        })
      : [];
  const existingByWallet = new Map(existingTraders.map((row) => [row.wallet, row]));

  let createdCount = 0;
  let updatedCount = 0;
  let blacklistedCount = 0;

  const upsertInputs = candidates.map((candidate) => {
    const existing = existingByWallet.get(candidate.wallet);
    const noiseTags = [...new Set(existing?.noiseTags ?? [])];
    const blacklistedByTag = noiseTags.some((tag) => tagBlacklist.has(tag));
    const blacklisted =
      Boolean(existing?.blacklisted) || walletBlacklist.has(candidate.wallet) || blacklistedByTag;

    if (blacklisted) blacklistedCount += 1;
    if (existing) updatedCount += 1;
    else createdCount += 1;

    return {
      wallet: candidate.wallet,
      existing,
      blacklisted,
      noiseTags,
      candidate,
    };
  });

  for (let i = 0; i < upsertInputs.length; i += UPSERT_BATCH_SIZE) {
    throwIfAborted(signal);
    const batch = upsertInputs.slice(i, i + UPSERT_BATCH_SIZE);
    await prisma.$transaction(
      async (tx) => {
        for (const row of batch) {
          await tx.observedTrader.upsert({
            where: { wallet: row.wallet },
            create: {
              wallet: row.wallet,
              profileSlug: row.existing?.profileSlug ?? null,
              sourceRankWeek: row.candidate.sourceRankWeek,
              sourceRankMonth: row.candidate.sourceRankMonth,
              sourceRankAll: row.candidate.sourceRankAll,
              officialSourceRankWeek: row.candidate.officialSourceRankWeek,
              officialSourceRankMonth: row.candidate.officialSourceRankMonth,
              officialSourceRankAll: row.candidate.officialSourceRankAll,
              externalSourceRankWeek: row.candidate.externalSourceRankWeek,
              externalSourceRankMonth: row.candidate.externalSourceRankMonth,
              externalSourceRankAll: row.candidate.externalSourceRankAll,
              candidatePeriods: row.candidate.candidatePeriods,
              candidateCategories: row.candidate.candidateCategories,
              candidateActive: true,
              candidateSourceVersion,
              candidateLastSeenAt: syncedAt,
              enabled: row.existing?.enabled ?? true,
              blacklisted: row.blacklisted,
              noiseTags: row.noiseTags,
              lastSeenAt: syncedAt,
              lastFetchStatus: row.existing ? 'CANDIDATE_REFRESHED' : 'NEW_CANDIDATE',
            },
            update: {
              sourceRankWeek: row.candidate.sourceRankWeek,
              sourceRankMonth: row.candidate.sourceRankMonth,
              sourceRankAll: row.candidate.sourceRankAll,
              officialSourceRankWeek: row.candidate.officialSourceRankWeek,
              officialSourceRankMonth: row.candidate.officialSourceRankMonth,
              officialSourceRankAll: row.candidate.officialSourceRankAll,
              externalSourceRankWeek: row.candidate.externalSourceRankWeek,
              externalSourceRankMonth: row.candidate.externalSourceRankMonth,
              externalSourceRankAll: row.candidate.externalSourceRankAll,
              candidatePeriods: row.candidate.candidatePeriods,
              candidateCategories: row.candidate.candidateCategories,
              candidateActive: true,
              candidateSourceVersion,
              candidateLastSeenAt: syncedAt,
              blacklisted: row.blacklisted,
              noiseTags: row.noiseTags,
              lastSeenAt: syncedAt,
              lastFetchStatus: 'CANDIDATE_REFRESHED',
            },
          });
        }
      },
      { timeout: TX_TIMEOUT_MS, maxWait: 15_000 }
    );
  }

  const deactivated = await prisma.observedTrader.updateMany({
    where: {
      candidateActive: true,
      candidateOrigin: 'LEADERBOARD',
      candidateSourceVersion: { lt: candidateSourceVersion },
    },
    data: {
      candidateActive: false,
      sourceRankWeek: null,
      sourceRankMonth: null,
      sourceRankAll: null,
      officialSourceRankWeek: null,
      officialSourceRankMonth: null,
      officialSourceRankAll: null,
      externalSourceRankWeek: null,
      externalSourceRankMonth: null,
      externalSourceRankAll: null,
      candidatePeriods: [],
      candidateCategories: [],
      lastFetchStatus: 'CANDIDATE_DROPPED',
      nextRetryAt: null,
    },
  });

  return {
    createdCount,
    updatedCount,
    deactivatedCount: deactivated.count,
    blacklistedCount,
  };
}

/**
 * 发现层同步（Phase E）：
 * - 默认：线 A 水位进货 + 线 B 活跃元数据短写
 * - 可选：SMART_MONEY_CANDIDATE_FULL_UPSERT=true 回退全量镜像（不推荐）
 */
export async function runSmartMoneyCandidateSync(options?: {
  signal?: AbortSignal;
}): Promise<SmartMoneyCandidateSyncStats | null> {
  if (syncRunning) {
    return null;
  }

  const signal = options?.signal;
  syncRunning = true;
  const startedAt = Date.now();
  const syncedAt = new Date();

  try {
    const { rows, candidates, byWallet } = await loadMergedCandidates(signal);
    const candidateSourceVersion = await getNextCandidateSourceVersion();
    const activeRawCount = await countActiveRawPool();

    let createdCount = 0;
    let updatedCount = 0;
    let deactivatedCount = 0;
    let blacklistedCount = 0;
    let ingestedRaw = 0;
    let reactivatedRaw = 0;
    let metadataRefreshed = 0;
    let discoveryPaused = false;
    let discoverySlots = 0;
    const mode: 'watermark' | 'full' = CONFIG.smartMoneyCandidateFullUpsert ? 'full' : 'watermark';

    if (mode === 'full') {
      const full = await runFullObservedTraderUpsert({
        candidates,
        syncedAt,
        candidateSourceVersion,
        signal,
      });
      createdCount = full.createdCount;
      updatedCount = full.updatedCount;
      deactivatedCount = full.deactivatedCount;
      blacklistedCount = full.blacklistedCount;

      throwIfAborted(signal);
      await syncSmartMoneyLeaderboardActiveCandidateFlags();
      throwIfAborted(signal);
      await syncSmartMoneyLeaderboardCandidateMetadata();

      throwIfAborted(signal);
      const ingest = await ingestSmartMoneyRawAddresses(
        candidates.map((candidate) => ({
          wallet: candidate.wallet,
          source: 'LEADERBOARD_SYNC',
        }))
      );
      ingestedRaw = ingest.ingested;
      reactivatedRaw = ingest.reactivated;
    } else {
      const budget = computeDiscoveryIngestBudget({
        activeCount: activeRawCount,
        maxActive: CONFIG.smartMoneyRawPoolMaxActive,
        watermark: CONFIG.smartMoneyDiscoveryRawWatermark,
        perRun: CONFIG.smartMoneyDiscoveryIngestPerRun,
        refillLow: CONFIG.smartMoneyRawRefillLow,
        refillTarget: CONFIG.smartMoneyRawRefillTarget,
      });
      discoveryPaused = budget.paused;
      discoverySlots = budget.slots;

      console.log('[smart-money-candidates] discovery budget', {
        activeRawCount,
        targetCap: budget.targetCap,
        slots: budget.slots,
        paused: budget.paused,
        perRun: CONFIG.smartMoneyDiscoveryIngestPerRun,
        refillLow: CONFIG.smartMoneyRawRefillLow,
        refillTarget: CONFIG.smartMoneyRawRefillTarget,
        refillCronOwnsIngest: CONFIG.smartMoneyRawRefillCronEnabled,
      });

      // 设计：独立 refill cron 负责进 RAW；candidateSync 只做元数据，避免双写/重复扫榜
      if (CONFIG.smartMoneyRawRefillCronEnabled) {
        discoveryPaused = true;
        discoverySlots = 0;
        console.log('[smart-money-candidates] skip discovery ingest (owned by raw-refill cron)');
      } else if (budget.slots > 0) {
        const toIngest = await pickDiscoveryIngestWallets(candidates, budget.slots, signal);
        throwIfAborted(signal);
        if (toIngest.length > 0) {
          const ingest = await ingestSmartMoneyRawAddresses(
            toIngest.map((wallet) => ({
              wallet,
              source: 'LEADERBOARD_SYNC',
            }))
          );
          ingestedRaw = ingest.ingested;
          reactivatedRaw = ingest.reactivated;
        }
      } else if (CONFIG.smartMoneyLeaderboardIngestReservedSlots > 0) {
        const reserved = CONFIG.smartMoneyLeaderboardIngestReservedSlots;
        const toIngest = await pickDiscoveryIngestWallets(candidates, reserved, signal);
        throwIfAborted(signal);
        if (toIngest.length > 0) {
          const ingest = await ingestSmartMoneyRawAddresses(
            toIngest.map((wallet) => ({
              wallet,
              source: 'LEADERBOARD_SYNC',
            })),
            { leaderboardReserved: true }
          );
          ingestedRaw = ingest.ingested;
          reactivatedRaw = ingest.reactivated;
          discoverySlots = reserved;
        }
      }

      if (!CONFIG.smartMoneyRawRefillCronEnabled) {
        console.log('[smart-money-candidates] discovery ingest', {
          picked: discoverySlots,
          ingestedRaw,
          reactivatedRaw,
          paused: discoveryPaused,
        });
      }
      throwIfAborted(signal);
      const meta = await refreshActivePipelineMetadata({
        byWallet,
        syncedAt,
        candidateSourceVersion,
        signal,
      });
      createdCount = meta.createdCount;
      updatedCount = meta.updatedCount;
      blacklistedCount = meta.blacklistedCount;
      metadataRefreshed = meta.refreshed;

      console.log('[smart-money-candidates] metadata refresh', {
        refreshed: metadataRefreshed,
        createdCount,
        updatedCount,
      });

      throwIfAborted(signal);
      await syncSmartMoneyLeaderboardActiveCandidateFlags();
      throwIfAborted(signal);
      await syncSmartMoneyLeaderboardCandidateMetadata();

      const bumped = await bumpBoardBacklogLightQueue();
      if (bumped > 0) {
        console.log('[smart-money-candidates] board backlog bump', { bumped });
      }
    }

    const stats: SmartMoneyCandidateSyncStats = {
      mode,
      fetchedRows: rows.length,
      uniqueWallets: candidates.length,
      createdCount,
      updatedCount,
      deactivatedCount,
      blacklistedCount,
      candidateSourceVersion,
      ingestedRaw,
      reactivatedRaw,
      metadataRefreshed,
      discoveryPaused,
      discoverySlots,
      activeRawCount,
      elapsedMs: Date.now() - startedAt,
    };

    console.log('[smart-money-candidates] sync finished', {
      mode: stats.mode,
      uniqueWallets: stats.uniqueWallets,
      ingestedRaw: stats.ingestedRaw,
      metadataRefreshed: stats.metadataRefreshed,
      discoveryPaused: stats.discoveryPaused,
      elapsedMs: stats.elapsedMs,
    });

    return stats;
  } finally {
    syncRunning = false;
  }
}
