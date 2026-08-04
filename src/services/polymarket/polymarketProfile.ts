import { CONFIG } from '../../config/env';
import { safeFetch, SsrfBlockedError } from '../../utils/ssrfGuard';
import { fetchPolymarketProfileFromApis } from './polymarketProfileApiFallback';
import { fetchUserPnlTimeseries, type UserPnlApiInterval } from './polymarketUserPnlApi';

const PROFILE_FETCH_HOSTS = ['polymarket.com', 'www.polymarket.com'] as const;

/** Cloudflare 常拦截 bot UA；与 curl/浏览器对齐，避免生产机 Node fetch 报裸 `fetch failed`。 */
const POLYMARKET_PROFILE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const POLYMARKET_PROFILE_FETCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': POLYMARKET_PROFILE_USER_AGENT,
  Cookie: 'NEXT_LOCALE=en',
} as const;

const POLYMARKET_BASE_URL = 'https://polymarket.com';
const NEXT_DATA_MARKER = '<script id="__NEXT_DATA__" type="application/json"';

export type PolymarketProfileCurvePeriod = '1D' | '1W' | '1M' | 'ALL';

export type PolymarketProfileCurvePoint = {
  curveType: string;
  period: PolymarketProfileCurvePeriod;
  ts: Date;
  value: string;
};

export type PolymarketProfileFetchResult = {
  wallet: string;
  profileSlug: string | null;
  displayName: string | null;
  username: string | null;
  xUsername: string | null;
  profileImage: string | null;
  joinedAtText: string | null;
  viewsText: string | null;
  holdingsValue: string | null;
  biggestWin: string | null;
  predictionCount: number | null;
  totalPnl: string | null;
  totalVolume: string | null;
  sourceUrl: string;
  snapshotAt: Date;
  curves: PolymarketProfileCurvePoint[];
  /** 由 user-pnl-api 补全的周期（HTML 脱水未含该周期曲线时） */
  profilePnlApiFilledPeriods: PolymarketProfileCurvePeriod[];
  rawSummary: Record<string, unknown>;
};

type CachedPolymarketProfileEntry = {
  expiresAt: number;
  value: PolymarketProfileFetchResult;
};

type NextDataQuery = {
  queryKey?: unknown;
  state?: {
    data?: unknown;
  };
};

export type PolymarketProfileFetchErrorKind =
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'server'
  | 'not_found'
  | 'http'
  | 'parse'
  | 'invalid';

export class PolymarketProfileFetchError extends Error {
  readonly kind: PolymarketProfileFetchErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    kind: PolymarketProfileFetchErrorKind,
    message: string,
    options?: { retryable?: boolean; status?: number | null }
  ) {
    super(message);
    this.name = 'PolymarketProfileFetchError';
    this.kind = kind;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status ?? null;
  }
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

function normalizeProfileSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function normalizeXUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return /^[a-zA-Z0-9_]{1,32}$/.test(normalized) ? normalized : null;
}

function normalizeImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatJoinedAtText(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(date);
}

function formatViewsText(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function numberToString(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return String(value);
}

function numberToInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidWallet(value: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(value);
}

function formatUndiciFetchCause(error: unknown): string | null {
  if (!(error instanceof Error) || !('cause' in error)) return null;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code ? `${cause.message} (${code})` : cause.message;
  }
  if (typeof cause === 'object' && cause != null) {
    const record = cause as { code?: string; message?: string };
    const parts = [record.code, record.message].filter(
      (part): part is string => typeof part === 'string' && part.length > 0
    );
    return parts.length > 0 ? parts.join(': ') : null;
  }
  return cause != null ? String(cause) : null;
}

