import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { polymarketApiSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';

const PREDICTING_TOP_BASE = 'https://predicting.top/api/leaderboard';
const PREDICTING_TOP_PERIODS = ['7D', '30D', 'ALL'] as const;
const PERIOD_QUERY_MAP: Record<PredictingTopPeriod, string> = {
  '7D': '7d',
  '30D': '30d',
  ALL: 'all',
};
const RETRY_MAX = 3;

export type PredictingTopPeriod = (typeof PREDICTING_TOP_PERIODS)[number];

export type PredictingTopWalletMetric = {
  period: PredictingTopPeriod;
  rank: number;
  smartScore: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  winRate: number | null;
  profitFactor: number | null;
  totalReturn: number | null;
  maxDrawdownPercent: number | null;
  currentDrawdown: number | null;
  rSquared: number | null;
  calculatedAt: Date | null;
  tier: string | null;
};

type PredictingTopTrader = {
  rank?: number | string;
  name?: string | null;
  wallet?: string | null;
  wallet_count?: number | string | null;
  twitter?: string | null;
  pfp?: string | null;
  polymarket_profile?: string | null;
  platform?: string | null;
  views?: number | string | null;
  stats?: {
    pnl?: number | string | null;
    buys?: number | string | null;
    sells?: number | string | null;
  } | null;
  transfers?: {
    deposits?: number | string | null;
    withdrawals?: number | string | null;
  } | null;
  smart_score?: {
    score?: number | string | null;
    tier?: string | null;
    avgDailyReturn?: number | string | null;
    bestDay?: number | string | null;
    worstDay?: number | string | null;
    winRate?: number | string | null;
    profitFactor?: number | string | null;
    rSquared?: number | string | null;
    sharpeRatio?: number | string | null;
    sortinoRatio?: number | string | null;
    calmarRatio?: number | string | null;
    maxDrawdown?: number | string | null;
    maxDrawdownPercent?: number | string | null;
    currentDrawdown?: number | string | null;
    totalReturn?: number | string | null;
    trendSlope?: number | string | null;
    calculatedAt?: string | null;
  } | null;
  [key: string]: unknown;
};

type PredictingTopResponse = {
  traders?: PredictingTopTrader[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWallet(wallet: string | null | undefined): string | null {
  const normalized = typeof wallet === 'string' ? wallet.trim().toLowerCase() : '';
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

/** predicting.top totalReturn 偶发为美元量纲（与 pnl 同级）；超阈值则不入库。 */
const MAX_PLAUSIBLE_PREDICTING_TOP_TOTAL_RETURN = 50;

function toPlausiblePredictingTopTotalReturn(value: unknown): Prisma.Decimal | null {
  const d = toDecimal(value);
  if (d == null) return null;
  const n = Number(d);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_PLAUSIBLE_PREDICTING_TOP_TOTAL_RETURN) {
    return null;
  }
  return d;
}

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function decimalToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function fetchPredictingTopLeaderboard(period: PredictingTopPeriod): Promise<PredictingTopTrader[]> {
  const url = `${PREDICTING_TOP_BASE}?period=${PERIOD_QUERY_MAP[period]}`;
  for (let attempt = 0; attempt < RETRY_MAX; attempt += 1) {
    const response = await safeFetch(url, { headers: { Accept: 'application/json' } }, polymarketApiSafeFetchOptions());
    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as PredictingTopResponse;
      return Array.isArray(data.traders) ? data.traders : [];
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === RETRY_MAX - 1) {
      const text = await response.text().catch(() => '');
      throw new Error(`predicting.top leaderboard ${response.status}: ${text || 'Request failed'}`);
    }
    await sleep(2000 * 2 ** attempt);
  }
  return [];
}

function dedupePredictingTopTraders(traders: PredictingTopTrader[]): PredictingTopTrader[] {
  const byWallet = new Map<string, PredictingTopTrader>();
  for (const trader of traders) {
    const wallet = normalizeWallet(trader.wallet);
    if (!wallet) continue;
    const rank = toInt(trader.rank);
    if (rank == null) continue;
    const existing = byWallet.get(wallet);
    const existingRank = existing ? toInt(existing.rank) : null;
    if (!existing || existingRank == null || rank < existingRank) {
      byWallet.set(wallet, trader);
    }
  }
  return [...byWallet.values()].sort((a, b) => {
    const left = toInt(a.rank) ?? Number.MAX_SAFE_INTEGER;
    const right = toInt(b.rank) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

function traderToCreateInput(
  period: PredictingTopPeriod,
  syncVersion: number,
  syncedAt: Date,
  trader: PredictingTopTrader
): Prisma.PredictingTopLeaderboardRowCreateManyInput | null {
  const wallet = normalizeWallet(trader.wallet);
  const rank = toInt(trader.rank);
  if (!wallet || rank == null) return null;

  return {
    period,
    syncVersion,
    rank,
    wallet,
    name: trader.name ?? null,
    twitter: trader.twitter ?? null,
    profileImage: typeof trader.pfp === 'string' ? trader.pfp : null,
    platform: typeof trader.platform === 'string' ? trader.platform : null,
    polymarketProfile:
      typeof trader.polymarket_profile === 'string' ? trader.polymarket_profile : null,
    walletCount: toInt(trader.wallet_count),
    pnl: toDecimal(trader.stats?.pnl),
    buys: toInt(trader.stats?.buys),
    sells: toInt(trader.stats?.sells),
    deposits: toDecimal(trader.transfers?.deposits),
    withdrawals: toDecimal(trader.transfers?.withdrawals),
    views: toInt(trader.views),
    smartScore: toDecimal(trader.smart_score?.score),
    tier: typeof trader.smart_score?.tier === 'string' ? trader.smart_score.tier : null,
    avgDailyReturn: toDecimal(trader.smart_score?.avgDailyReturn),
    bestDay: toDecimal(trader.smart_score?.bestDay),
    worstDay: toDecimal(trader.smart_score?.worstDay),
    winRate: toDecimal(trader.smart_score?.winRate),
    profitFactor: toDecimal(trader.smart_score?.profitFactor),
    rSquared: toDecimal(trader.smart_score?.rSquared),
    sharpeRatio: toDecimal(trader.smart_score?.sharpeRatio),
    sortinoRatio: toDecimal(trader.smart_score?.sortinoRatio),
    calmarRatio: toDecimal(trader.smart_score?.calmarRatio),
    maxDrawdown: toDecimal(trader.smart_score?.maxDrawdown),
    maxDrawdownPercent: toDecimal(trader.smart_score?.maxDrawdownPercent),
    currentDrawdown: toDecimal(trader.smart_score?.currentDrawdown),
    totalReturn: toPlausiblePredictingTopTotalReturn(trader.smart_score?.totalReturn),
    trendSlope: toDecimal(trader.smart_score?.trendSlope),
    calculatedAt: toDate(trader.smart_score?.calculatedAt),
    rawPayload: CONFIG.smartMoneyExternalStoreRawPayload ? (trader as Prisma.InputJsonValue) : Prisma.JsonNull,
    syncedAt,
  };
}

export async function syncPredictingTopLeaderboards(options?: {
  delayBetweenPeriodsMs?: number;
}): Promise<
  Array<{
    period: PredictingTopPeriod;
    syncVersion: number;
    rowCount: number;
    fetchedCount: number;
  }>
> {
  const results: Array<{
    period: PredictingTopPeriod;
    syncVersion: number;
    rowCount: number;
    fetchedCount: number;
  }> = [];

  for (const period of PREDICTING_TOP_PERIODS) {
    const syncedAt = new Date();
    const lastVersionRow = await prisma.predictingTopLeaderboardRow.findFirst({
      where: { period },
      orderBy: { syncVersion: 'desc' },
      select: { syncVersion: true },
    });
    const syncVersion = (lastVersionRow?.syncVersion ?? 0) + 1;
    const traders = await fetchPredictingTopLeaderboard(period);
    const deduped = dedupePredictingTopTraders(traders);
    const rows = deduped
      .map((trader) => traderToCreateInput(period, syncVersion, syncedAt, trader))
      .filter((row): row is Prisma.PredictingTopLeaderboardRowCreateManyInput => row != null);

    await prisma.$transaction(async (tx) => {
      if (rows.length > 0) {
        await tx.predictingTopLeaderboardRow.createMany({ data: rows });
      }
      const retainedVersions = await tx.predictingTopLeaderboardRow.findMany({
        where: { period },
        select: { syncVersion: true },
        distinct: ['syncVersion'],
        orderBy: { syncVersion: 'desc' },
        take: CONFIG.smartMoneyExternalRetentionVersions,
      });
      const keepVersions = retainedVersions.map((row) => row.syncVersion);
      if (keepVersions.length > 0) {
        await tx.predictingTopLeaderboardRow.deleteMany({
          where: {
            period,
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
      period,
      syncVersion,
      rowCount: rows.length,
      fetchedCount: traders.length,
    });

    if (
      (options?.delayBetweenPeriodsMs ?? 0) > 0 &&
      period !== PREDICTING_TOP_PERIODS[PREDICTING_TOP_PERIODS.length - 1]
    ) {
      await sleep(options?.delayBetweenPeriodsMs ?? 0);
    }
  }

  return results;
}

export async function listLatestPredictingTopRows(period: PredictingTopPeriod, limit: number) {
  const latest = await prisma.predictingTopLeaderboardRow.findFirst({
    where: { period },
    orderBy: [{ syncVersion: 'desc' }, { rank: 'asc' }],
    select: { syncVersion: true },
  });
  if (!latest) {
    return { syncVersion: null, rows: [] as Awaited<ReturnType<typeof prisma.predictingTopLeaderboardRow.findMany>> };
  }
  const rows = await prisma.predictingTopLeaderboardRow.findMany({
    where: {
      period,
      syncVersion: latest.syncVersion,
    },
    orderBy: { rank: 'asc' },
    take: limit,
  });
  return { syncVersion: latest.syncVersion, rows };
}

export async function getLatestPredictingTopWalletMetrics(
  wallet: string
): Promise<Record<PredictingTopPeriod, PredictingTopWalletMetric | null>> {
  const versions = await prisma.predictingTopLeaderboardRow.groupBy({
    by: ['period'],
    _max: { syncVersion: true },
  });
  const latestRows =
    versions.length === 0
      ? []
      : await prisma.predictingTopLeaderboardRow.findMany({
          where: {
            wallet,
            OR: versions
              .filter(
                (row): row is typeof row & { _max: { syncVersion: number } } =>
                  row._max.syncVersion != null
              )
              .map((row) => ({
                period: row.period,
                syncVersion: row._max.syncVersion,
              })),
          },
          select: {
            period: true,
            rank: true,
            smartScore: true,
            sharpeRatio: true,
            sortinoRatio: true,
            winRate: true,
            profitFactor: true,
            totalReturn: true,
            maxDrawdownPercent: true,
            currentDrawdown: true,
            rSquared: true,
            calculatedAt: true,
            tier: true,
          },
        });

  const metrics: Record<PredictingTopPeriod, PredictingTopWalletMetric | null> = {
    '7D': null,
    '30D': null,
    ALL: null,
  };
  for (const row of latestRows) {
    const period = row.period as PredictingTopPeriod;
    if (!PREDICTING_TOP_PERIODS.includes(period)) continue;
    metrics[period] = {
      period,
      rank: row.rank,
      smartScore: decimalToNumber(row.smartScore),
      sharpeRatio: decimalToNumber(row.sharpeRatio),
      sortinoRatio: decimalToNumber(row.sortinoRatio),
      winRate: decimalToNumber(row.winRate),
      profitFactor: decimalToNumber(row.profitFactor),
      totalReturn: (() => {
        const n = decimalToNumber(row.totalReturn);
        if (n == null) return null;
        return Math.abs(n) > MAX_PLAUSIBLE_PREDICTING_TOP_TOTAL_RETURN ? null : n;
      })(),
      maxDrawdownPercent: decimalToNumber(row.maxDrawdownPercent),
      currentDrawdown: decimalToNumber(row.currentDrawdown),
      rSquared: decimalToNumber(row.rSquared),
      calculatedAt: row.calculatedAt,
      tier: row.tier,
    };
  }

  return metrics;
}
