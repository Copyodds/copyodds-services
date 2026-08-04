/**
 * Polymarket Data API — leaderboard (https://data-api.polymarket.com/v1/leaderboard)
 */

import { polymarketApiSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';

const DATA_API_BASE = 'https://data-api.polymarket.com';

export type FetchLeaderboardParams = {
  category?: string;
  timePeriod?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
  user?: string;
  userName?: string;
};

/** 与上游 JSON 对齐的宽松类型 */
export type LeaderboardApiEntry = {
  rank?: number | string;
  proxyWallet?: string;
  userName?: string | null;
  vol?: number | string;
  pnl?: number | string;
  profileImage?: string | null;
  xUsername?: string | null;
  [key: string]: unknown;
};

export function buildLeaderboardSearchParams(q: FetchLeaderboardParams): URLSearchParams {
  const params = new URLSearchParams();
  if (q.category) params.set('category', q.category);
  if (q.timePeriod) params.set('timePeriod', q.timePeriod);
  if (q.orderBy) params.set('orderBy', q.orderBy);
  if (q.limit != null) params.set('limit', String(q.limit));
  if (q.offset != null) params.set('offset', String(q.offset));
  if (q.user) params.set('user', q.user);
  if (q.userName) params.set('userName', q.userName);
  return params;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 直连 Data API；失败时抛错（路由层转 502）。
 */
export async function fetchLeaderboard(params: FetchLeaderboardParams): Promise<LeaderboardApiEntry[]> {
  const search = buildLeaderboardSearchParams(params);
  const url = `${DATA_API_BASE}/v1/leaderboard${search.toString() ? `?${search.toString()}` : ''}`;
  const res = await safeFetch(url, { headers: { Accept: 'application/json' } }, polymarketApiSafeFetchOptions());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Data API leaderboard ${res.status}: ${text || 'Request failed'}`);
  }
  const data = (await res.json().catch(() => [])) as unknown;
  return Array.isArray(data) ? (data as LeaderboardApiEntry[]) : [];
}

const LEADERBOARD_RETRY_MAX = 3;

/**
 * 定时同步用：每次请求前 sleep(gapMs)，遇 429/5xx 指数退避并重试（最多 3 次）。
 */
export async function fetchLeaderboardWithRetry(
  params: FetchLeaderboardParams,
  options: { gapMs: number }
): Promise<LeaderboardApiEntry[]> {
  for (let attempt = 0; attempt < LEADERBOARD_RETRY_MAX; attempt++) {
    if (options.gapMs > 0) await sleep(options.gapMs);
    const search = buildLeaderboardSearchParams(params);
    const url = `${DATA_API_BASE}/v1/leaderboard${search.toString() ? `?${search.toString()}` : ''}`;
    const res = await safeFetch(url, { headers: { Accept: 'application/json' } }, polymarketApiSafeFetchOptions());
    if (res.ok) {
      const data = (await res.json().catch(() => [])) as unknown;
      return Array.isArray(data) ? (data as LeaderboardApiEntry[]) : [];
    }
    // Data API occasionally returns 408 when its upstream times out; treat as retryable.
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt === LEADERBOARD_RETRY_MAX - 1) {
      const text = await res.text().catch(() => '');
      throw new Error(`Data API leaderboard ${res.status}: ${text || 'Request failed'}`);
    }
    const retryAfter = res.headers.get('Retry-After');
    let delayMs = 2000 * 2 ** attempt;
    if (retryAfter) {
      const sec = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(sec) && sec >= 0) delayMs = Math.max(delayMs, sec * 1000);
    }

    console.warn('[leaderboard-api] retrying request', {
      params,
      attempt: attempt + 1,
      status: res.status,
      delayMs,
      retryAfter,
      rateLimitLimit: res.headers.get('X-RateLimit-Limit'),
      rateLimitRemaining: res.headers.get('X-RateLimit-Remaining'),
      rateLimitReset: res.headers.get('X-RateLimit-Reset'),
    });
    await sleep(delayMs);
  }
  return [];
}