function toFetchError(error: unknown): PolymarketProfileFetchError {
  if (error instanceof PolymarketProfileFetchError) {
    return error;
  }
  const cause =
    error instanceof Error && "cause" in error
      ? (error as Error & { cause?: { code?: string; message?: string } }).cause
      : undefined;
  const causeCode = typeof cause?.code === 'string' ? cause.code : null;
  const causeMessage = typeof cause?.message === 'string' ? cause.message : '';
  const causeDetail = formatUndiciFetchCause(error);
  if (causeCode === 'UND_ERR_CONNECT_TIMEOUT') {
    return new PolymarketProfileFetchError(
      'timeout',
      `Connect timeout to polymarket.com:443${causeMessage ? ` (${causeMessage})` : ''}`,
      { retryable: true }
    );
  }
  if (causeCode === 'UND_ERR_HEADERS_OVERFLOW') {
    return new PolymarketProfileFetchError(
      'network',
      'Polymarket response headers exceed client limit (UND_ERR_HEADERS_OVERFLOW)',
      { retryable: true }
    );
  }
  if (error instanceof Error && /abort|timed out|timeout/i.test(error.message)) {
    return new PolymarketProfileFetchError('timeout', error.message, { retryable: true });
  }
  if (error instanceof Error) {
    const message =
      error.message === 'fetch failed' && causeDetail
        ? `fetch failed: ${causeDetail}`
        : error.message;
    return new PolymarketProfileFetchError('network', message, { retryable: true });
  }
  return new PolymarketProfileFetchError('network', String(error), { retryable: true });
}

async function fetchTextWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.smartMoneyProfileTimeoutMs);
  try {
    return await safeFetch(
      url,
      {
        signal: controller.signal,
        headers: POLYMARKET_PROFILE_FETCH_HEADERS,
      },
      { allowedHosts: PROFILE_FETCH_HOSTS }
    );
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      throw new PolymarketProfileFetchError('network', error.message, { retryable: false });
    }
    throw toFetchError(error);
  } finally {
    clearTimeout(timer);
  }
}

function getJsonBlock(html: string): string {
  const regexMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (regexMatch?.[1]) {
    return regexMatch[1];
  }

  const markerStart = html.indexOf(NEXT_DATA_MARKER);
  if (markerStart < 0) {
    throw new Error('NEXT_DATA marker not found');
  }
  const contentStart = html.indexOf('>', markerStart);
  if (contentStart < 0) {
    throw new Error('NEXT_DATA start tag malformed');
  }
  const contentEnd = html.indexOf('</script>', contentStart);
  if (contentEnd < 0) {
    throw new Error('NEXT_DATA closing tag not found');
  }
  return html.slice(contentStart + 1, contentEnd);
}

