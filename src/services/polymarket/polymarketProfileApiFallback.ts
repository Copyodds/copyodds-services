/**
 * 当官网 profile HTML 无 __NEXT_DATA__（CSR/RSC 壳）时，用 Gamma/Data API + user-pnl-api 组装画像。
 */
import { polymarketApiSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';
import { fetchDataApiPositions, fetchDataApiTradedCount, type DataApiPosition } from './polymarketData';
import { fetchLeaderboard } from './polymarketLeaderboard';
import type {
  PolymarketProfileCurvePeriod,
  PolymarketProfileCurvePoint,
  PolymarketProfileFetchResult,
} from './polymarketProfile';
import { fetchUserPnlTimeseries, type UserPnlApiInterval } from './polymarketUserPnlApi';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const API_FETCH_TIMEOUT_MS = 15_000;

type LightweightApiPhase =
  | 'publicProfile'
  | 'portfolioValue'
  | 'tradedCount'
  | 'leaderboard'
  | 'pnlAll'
  | 'positionsFallback';

type LightweightApiTiming = {
  totalMs: number;
  maxMs: number;
  count: number;
  failed: number;
  empty: number;
};

function createLightweightApiTimings(): Record<LightweightApiPhase, LightweightApiTiming> {
  const empty = (): LightweightApiTiming => ({
    totalMs: 0,
    maxMs: 0,
    count: 0,
    failed: 0,
    empty: 0,
  });
  return {
    publicProfile: empty(),
    portfolioValue: empty(),
    tradedCount: empty(),
    leaderboard: empty(),
    pnlAll: empty(),
    positionsFallback: empty(),
  };
}

let lightweightApiTimings = createLightweightApiTimings();

export function resetLightweightApiFallbackTimings(): void {
  lightweightApiTimings = createLightweightApiTimings();
}

export function readLightweightApiFallbackTimings(): Record<
  LightweightApiPhase,
  LightweightApiTiming & { avgMs: number }
> {
  return Object.fromEntries(
    Object.entries(lightweightApiTimings).map(([phase, stat]) => [
      phase,
      {
        ...stat,
        avgMs: stat.count > 0 ? Math.round(stat.totalMs / stat.count) : 0,
      },
    ])
  ) as Record<LightweightApiPhase, LightweightApiTiming & { avgMs: number }>;
}

async function measureLightweightApi<T>(
  enabled: boolean,
  phase: LightweightApiPhase,
  fn: () => Promise<T>,
  isEmpty: (value: T) => boolean = (value) => value == null
): Promise<T> {
  if (!enabled) return fn();
  const startedAt = Date.now();
  const stat = lightweightApiTimings[phase];
  stat.count += 1;
  try {
    const value = await fn();
    if (isEmpty(value)) stat.empty += 1;
    return value;
  } catch (error) {
    stat.failed += 1;
    throw error;
  } finally {
    const elapsedMs = Date.now() - startedAt;
    stat.totalMs += elapsedMs;
    if (elapsedMs > stat.maxMs) stat.maxMs = elapsedMs;
  }
}

type GammaPublicProfile = {
  createdAt?: string | null;
  proxyWallet?: string | null;
  profileImage?: string | null;
  name?: string | null;
  pseudonym?: string | null;
  xUsername?: string | null;
  bio?: string | null;
};

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

function isValidWallet(value: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(value);
}

function normalizeProfileSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function formatJoinedAtText(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(date);
}

function numberToString(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return String(value);
}

function profilePeriodToUserPnlInterval(period: PolymarketProfileCurvePeriod): UserPnlApiInterval {
  if (period === '1D') return '1d';
  if (period === '1W') return '1w';
  if (period === '1M') return '1m';
  return 'all';
}

async function fetchApiJson<T>(url: string): Promise<T | null> {
  try {
    const res = await safeFetch(
      url,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
      },
      polymarketApiSafeFetchOptions()
    );
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchGammaPublicProfile(wallet: string): Promise<GammaPublicProfile | null> {
  const params = new URLSearchParams({ address: wallet });
  return fetchApiJson<GammaPublicProfile>(`${GAMMA_API_BASE}/public-profile?${params}`);
}

async function fetchDataApiPortfolioValue(wallet: string): Promise<number | null> {
  const params = new URLSearchParams({ user: wallet });
  const data = await fetchApiJson<unknown>(`${DATA_API_BASE}/value?${params}`);
  if (data == null) return null;
  if (typeof data === 'number' && Number.isFinite(data)) return data;
  if (Array.isArray(data)) {
    for (const row of data) {
      if (typeof row !== 'object' || row == null) continue;
      const value = (row as { value?: unknown }).value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  if (typeof data === 'object') {
    const value = (data as { value?: unknown }).value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

async function fetchDataApiClosedPositions(wallet: string): Promise<DataApiPosition[]> {
  const params = new URLSearchParams({
    user: wallet,
    limit: '50',
  });
  const data = await fetchApiJson<unknown>(`${DATA_API_BASE}/closed-positions?${params}`);
  return Array.isArray(data) ? (data as DataApiPosition[]) : [];
}

async function buildCurvesFromUserPnlApi(
  wallet: string,
  options?: { periods?: PolymarketProfileCurvePeriod[] }
): Promise<{
  curves: PolymarketProfileCurvePoint[];
  profilePnlApiFilledPeriods: PolymarketProfileCurvePeriod[];
}> {
  const periods: PolymarketProfileCurvePeriod[] = options?.periods ?? ['1D', '1W', '1M', 'ALL'];
  const curves: PolymarketProfileCurvePoint[] = [];
  const profilePnlApiFilledPeriods: PolymarketProfileCurvePeriod[] = [];

  await Promise.all(
    periods.map(async (period) => {
      const fidelity = period === 'ALL' ? '1d' : undefined;
      const series = await fetchUserPnlTimeseries(wallet, profilePeriodToUserPnlInterval(period), {
        fidelity,
      });
      if (series.length === 0) return;
      profilePnlApiFilledPeriods.push(period);
      for (const point of series) {
        curves.push({
          curveType: `PORTFOLIO_PNL_${period}`,
          period,
          ts: new Date(point.t * 1000),
          value: String(point.p),
        });
      }
    })
  );

  return { curves, profilePnlApiFilledPeriods };
}

function countDistinctMarkets(positions: DataApiPosition[]): number {
  const markets = new Set<string>();
  for (const row of positions) {
    if (typeof row.conditionId === 'string' && row.conditionId) {
      markets.add(row.conditionId);
    }
  }
  return markets.size;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchLeaderboardUserStats(wallet: string): Promise<{
  totalPnl: string | null;
  totalVolume: string | null;
} | null> {
  try {
    const rows = await fetchLeaderboard({ user: wallet, timePeriod: 'all', limit: 1 });
    const row = rows[0];
    if (!row) return null;
    const pnl = numberFromUnknown(row.pnl);
    const vol = numberFromUnknown(row.vol);
    return {
      totalPnl: pnl == null ? null : String(pnl),
      totalVolume: vol == null ? null : String(vol),
    };
  } catch {
    return null;
  }
}

function totalPnlFromCurves(curves: PolymarketProfileCurvePoint[]): string | null {
  const allPoints = curves
    .filter((point) => point.period === 'ALL')
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (allPoints.length === 0) return null;
  return allPoints[allPoints.length - 1]!.value;
}

export async function fetchPolymarketProfileFromApis(
  walletOrSlug: string,
  options?: {
    pnlPeriods?: PolymarketProfileCurvePeriod[];
    /** Light 快筛：省略非 Gate 必需的持仓明细；仅 traded-count 缺失时兜底补抓。 */
    lightweight?: boolean;
  }
): Promise<PolymarketProfileFetchResult> {
  const wallet = normalizeWallet(walletOrSlug);
  if (!isValidWallet(wallet)) {
    throw new Error(`Invalid wallet for API profile fallback: ${walletOrSlug}`);
  }

  const lightweight = options?.lightweight === true;
  const [publicProfile, portfolioValue, tradedCount, leaderboardStats, curveBundle] = await Promise.all([
    measureLightweightApi(lightweight, 'publicProfile', () => fetchGammaPublicProfile(wallet)),
    measureLightweightApi(lightweight, 'portfolioValue', () => fetchDataApiPortfolioValue(wallet)),
    measureLightweightApi(lightweight, 'tradedCount', () => fetchDataApiTradedCount(wallet)),
    measureLightweightApi(lightweight, 'leaderboard', () => fetchLeaderboardUserStats(wallet)),
    measureLightweightApi(
      lightweight,
      'pnlAll',
      () => buildCurvesFromUserPnlApi(wallet, { periods: options?.pnlPeriods }),
      (value) => value.curves.length === 0
    ),
  ]);

  let openPositions: DataApiPosition[] = [];
  let closedPositions: DataApiPosition[] = [];
  // traded-count 正常时已是更准确且更便宜的预测数来源。完整画像仍保留持仓明细；
  // Light 仅在 traded-count 不可用时补抓，避免把瞬时 API 缺失误判为 T1L-2。
  if (!options?.lightweight || tradedCount == null) {
    [openPositions, closedPositions] = await measureLightweightApi(
      lightweight,
      'positionsFallback',
      () =>
        Promise.all([
          fetchDataApiPositions(wallet, { limit: 500, sizeThreshold: 0, skipCache: true }).catch(() => []),
          fetchDataApiClosedPositions(wallet),
        ]),
      ([open, closed]) => open.length === 0 && closed.length === 0
    );
  }

  const marketCount = countDistinctMarkets([...openPositions, ...closedPositions]);
  const profileSlug =
    normalizeProfileSlug(publicProfile?.name) ??
    normalizeProfileSlug(publicProfile?.pseudonym) ??
    null;
  const sourceUrl = `${GAMMA_API_BASE}/public-profile?address=${wallet}`;

  return {
    wallet,
    profileSlug,
    displayName: typeof publicProfile?.name === 'string' ? publicProfile.name : null,
    username: profileSlug,
    xUsername: typeof publicProfile?.xUsername === 'string' ? publicProfile.xUsername : null,
    profileImage: typeof publicProfile?.profileImage === 'string' ? publicProfile.profileImage : null,
    joinedAtText: formatJoinedAtText(publicProfile?.createdAt),
    viewsText: null,
    holdingsValue: numberToString(portfolioValue),
    biggestWin: null,
    predictionCount: tradedCount ?? (marketCount > 0 ? marketCount : null),
    totalPnl: leaderboardStats?.totalPnl ?? totalPnlFromCurves(curveBundle.curves),
    totalVolume: leaderboardStats?.totalVolume ?? null,
    sourceUrl,
    snapshotAt: new Date(),
    curves: curveBundle.curves,
    profilePnlApiFilledPeriods: curveBundle.profilePnlApiFilledPeriods,
    rawSummary: {
      source: 'api-fallback',
      publicProfile: publicProfile ?? null,
      portfolioValue,
      tradedCount,
      distinctMarketCount: marketCount,
      leaderboardStats: leaderboardStats ?? null,
      openPositionCount: openPositions.length,
      closedPositionCount: closedPositions.length,
      profilePnlApiFilledPeriods: curveBundle.profilePnlApiFilledPeriods,
    },
  };
}
