import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { polymarketApiSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';

const FALCON_API_URL =
  'https://narrative.agent.heisenberg.so/api/v2/semantic/retrieve/parameterized';
const FALCON_API_HOSTS = ['narrative.agent.heisenberg.so'] as const;
const ANALYTICS_PERIODS = ['7D', '30D', 'ALL'] as const;
const PAGE_LIMIT = 200;
const RETRY_MAX = 3;

function getMaxRowsPerPeriod(): number {
  return Math.max(1000, CONFIG.smartMoneyCandidateLimit);
}

export type PolymarketAnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

type AnalyticsSyncSpec = {
  period: PolymarketAnalyticsPeriod;
  agentId: number;
  params: Record<string, string>;
};

const ANALYTICS_SYNC_SPECS: AnalyticsSyncSpec[] = [
  {
    period: '7D',
    agentId: 579,
    params: { wallet_address: 'ALL', leaderboard_period: '7d' },
  },
  {
    period: '30D',
    agentId: 579,
    params: { wallet_address: 'ALL', leaderboard_period: '30d' },
  },
  {
    period: 'ALL',
    agentId: 584,
    params: { sort_by: 'h_score', min_pnl_15d: '0' },
  },
];

type FalconLeaderboardEntry = Record<string, unknown>;

type FalconApiResponse = {
  pagination?: { has_more?: boolean };
  data?: { results?: FalconLeaderboardEntry[] };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWallet(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (value == null) return null;
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  return new Prisma.Decimal(num);
}

function parseRank(entry: FalconLeaderboardEntry): number | null {
  return toInt(entry.leaderboard_rank ?? entry.rank);
}

function parseWallet(entry: FalconLeaderboardEntry): string | null {
  return normalizeWallet(entry.wallet ?? entry.address);
}

function parseWinRate(entry: FalconLeaderboardEntry): unknown {
  return entry.win_rate_pct_15d ?? entry.win_rate ?? entry.winRate;
}

function parseRoi(entry: FalconLeaderboardEntry): unknown {
  return entry.roi_pct_15d ?? entry.roi;
}

async function fetchFalconLeaderboardPage(
  spec: AnalyticsSyncSpec,
  offset: number
): Promise<{ entries: FalconLeaderboardEntry[]; hasMore: boolean }> {
  const apiKey = CONFIG.polymarketAnalyticsApiKey;
  if (!apiKey) {
    throw new Error('POLYMARKET_ANALYTICS_API_KEY is not set');
  }

  const body = {
    agent_id: spec.agentId,
    params: spec.params,
    pagination: { limit: PAGE_LIMIT, offset },
    formatter_config: { format_type: 'raw' },
  };

  for (let attempt = 0; attempt < RETRY_MAX; attempt += 1) {
    const response = await safeFetch(
      FALCON_API_URL,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      polymarketApiSafeFetchOptions(FALCON_API_HOSTS)
    );

    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as FalconApiResponse | FalconLeaderboardEntry[];
      if (Array.isArray(data)) {
        return { entries: data, hasMore: data.length >= PAGE_LIMIT };
      }
      const entries = Array.isArray(data.data?.results) ? data.data.results : [];
      return { entries, hasMore: Boolean(data.pagination?.has_more) };
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === RETRY_MAX - 1) {
      const text = await response.text().catch(() => '');
      throw new Error(`Polymarket Analytics API ${response.status}: ${text || 'Request failed'}`);
    }
    await sleep(2000 * 2 ** attempt);
  }

  return { entries: [], hasMore: false };
}

async function fetchAllFalconLeaderboardEntries(spec: AnalyticsSyncSpec): Promise<FalconLeaderboardEntry[]> {
  const entries: FalconLeaderboardEntry[] = [];
  const seenWallets = new Set<string>();
  let offset = 0;

  for (;;) {
    const page = await fetchFalconLeaderboardPage(spec, offset);
    if (page.entries.length === 0) {
      break;
    }

    for (const entry of page.entries) {
      const wallet = parseWallet(entry);
      const rank = parseRank(entry);
      if (!wallet || rank == null || seenWallets.has(wallet)) {
        continue;
      }
      seenWallets.add(wallet);
      entries.push(entry);
      if (entries.length >= getMaxRowsPerPeriod()) {
        return entries;
      }
    }

    if (!page.hasMore || page.entries.length < PAGE_LIMIT) {
      break;
    }
    offset += PAGE_LIMIT;
  }

  return entries.sort((a, b) => {
    const left = parseRank(a) ?? Number.MAX_SAFE_INTEGER;
    const right = parseRank(b) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

function entryToCreateInput(
  period: PolymarketAnalyticsPeriod,
  syncVersion: number,
  syncedAt: Date,
  entry: FalconLeaderboardEntry
): Prisma.PolymarketAnalyticsLeaderboardRowCreateManyInput | null {
  const wallet = parseWallet(entry);
  const rank = parseRank(entry);
  if (!wallet || rank == null) return null;

  return {
    period,
    syncVersion,
    rank,
    wallet,
    hScore: toDecimal(entry.h_score ?? entry.hScore),
    roi: toDecimal(parseRoi(entry)),
    winRate: toDecimal(parseWinRate(entry)),
    sharpeRatio: toDecimal(entry.sharpe_ratio_15d ?? entry.sharpe_ratio ?? entry.sharpeRatio),
    totalPnl: toDecimal(entry.total_pnl_15d ?? entry.total_pnl ?? entry.totalPnl),
    totalVolume: toDecimal(entry.total_volume_15d ?? entry.total_volume ?? entry.totalVolume),
    totalTrades: toInt(entry.total_trades_15d ?? entry.total_trades ?? entry.totalTrades),
    marketsTraded: toInt(entry.markets_traded_15d ?? entry.markets_traded ?? entry.marketsTraded),
    tier: typeof entry.tier === 'string' ? entry.tier : null,
    rawPayload: CONFIG.smartMoneyExternalStoreRawPayload
      ? (entry as Prisma.InputJsonValue)
      : Prisma.JsonNull,
    syncedAt,
  };
}

export async function syncPolymarketAnalyticsLeaderboards(options?: {
  delayBetweenPeriodsMs?: number;
}): Promise<
  Array<{
    period: PolymarketAnalyticsPeriod;
    syncVersion: number;
    rowCount: number;
    fetchedCount: number;
  }>
> {
  if (!CONFIG.polymarketAnalyticsApiKey) {
    return [];
  }

  const results: Array<{
    period: PolymarketAnalyticsPeriod;
    syncVersion: number;
    rowCount: number;
    fetchedCount: number;
  }> = [];

  for (const spec of ANALYTICS_SYNC_SPECS) {
    const syncedAt = new Date();
    const lastVersionRow = await prisma.polymarketAnalyticsLeaderboardRow.findFirst({
      where: { period: spec.period },
      orderBy: { syncVersion: 'desc' },
      select: { syncVersion: true },
    });
    const syncVersion = (lastVersionRow?.syncVersion ?? 0) + 1;
    const entries = await fetchAllFalconLeaderboardEntries(spec);
    const rows = entries
      .map((entry) => entryToCreateInput(spec.period, syncVersion, syncedAt, entry))
      .filter((row): row is Prisma.PolymarketAnalyticsLeaderboardRowCreateManyInput => row != null);

    await prisma.$transaction(async (tx) => {
      if (rows.length > 0) {
        await tx.polymarketAnalyticsLeaderboardRow.createMany({ data: rows });
      }
      const retainedVersions = await tx.polymarketAnalyticsLeaderboardRow.findMany({
        where: { period: spec.period },
        select: { syncVersion: true },
        distinct: ['syncVersion'],
        orderBy: { syncVersion: 'desc' },
        take: CONFIG.smartMoneyExternalRetentionVersions,
      });
      const keepVersions = retainedVersions.map((row) => row.syncVersion);
      if (keepVersions.length > 0) {
        await tx.polymarketAnalyticsLeaderboardRow.deleteMany({
          where: {
            period: spec.period,
            syncVersion: { notIn: keepVersions },
          },
        });
      }
    }, {
      // Bulk insert + retention cleanup routinely exceeds the 5s Prisma default
      // on IO-constrained hosts; keep the window generous.
      maxWait: 15_000,
      timeout: 60_000,
    });

    results.push({
      period: spec.period,
      syncVersion,
      rowCount: rows.length,
      fetchedCount: entries.length,
    });

    if (
      (options?.delayBetweenPeriodsMs ?? 0) > 0 &&
      spec !== ANALYTICS_SYNC_SPECS[ANALYTICS_SYNC_SPECS.length - 1]
    ) {
      await sleep(options?.delayBetweenPeriodsMs ?? 0);
    }
  }

  return results;
}

export async function listLatestPolymarketAnalyticsRows(
  period: PolymarketAnalyticsPeriod,
  limit: number
) {
  const latest = await prisma.polymarketAnalyticsLeaderboardRow.findFirst({
    where: { period },
    orderBy: [{ syncVersion: 'desc' }, { rank: 'asc' }],
    select: { syncVersion: true },
  });
  if (!latest) {
    return {
      syncVersion: null,
      rows: [] as Awaited<ReturnType<typeof prisma.polymarketAnalyticsLeaderboardRow.findMany>>,
    };
  }
  const rows = await prisma.polymarketAnalyticsLeaderboardRow.findMany({
    where: {
      period,
      syncVersion: latest.syncVersion,
    },
    orderBy: { rank: 'asc' },
    take: limit,
  });
  return { syncVersion: latest.syncVersion, rows };
}