function queryKeyIncludes(queryKey: unknown, needle: string): boolean {
  return JSON.stringify(queryKey ?? '').includes(needle);
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

function deepFindStringByKeys(
  root: unknown,
  candidateKeys: string[],
  normalize: (value: unknown) => string | null,
  maxDepth = 6
): string | null {
  if (!isObjectLike(root)) return null;
  const wanted = new Set(candidateKeys.map((key) => key.toLowerCase()));
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !isObjectLike(current.value) || seen.has(current.value)) continue;
    seen.add(current.value);

    for (const [key, value] of Object.entries(current.value)) {
      if (wanted.has(key.toLowerCase())) {
        const normalized = normalize(value);
        if (normalized) return normalized;
      }

      if (current.depth >= maxDepth) continue;

      if (Array.isArray(value)) {
        for (const item of value) {
          if (isObjectLike(item)) {
            queue.push({ value: item, depth: current.depth + 1 });
          }
        }
        continue;
      }

      if (isObjectLike(value)) {
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function findQueryData<T>(queries: NextDataQuery[], needle: string): T | null {
  for (const query of queries) {
    if (queryKeyIncludes(query.queryKey, needle)) {
      return (query.state?.data as T | undefined) ?? null;
    }
  }
  return null;
}

function isPnlCurvePointArray(value: unknown): value is Array<{ t?: number; p?: number }> {
  if (!Array.isArray(value) || value.length === 0) return false;
  const first = value[0];
  if (typeof first !== 'object' || first == null) return false;
  return typeof (first as { t?: unknown }).t === 'number' || typeof (first as { p?: unknown }).p === 'number';
}

/** 精确 key 未命中时，在 dehydrated queries 里按 portfolio-pnl + wallet + period 模糊匹配（兼容官网 queryKey 细微变化） */
function findPortfolioPnlCurveSeries(
  queries: NextDataQuery[],
  profileSlug: string | null,
  wallet: string,
  period: PolymarketProfileCurvePeriod
): Array<{ t?: number; p?: number }> | null {
  const walletLower = wallet.trim().toLowerCase();
  const slug = profileSlug ?? '';
  const needles = [
    `["portfolio-pnl","${slug}","${walletLower}","${period}"]`,
    `["portfolio-pnl","${slug}","${wallet}","${period}"]`,
  ];
  for (const needle of needles) {
    const curve = findQueryData<Array<{ t?: number; p?: number }>>(queries, needle);
    if (isPnlCurvePointArray(curve)) return curve;
  }

  const periodTail = `","${period}"]`;
  for (const query of queries) {
    const keyStr = JSON.stringify(query.queryKey ?? '');
    if (!keyStr.toLowerCase().includes('portfolio-pnl')) continue;
    if (!keyStr.toLowerCase().includes(walletLower)) continue;
    if (!keyStr.includes(periodTail)) continue;
    const data = query.state?.data;
    if (isPnlCurvePointArray(data)) return data;
  }
  return null;
}

/**
 * 与官网个人页「盈亏」图表同源：React Query key `portfolio-pnl`，`p` 为美元计价的组合累计盈亏（非单独「24h 涨跌」一行数字）。
 * 定时管道 Deep Analyze / Profile persist 写入的曲线即此序列；提高分析频率可让 DB 与官网更接近。
 */
function parseCurvePoints(
  profileSlug: string | null,
  wallet: string,
  queries: NextDataQuery[]
): PolymarketProfileCurvePoint[] {
  const periods: PolymarketProfileCurvePeriod[] = ['1D', '1W', '1M', 'ALL'];
  const points: PolymarketProfileCurvePoint[] = [];

  for (const period of periods) {
    const curve = findPortfolioPnlCurveSeries(queries, profileSlug, wallet, period);
    if (!Array.isArray(curve)) continue;
    for (const point of curve) {
      if (typeof point?.t !== 'number' || !Number.isFinite(point.t)) continue;
      if (typeof point?.p !== 'number' || !Number.isFinite(point.p)) continue;
      points.push({
        curveType: `PORTFOLIO_PNL_${period}`,
        period,
        ts: new Date(point.t * 1000),
        value: String(point.p),
      });
    }
  }

  return points;
}

function profilePeriodToUserPnlInterval(period: PolymarketProfileCurvePeriod): UserPnlApiInterval {
  if (period === '1D') return '1d';
  if (period === '1W') return '1w';
  if (period === '1M') return '1m';
  return 'all';
}

/**
 * 请求官网 user-pnl-api 补全/升级曲线：
 * - HTML 无该周期 → 填入 API 序列
 * - HTML 有但比 API 稀疏（常见：__NEXT_DATA__ 1M 仅 ~30 点，API 1h 有数百点）→ 用 API 替换
 */
function userPnlFidelityForPeriod(period: PolymarketProfileCurvePeriod): '1h' | '3h' | '12h' | '1d' {
  // ALL 历史曲线用日频即可，显著减少点数与序列化体积
  if (period === 'ALL') return '1d';
  return CONFIG.polymarketUserPnlFidelity;
}

async function mergeCurvesWithUserPnlApi(
  wallet: string,
  curves: PolymarketProfileCurvePoint[],
  options?: { periods?: PolymarketProfileCurvePeriod[] }
): Promise<{ curves: PolymarketProfileCurvePoint[]; profilePnlApiFilledPeriods: PolymarketProfileCurvePeriod[] }> {
  if (!CONFIG.polymarketUserPnlApiEnabled) {
    return { curves, profilePnlApiFilledPeriods: [] };
  }
  const periods: PolymarketProfileCurvePeriod[] = options?.periods ?? ['1D', '1W', '1M', 'ALL'];
  const htmlCountByPeriod = new Map<PolymarketProfileCurvePeriod, number>();
  for (const point of curves) {
    htmlCountByPeriod.set(point.period, (htmlCountByPeriod.get(point.period) ?? 0) + 1);
  }

  const replacements = new Map<PolymarketProfileCurvePeriod, PolymarketProfileCurvePoint[]>();
  await Promise.all(
    periods.map(async (period) => {
      try {
        const series = await fetchUserPnlTimeseries(wallet, profilePeriodToUserPnlInterval(period), {
          fidelity: userPnlFidelityForPeriod(period),
        });
        if (series.length === 0) return;
        const htmlCount = htmlCountByPeriod.get(period) ?? 0;
        if (htmlCount >= series.length) return;
        replacements.set(
          period,
          series.map((point) => ({
            curveType: `PORTFOLIO_PNL_${period}`,
            period,
            ts: new Date(point.t * 1000),
            value: String(point.p),
          }))
        );
      } catch {
        /* 单周期失败不影响其它周期与 HTML 解析结果 */
      }
    })
  );

  if (replacements.size === 0) {
    return { curves, profilePnlApiFilledPeriods: [] };
  }

  let merged = curves;
  const filled: PolymarketProfileCurvePeriod[] = [];
  for (const [period, apiPoints] of replacements) {
    merged = merged.filter((point) => point.period !== period).concat(apiPoints);
    filled.push(period);
  }
  return { curves: merged, profilePnlApiFilledPeriods: filled };
}

export function buildPolymarketProfileUrl(walletOrSlug: string): string {
  return buildPolymarketProfileUrlCandidates(walletOrSlug)[0]!;
}

function buildPolymarketProfileUrlCandidates(walletOrSlug: string): string[] {
  const input = walletOrSlug.trim();
  if (!input) {
    throw new Error('walletOrSlug is empty');
  }
  const slug = input.startsWith('@') ? input.slice(1) : input;
  const encoded = encodeURIComponent(slug);
  return [
    `${POLYMARKET_BASE_URL}/en/profile/${encoded}`,
    `${POLYMARKET_BASE_URL}/profile/${encoded}`,
  ];
}

function throwProfileHttpError(status: number, text: string): never {
  if (status === 404) {
    throw new PolymarketProfileFetchError(
      'not_found',
      `Polymarket profile ${status}: ${text || 'Profile not found'}`,
      { status }
    );
  }
  if (status === 429) {
    throw new PolymarketProfileFetchError(
      'rate_limit',
      `Polymarket profile ${status}: ${text || 'Rate limited'}`,
      { retryable: true, status }
    );
  }
  if (status >= 500) {
    throw new PolymarketProfileFetchError(
      'server',
      `Polymarket profile ${status}: ${text || 'Upstream server error'}`,
      { retryable: true, status }
    );
  }
  throw new PolymarketProfileFetchError(
    'http',
    `Polymarket profile ${status}: ${text || 'Request failed'}`,
    { status }
  );
}

function parseProfileFromHtml(
  html: string,
  sourceUrl: string,
  walletOrSlug: string
): PolymarketProfileFetchResult {
  let nextData: {
    props?: {
      pageProps?: {
        profileSlug?: unknown;
        username?: unknown;
        proxyAddress?: unknown;
        dehydratedState?: {
          queries?: NextDataQuery[];
        };
      };
    };
  };
  const rawNextData = getJsonBlock(html);
  nextData = JSON.parse(rawNextData) as typeof nextData;

  const pageProps = nextData.props?.pageProps;
  const queries = pageProps?.dehydratedState?.queries ?? [];
  const wallet = normalizeWallet(
    typeof pageProps?.proxyAddress === 'string' ? pageProps.proxyAddress : walletOrSlug
  );
  if (!isValidWallet(wallet)) {
    throw new PolymarketProfileFetchError(
      'invalid',
      `Polymarket profile returned invalid wallet: ${wallet || walletOrSlug}`
    );
  }
  const profileSlug = normalizeProfileSlug(pageProps?.profileSlug ?? pageProps?.username ?? walletOrSlug);

  const userStats = findQueryData<{
    trades?: number;
    largestWin?: number;
    views?: number;
    joinDate?: string;
  }>(queries, '["user-stats"');

  const userData = findQueryData<{
    name?: string;
    proxyWallet?: string;
  }>(queries, '["/api/profile/userData"');

  const volumeSummary = findQueryData<{
    amount?: number;
    pnl?: number;
    realized?: number;
    unrealized?: number;
  }>(queries, '["/api/profile/volume"');

  const positionsValue = findQueryData<number>(queries, '["positions","value"');
  let curves = parseCurvePoints(profileSlug, wallet, queries);
  return {
    wallet,
    profileSlug,
    displayName: typeof userData?.name === 'string' ? userData.name : null,
    username: typeof pageProps?.username === 'string' ? pageProps.username : profileSlug,
    xUsername:
      deepFindStringByKeys(
        { pageProps, userData },
        ['xUsername', 'twitterUsername', 'twitterHandle', 'twitter', 'xHandle', 'socialUsername'],
        normalizeXUsername
      ) ?? null,
    profileImage:
      deepFindStringByKeys(
        { pageProps, userData },
        [
          'profileImage',
          'profileImageUrl',
          'profilePhoto',
          'profilePicture',
          'profilePic',
          'profilePicUrl',
          'avatar',
          'avatarUrl',
          'pfp',
        ],
        normalizeImageUrl
      ) ?? null,
    joinedAtText: formatJoinedAtText(userStats?.joinDate),
    viewsText: formatViewsText(userStats?.views),
    holdingsValue: numberToString(positionsValue),
    biggestWin: numberToString(userStats?.largestWin),
    predictionCount: numberToInt(userStats?.trades),
    totalPnl: numberToString(volumeSummary?.pnl),
    totalVolume: numberToString(volumeSummary?.amount),
    sourceUrl,
    snapshotAt: new Date(),
    curves,
    profilePnlApiFilledPeriods: [],
    rawSummary: {
      userStats: userStats ?? null,
      userData: userData ?? null,
      positionsValue: positionsValue ?? null,
      volumeSummary: volumeSummary ?? null,
      social: {
        xUsername:
          deepFindStringByKeys(
            { pageProps, userData },
            ['xUsername', 'twitterUsername', 'twitterHandle', 'twitter', 'xHandle', 'socialUsername'],
            normalizeXUsername
          ) ?? null,
        profileImage:
          deepFindStringByKeys(
            { pageProps, userData },
            [
              'profileImage',
              'profileImageUrl',
              'profilePhoto',
              'profilePicture',
              'profilePic',
              'profilePicUrl',
              'avatar',
              'avatarUrl',
              'pfp',
            ],
            normalizeImageUrl
          ) ?? null,
      },
    },
  };
}

async function finalizeProfileResult(
  partial: PolymarketProfileFetchResult,
  options?: { pnlPeriods?: PolymarketProfileCurvePeriod[]; skipPnlApi?: boolean }
): Promise<PolymarketProfileFetchResult> {
  if (options?.skipPnlApi) {
    return partial;
  }
  const pnlApiMerge = await mergeCurvesWithUserPnlApi(partial.wallet, partial.curves, {
    periods: options?.pnlPeriods,
  });
  return {
    ...partial,
    curves: pnlApiMerge.curves,
    profilePnlApiFilledPeriods: pnlApiMerge.profilePnlApiFilledPeriods,
    rawSummary: {
      ...partial.rawSummary,
      profilePnlApiFilledPeriods: pnlApiMerge.profilePnlApiFilledPeriods,
    },
  };
}

async function fetchPolymarketProfileOnce(
  walletOrSlug: string,
  options?: {
    pnlPeriods?: PolymarketProfileCurvePeriod[];
    skipPnlApi?: boolean;
    lightweightApiFallback?: boolean;
  }
): Promise<PolymarketProfileFetchResult> {
  if (options?.lightweightApiFallback) {
    return fetchPolymarketProfileFromApis(walletOrSlug, {
      pnlPeriods: ['ALL'],
      lightweight: true,
    });
  }

  const candidates = buildPolymarketProfileUrlCandidates(walletOrSlug);
  let lastParseMessage: string | null = null;

  for (const sourceUrl of candidates) {
    try {
      const res = await fetchTextWithTimeout(sourceUrl);
      if (!res.ok) {
        if (res.status === 404) {
          continue;
        }
        const text = await res.text().catch(() => '');
        throwProfileHttpError(res.status, text);
      }

      const html = await res.text();
      try {
        const parsed = parseProfileFromHtml(html, sourceUrl, walletOrSlug);
        return finalizeProfileResult(parsed, options);
      } catch (error) {
        if (error instanceof PolymarketProfileFetchError && error.kind === 'invalid') {
          throw error;
        }
        lastParseMessage = error instanceof Error ? error.message : String(error);
      }
    } catch (error) {
      if (error instanceof PolymarketProfileFetchError) {
        if (error.kind === 'invalid' || error.kind === 'not_found') {
          throw error;
        }
        if (error.kind === 'http' && error.status === 404) {
          continue;
        }
      }
      lastParseMessage = error instanceof Error ? error.message : String(error);
    }
  }

  try {
    return await fetchPolymarketProfileFromApis(walletOrSlug, options);
  } catch (apiError) {
    const apiMessage = apiError instanceof Error ? apiError.message : String(apiError);
    throw new PolymarketProfileFetchError(
      'parse',
      `Polymarket profile parse failed: ${lastParseMessage ?? 'NEXT_DATA marker not found'}; API fallback failed: ${apiMessage}`,
      { retryable: true }
    );
  }
}

export type FetchPolymarketProfileOptions = {
  /** 默认 CONFIG.smartMoneyProfileRetryMax；详情页 live 等交互场景可设为 1，避免多次超时累加 */
  retryMax?: number;
  /** 仅用于交互式详情页：短期复用同一份官网快照，避免切 1D/1W/1M/ALL 时反复请求上游 */
  cacheTtlMs?: number;
  /** 仅补全/升级指定周期的 user-pnl-api 曲线；未指定时补全 1D/1W/1M/ALL 四周期 */
  pnlPeriods?: PolymarketProfileCurvePeriod[];
  /** Light 快筛：跳过 user-pnl-api，仅 HTML 脱水字段 */
  skipPnlApi?: boolean;
  /**
   * Light 快筛专用：官网页面不再提供 __NEXT_DATA__ 时，跳过重复下载 HTML，
   * 直接用精简 API fallback（只取 Gate 所需字段和 ALL 曲线）。
   */
  lightweightApiFallback?: boolean;
};

/** Light 边界区：对已有 HTML profile 补 1W+ALL pnl-api */
export async function enrichPolymarketProfilePnlPeriods(
  profile: PolymarketProfileFetchResult,
  periods: PolymarketProfileCurvePeriod[] = ['1W', 'ALL']
): Promise<PolymarketProfileFetchResult> {
  return ensureProfilePnlPeriods(profile, periods);
}

const profileFetchCache = new Map<string, CachedPolymarketProfileEntry>();
const profileFetchInflight = new Map<string, Promise<PolymarketProfileFetchResult>>();

function profileHasPnlPeriod(profile: PolymarketProfileFetchResult, period: PolymarketProfileCurvePeriod): boolean {
  return profile.curves.some((point) => point.period === period);
}

async function ensureProfilePnlPeriods(
  profile: PolymarketProfileFetchResult,
  periods: PolymarketProfileCurvePeriod[]
): Promise<PolymarketProfileFetchResult> {
  const missing = periods.filter((period) => !profileHasPnlPeriod(profile, period));
  if (missing.length === 0) {
    return profile;
  }
  const pnlApiMerge = await mergeCurvesWithUserPnlApi(profile.wallet, profile.curves, { periods: missing });
  return {
    ...profile,
    curves: pnlApiMerge.curves,
    profilePnlApiFilledPeriods: [
      ...new Set([...profile.profilePnlApiFilledPeriods, ...pnlApiMerge.profilePnlApiFilledPeriods]),
    ],
    rawSummary: {
      ...profile.rawSummary,
      profilePnlApiFilledPeriods: [
        ...new Set([...profile.profilePnlApiFilledPeriods, ...pnlApiMerge.profilePnlApiFilledPeriods]),
      ],
    },
  };
}

export async function fetchPolymarketProfile(
  walletOrSlug: string,
  fetchOptions?: FetchPolymarketProfileOptions
): Promise<PolymarketProfileFetchResult> {
  const cacheKey = walletOrSlug.trim().toLowerCase();
  const cacheTtlMs = Math.max(0, fetchOptions?.cacheTtlMs ?? 0);
  const pnlPeriods = fetchOptions?.pnlPeriods;
  if (cacheTtlMs > 0) {
    const cached = profileFetchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (pnlPeriods?.length) {
        const enriched = await ensureProfilePnlPeriods(cached.value, pnlPeriods);
        if (enriched !== cached.value) {
          profileFetchCache.set(cacheKey, {
            expiresAt: cached.expiresAt,
            value: enriched,
          });
        }
        return enriched;
      }
      return cached.value;
    }
    const inflight = profileFetchInflight.get(cacheKey);
    if (inflight) {
      const result = await inflight;
      if (pnlPeriods?.length) {
        return ensureProfilePnlPeriods(result, pnlPeriods);
      }
      return result;
    }
  }

  const retryMax = fetchOptions?.retryMax ?? CONFIG.smartMoneyProfileRetryMax;
  const baseDelayMs = CONFIG.smartMoneyProfileRetryBaseDelayMs;
  const task = (async () => {
    let lastError: PolymarketProfileFetchError | null = null;

    for (let attempt = 1; attempt <= retryMax; attempt += 1) {
      try {
        const result = await fetchPolymarketProfileOnce(walletOrSlug, {
          pnlPeriods: fetchOptions?.pnlPeriods,
          skipPnlApi: fetchOptions?.skipPnlApi,
          lightweightApiFallback: fetchOptions?.lightweightApiFallback,
        });
        if (cacheTtlMs > 0) {
          profileFetchCache.set(cacheKey, {
            expiresAt: Date.now() + cacheTtlMs,
            value: result,
          });
        }
        return result;
      } catch (error) {
        const normalizedError = toFetchError(error);
        lastError = normalizedError;
        if (!normalizedError.retryable || attempt === retryMax) {
          throw normalizedError;
        }
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw (
      lastError ??
      new PolymarketProfileFetchError('network', 'Polymarket profile retry loop exhausted', {
        retryable: true,
      })
    );
  })();

  if (cacheTtlMs > 0) {
    profileFetchInflight.set(cacheKey, task);
  }

  try {
    return await task;
  } finally {
    if (cacheTtlMs > 0) {
      profileFetchInflight.delete(cacheKey);
    }
  }
}
