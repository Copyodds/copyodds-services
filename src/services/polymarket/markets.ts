/**
 * Polymarket Gamma API 市场数据
 * API: https://gamma-api.polymarket.com/markets
 */

import { CONFIG } from '../../config/env';
import { polymarketApiSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';

const GAMMA_MARKETS_URL = 'https://gamma-api.polymarket.com/markets';
const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';

/** 市场条目（与 Gamma API 返回字段对齐，仅列常用字段） */
export interface PolymarketMarket {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    endDate: string;
    category?: string;
    liquidity: string;
    volume: string;
    active: boolean;
    closed: boolean;
    marketType: string;
    outcomes: string;
    outcomePrices: string;
    description?: string;
    image?: string;
    icon?: string;
    volumeNum?: number;
    liquidityNum?: number;
    endDateIso?: string;
    clobTokenIds?: string;
    events?: PolymarketEvent[];
    [key: string]: unknown;
}

export interface PolymarketEvent {
    id: string;
    ticker?: string;
    slug?: string;
    title?: string;
    description?: string;
    startDate?: string;
    endDate?: string;
    [key: string]: unknown;
}

/** Gamma GET /events 单条：含嵌套 markets（与官网「事件」一致） */
export interface PolymarketGammaEventRow {
    id: string;
    ticker?: string;
    slug?: string;
    title?: string;
    description?: string;
    markets?: PolymarketMarket[];
    [key: string]: unknown;
}

export interface GetEventsOptions {
    limit?: number;
    offset?: number;
    closed?: boolean;
}

export interface GetMarketsOptions {
    limit?: number;
    offset?: number;
    closed?: boolean;
    active?: boolean;
    endDateMin?: string; // ISO 字符串
    endDateMax?: string;
    order?: string;      // e.g. 'volume_num'
    ascending?: boolean; // true/false
}

/**
 * 从 Polymarket Gamma API 拉取市场列表（支持 limit/offset）
 */
export async function getMarkets(options: GetMarketsOptions = {}): Promise<PolymarketMarket[]> {
    const params = new URLSearchParams();
    if (options.limit != null) params.set('limit', String(options.limit));
    if (options.offset != null) params.set('offset', String(options.offset));
    if (options.closed != undefined) params.set('closed', String(options.closed));
    if (options.endDateMin) params.set('end_date_min', options.endDateMin);
    if (options.endDateMax) params.set('end_date_max', options.endDateMax);
    if (options.order) params.set('order', options.order);
    if (options.ascending != undefined) params.set('ascending', String(options.ascending));
    const url = params.toString()
        ? `${GAMMA_MARKETS_URL}?${params}`
        : GAMMA_MARKETS_URL;
    const res = await safeFetch(url, { headers: { Accept: 'application/json' } }, polymarketApiSafeFetchOptions());

    if (!res.ok) {
        throw new Error(`Polymarket API ${res.status}: ${await res.text()}`);
    }

    let data = (await res.json()) as PolymarketMarket[];
    if (!Array.isArray(data)) data = [];

    if (options.closed === false) {
        data = data.filter((m) => !m.closed);
    }
    if (options.active === true) {
        data = data.filter((m) => m.active);
    }

    const limit = options.limit ?? 0;
    return limit > 0 ? data.slice(0, limit) : data;
}

/**
 * Gamma API 事件列表（含 markets[]，用于 CLOB tokenId）
 * @see https://gamma-api.polymarket.com/events
 */
export async function getEvents(options: GetEventsOptions = {}): Promise<PolymarketGammaEventRow[]> {
    const params = new URLSearchParams();
    if (options.limit != null) params.set('limit', String(options.limit));
    if (options.offset != null) params.set('offset', String(options.offset));
    if (options.closed !== undefined) params.set('closed', String(options.closed));
    const url = params.toString() ? `${GAMMA_EVENTS_URL}?${params}` : GAMMA_EVENTS_URL;
    const res = await safeFetch(url, { headers: { Accept: 'application/json' } }, polymarketApiSafeFetchOptions());
    if (!res.ok) {
        throw new Error(`Polymarket Gamma events ${res.status}: ${await res.text()}`);
    }
    let data = (await res.json()) as PolymarketGammaEventRow[];
    if (!Array.isArray(data)) data = [];
    return data;
}

/** 从用户问题中提取用于匹配市场的关键词（去掉常见停用词，保留主题词） */
function extractSearchKeywords(query: string): string[] {
    const stop = new Set([
        '的', '了', '和', '是', '在', '有', '什么', '哪些', '怎么', '如何', '吗', '呢', '相关', '有关',
        'the', 'a', 'an', 'is', 'are', 'what', 'which', 'how', 'to', 'for', 'on', 'at', 'market', 'markets',
    ]);
    const raw = query
        .replace(/[？?！!，,。、\s]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 0);
    const keywords: string[] = [];
    for (const w of raw) {
        const lower = w.toLowerCase();
        if (w.length >= 2 && !stop.has(w) && !stop.has(lower)) {
            keywords.push(w);
        }
    }
    return keywords.length > 0 ? keywords : [query.trim()].filter(Boolean);
}

/**
 * 按用户问题关键词筛选市场（匹配 question、description、events[].title）
 */
export function filterMarketsByQuery(markets: PolymarketMarket[], query: string): PolymarketMarket[] {
    const keywords = extractSearchKeywords(query);
    if (keywords.length === 0) return markets;
    return markets.filter((m) => {
        const text = [
            m.question,
            m.description,
            ...(m.events ?? []).map((e) => e.title ?? e.ticker ?? '').filter(Boolean),
        ]
            .join(' ')
            .toLowerCase();
        return keywords.some((k) => text.includes(k.toLowerCase()));
    });
}

/**
 * 将市场列表格式化为给 LLM 的简要摘要（控制长度）
 */
export function formatMarketsSummary(markets: PolymarketMarket[], maxItems = 20): string {
    const slice = markets.slice(0, maxItems);
    const lines = slice.map((m) => {
        const prices = parseOutcomePrices(m.outcomePrices);
        const outcomes = parseOutcomes(m.outcomes);
        const priceStr = outcomes.length && prices.length
            ? outcomes.map((o, i) => `${o}:${prices[i] ?? '?'}`).join(' ')
            : m.outcomePrices;
        return `- ${m.question} | ${priceStr} | vol:${m.volume} | ${m.closed ? 'closed' : 'open'}`;
    });
    return lines.join('\n');
}

function parseOutcomes(outcomes: string): string[] {
    try {
        const arr = JSON.parse(outcomes) as unknown;
        return Array.isArray(arr) ? arr.map(String) : [outcomes];
    } catch {
        return [outcomes];
    }
}

function parseOutcomePrices(outcomePrices: string): string[] {
    try {
        const arr = JSON.parse(outcomePrices) as unknown;
        return Array.isArray(arr) ? arr.map(String) : [outcomePrices];
    } catch {
        return [outcomePrices];
    }
}

function parseJsonStringArray(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    try {
        const arr = JSON.parse(raw) as unknown;
        return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
        return [];
    }
}

function nonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function firstEventTitle(m: PolymarketMarket): string | null {
    for (const event of m.events ?? []) {
        const title = nonEmptyString(event.title);
        if (title) return title;
    }
    return null;
}

export interface PolymarketTokenMarketMetadata {
    /** Gamma 解析的「问题 · 结果」短文案 */
    marketLabel: string | null;
    /** 市场问题标题 */
    title: string | null;
    /** 所属事件标题 */
    eventTitle: string | null;
    /** Gamma market.category，例：Sports / Politics / Crypto */
    category: string | null;
    question: string | null;
    outcome: string | null;
    /** Gamma market.volumeNum 或解析后的累计成交量（USD） */
    volumeNum: number | null;
}

/**
 * 从 Gamma `/markets` 返回体构建 CLOB tokenId -> 「问题 · 结果」短文案
 */
export function buildClobTokenIdLabelMap(markets: PolymarketMarket[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of markets) {
        if (!m || typeof m !== 'object') continue;
        const qRaw = String(m.question ?? '').trim() || `Market ${m.id ?? ''}`;
        const shortQ = qRaw.length > 48 ? `${qRaw.slice(0, 45)}…` : qRaw;
        const tokenIds = parseJsonStringArray(
            typeof m.clobTokenIds === 'string' ? m.clobTokenIds : undefined
        );
        const outcomes = parseJsonStringArray(typeof m.outcomes === 'string' ? m.outcomes : undefined);
        const n = Math.min(tokenIds.length, outcomes.length);
        for (let i = 0; i < n; i++) {
            const tid = tokenIds[i];
            if (tid && !map.has(tid)) {
                map.set(tid, `${shortQ} · ${outcomes[i] ?? '?'}`);
            }
        }
        for (const tid of tokenIds) {
            if (tid && !map.has(tid)) {
                map.set(tid, shortQ);
            }
        }
    }
    return map;
}

/**
 * 从 Gamma `/markets` 返回体构建 CLOB tokenId -> 市场/事件展示元数据
 */
export function buildClobTokenIdMarketMetadataMap(
    markets: PolymarketMarket[]
): Map<string, PolymarketTokenMarketMetadata> {
    const map = new Map<string, PolymarketTokenMarketMetadata>();
    for (const m of markets) {
        if (!m || typeof m !== 'object') continue;
        const question = nonEmptyString(m.question);
        const qRaw = question ?? `Market ${m.id ?? ''}`;
        const shortQ = qRaw.length > 48 ? `${qRaw.slice(0, 45)}…` : qRaw;
        const eventTitle = firstEventTitle(m);
        const tokenIds = parseJsonStringArray(
            typeof m.clobTokenIds === 'string' ? m.clobTokenIds : undefined
        );
        const outcomes = parseJsonStringArray(typeof m.outcomes === 'string' ? m.outcomes : undefined);

        for (let i = 0; i < tokenIds.length; i++) {
            const tid = tokenIds[i];
            if (!tid || map.has(tid)) continue;
            const outcome = nonEmptyString(outcomes[i]);
            const volumeNum =
                typeof m.volumeNum === 'number' && Number.isFinite(m.volumeNum)
                    ? m.volumeNum
                    : (() => {
                          const parsed = Number(m.volume);
                          return Number.isFinite(parsed) ? parsed : null;
                      })();
            map.set(tid, {
                marketLabel: outcome ? `${shortQ} · ${outcome}` : shortQ,
                title: question,
                eventTitle,
                category: nonEmptyString(m.category),
                question,
                outcome,
                volumeNum,
            });
        }
    }
    return map;
}

const GAMMA_CLOB_TOKEN_BATCH = 25;

const gammaTokenLabelCache = new Map<string, string>();
const gammaTokenLabelCacheExp = new Map<string, number>();
const gammaTokenMarketMetadataCache = new Map<string, PolymarketTokenMarketMetadata>();
const gammaTokenMarketMetadataCacheExp = new Map<string, number>();
/** 仅当 Gamma 成功响应但 token 确实不存在时才短期跳过重试；网络失败不写 miss。 */
const gammaTokenMarketMetadataMissExp = new Map<string, number>();
const GAMMA_LABEL_CACHE_MS = 60 * 60 * 1000;
const GAMMA_FETCH_TIMEOUT_MS = 5_000;
const GAMMA_METADATA_MISS_CACHE_MS = 60 * 1000;

type GammaMarketsFetchResult = {
    markets: PolymarketMarket[];
    /** 至少有一次 HTTP 200；用于区分「查无此 token」与「请求失败」 */
    fetched: boolean;
};

function buildGammaArrayQueryVariants(
    paramName: string,
    values: string[],
    limit: number
): URLSearchParams[] {
    const variants: URLSearchParams[] = [];

    const repeated = new URLSearchParams();
    for (const value of values) repeated.append(paramName, value);
    repeated.set('limit', String(limit));
    variants.push(repeated);

    const comma = new URLSearchParams();
    comma.set(paramName, values.join(','));
    comma.set('limit', String(limit));
    variants.push(comma);

    const bracket = new URLSearchParams();
    for (const value of values) bracket.append(`${paramName}[]`, value);
    bracket.set('limit', String(limit));
    variants.push(bracket);

    return variants;
}

async function fetchGammaMarketsWithQueryVariants(
    variants: URLSearchParams[],
    options: { timeoutMs?: number } = {}
): Promise<GammaMarketsFetchResult> {
    let fetched = false;
    for (const params of variants) {
        const url = `${GAMMA_MARKETS_URL}?${params.toString()}`;
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            Math.max(500, options.timeoutMs ?? GAMMA_FETCH_TIMEOUT_MS)
        );
        try {
            const res = await safeFetch(
                url,
                { headers: { Accept: 'application/json' }, signal: controller.signal },
                polymarketApiSafeFetchOptions()
            );
            if (!res.ok) continue;
            fetched = true;
            const data = (await res.json()) as PolymarketMarket[];
            const arr = Array.isArray(data) ? data : [];
            if (arr.length > 0) return { markets: arr, fetched: true };
        } catch {
            continue;
        } finally {
            clearTimeout(timeout);
        }
    }

    return { markets: [], fetched };
}

async function fetchGammaMarketsForClobTokenChunk(
    chunk: string[],
    options: { timeoutMs?: number } = {}
): Promise<GammaMarketsFetchResult> {
    const limit = Math.min(100, chunk.length + 10);
    return fetchGammaMarketsWithQueryVariants(
        buildGammaArrayQueryVariants('clob_token_ids', chunk, limit),
        options
    );
}

async function fetchGammaMarketsForConditionIds(
    conditionIds: string[],
    options: { timeoutMs?: number } = {}
): Promise<GammaMarketsFetchResult> {
    const limit = Math.min(100, conditionIds.length + 10);
    return fetchGammaMarketsWithQueryVariants(
        buildGammaArrayQueryVariants('condition_ids', conditionIds, limit),
        options
    );
}

type ClobMarketByTokenResponse = {
    condition_id?: string;
};

type ClobMarketToken = {
    token_id?: string;
    outcome?: string;
    t?: string;
    o?: string;
};

type ClobMarketDetails = {
    question?: string;
    market_slug?: string;
    tokens?: ClobMarketToken[];
    [key: string]: unknown;
};

export async function resolveConditionIdForClobToken(
    tokenId: string,
    options: { timeoutMs?: number } = {}
): Promise<string | null> {
    const tid = tokenId.trim();
    if (!tid) return null;
    const { data } = await clobFetchJson<ClobMarketByTokenResponse>(
        `/markets-by-token/${encodeURIComponent(tid)}`,
        options
    );
    const conditionId = data?.condition_id?.trim();
    return conditionId ? conditionId.toLowerCase() : null;
}

async function clobFetchJson<T>(
    path: string,
    options: { timeoutMs?: number } = {}
): Promise<{ data: T | null; fetched: boolean }> {
    const base = CONFIG.clobHost.replace(/\/$/, '');
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        Math.max(500, options.timeoutMs ?? GAMMA_FETCH_TIMEOUT_MS)
    );
    try {
        const res = await safeFetch(
            url,
            { headers: { Accept: 'application/json' }, signal: controller.signal },
            polymarketApiSafeFetchOptions()
        );
        if (!res.ok) return { data: null, fetched: false };
        return { data: (await res.json()) as T, fetched: true };
    } catch {
        return { data: null, fetched: false };
    } finally {
        clearTimeout(timeout);
    }
}

function metadataFromClobMarketDetails(
    tokenId: string,
    details: ClobMarketDetails
): PolymarketTokenMarketMetadata | null {
    const question = nonEmptyString(details.question);
    const qRaw = question ?? nonEmptyString(details.market_slug as string | undefined);
    if (!qRaw) return null;
    const shortQ = qRaw.length > 48 ? `${qRaw.slice(0, 45)}…` : qRaw;
    const tokens = Array.isArray(details.tokens) ? details.tokens : [];
    for (const token of tokens) {
        const tid = nonEmptyString(token.token_id) ?? nonEmptyString(token.t);
        if (tid !== tokenId) continue;
        const outcome = nonEmptyString(token.outcome) ?? nonEmptyString(token.o);
        return {
            marketLabel: outcome ? `${shortQ} · ${outcome}` : shortQ,
            title: question,
            eventTitle: question,
            category: null,
            question,
            outcome,
            volumeNum: null,
        };
    }
    return {
        marketLabel: shortQ,
        title: question,
        eventTitle: question,
        category: null,
        question,
        outcome: null,
        volumeNum: null,
    };
}

async function fetchClobFallbackMetadataForTokenIds(
    tokenIds: string[],
    options: { timeoutMs?: number } = {}
): Promise<Map<string, PolymarketTokenMarketMetadata>> {
    const out = new Map<string, PolymarketTokenMarketMetadata>();
    const tokenToCondition = new Map<string, string>();

    for (const tokenId of tokenIds) {
        const { data } = await clobFetchJson<ClobMarketByTokenResponse>(
            `/markets-by-token/${encodeURIComponent(tokenId)}`,
            options
        );
        const conditionId = data?.condition_id?.trim();
        if (conditionId) {
            tokenToCondition.set(tokenId, conditionId);
        }
    }

    const conditionIds = [...new Set(tokenToCondition.values())];
    if (conditionIds.length) {
        const { markets, fetched } = await fetchGammaMarketsForConditionIds(conditionIds, options);
        if (markets.length) {
            const chunkMap = buildClobTokenIdMarketMetadataMap(markets);
            for (const tokenId of tokenIds) {
                if (out.has(tokenId)) continue;
                const meta = chunkMap.get(tokenId);
                if (meta) out.set(tokenId, meta);
            }
        } else if (fetched) {
            for (const [tokenId, conditionId] of tokenToCondition) {
                if (out.has(tokenId)) continue;
                const details = await clobFetchJson<ClobMarketDetails>(
                    `/clob-markets/${encodeURIComponent(conditionId)}`,
                    options
                );
                if (!details.data) continue;
                const meta = metadataFromClobMarketDetails(tokenId, details.data);
                if (meta) out.set(tokenId, meta);
            }
        }
    }

    return out;
}

/**
 * 调用 Gamma `GET /markets?clob_token_ids=...` 批量解析 outcome tokenId 的展示名。
 */
export async function fetchGammaLabelsForClobTokenIds(
    tokenIds: string[]
): Promise<Map<string, string>> {
    const uniq = [...new Set(tokenIds.map((t) => t.trim()).filter(Boolean))].filter((t) =>
        /^\d+$/.test(t)
    );
    if (uniq.length === 0) {
        return new Map();
    }

    const now = Date.now();
    const out = new Map<string, string>();
    const needFetch: string[] = [];
    for (const tid of uniq) {
        const exp = gammaTokenLabelCacheExp.get(tid) ?? 0;
        const cached = gammaTokenLabelCache.get(tid);
        if (cached && exp > now) {
            out.set(tid, cached);
        } else {
            needFetch.push(tid);
        }
    }

    for (let i = 0; i < needFetch.length; i += GAMMA_CLOB_TOKEN_BATCH) {
        const chunk = needFetch.slice(i, i + GAMMA_CLOB_TOKEN_BATCH);
        const { markets: arr } = await fetchGammaMarketsForClobTokenChunk(chunk);
        const chunkMap = buildClobTokenIdLabelMap(arr);
        const expAt = Date.now() + GAMMA_LABEL_CACHE_MS;
        for (const tid of chunk) {
            const v = chunkMap.get(tid);
            if (v) {
                gammaTokenLabelCache.set(tid, v);
                gammaTokenLabelCacheExp.set(tid, expAt);
                out.set(tid, v);
            }
        }
    }
    return out;
}

/**
 * 调用 Gamma `GET /markets?clob_token_ids=...` 批量解析 outcome tokenId 的市场/事件元数据。
 */
export async function fetchGammaMarketMetadataForClobTokenIds(
    tokenIds: string[],
    options: { forceRefresh?: boolean; timeoutMs?: number } = {}
): Promise<Map<string, PolymarketTokenMarketMetadata>> {
    const uniq = [...new Set(tokenIds.map((t) => t.trim()).filter(Boolean))].filter((t) =>
        /^\d+$/.test(t)
    );
    if (uniq.length === 0) {
        return new Map();
    }

    const now = Date.now();
    const out = new Map<string, PolymarketTokenMarketMetadata>();
    const needFetch: string[] = [];
    for (const tid of uniq) {
        const hitExp = gammaTokenMarketMetadataCacheExp.get(tid) ?? 0;
        const cached = gammaTokenMarketMetadataCache.get(tid);
        if (cached && hitExp > now) {
            out.set(tid, cached);
            continue;
        }
        const missExp = gammaTokenMarketMetadataMissExp.get(tid) ?? 0;
        if (!options.forceRefresh && missExp > now) {
            continue;
        }
        needFetch.push(tid);
    }

    for (let i = 0; i < needFetch.length; i += GAMMA_CLOB_TOKEN_BATCH) {
        const chunk = needFetch.slice(i, i + GAMMA_CLOB_TOKEN_BATCH);
        const { markets: arr, fetched } = await fetchGammaMarketsForClobTokenChunk(chunk, {
            timeoutMs: options.timeoutMs,
        });
        const chunkMap = buildClobTokenIdMarketMetadataMap(arr);
        const hitExpAt = Date.now() + GAMMA_LABEL_CACHE_MS;
        const missExpAt = Date.now() + GAMMA_METADATA_MISS_CACHE_MS;
        for (const tid of chunk) {
            const v = chunkMap.get(tid);
            if (v) {
                gammaTokenMarketMetadataCache.set(tid, v);
                gammaTokenMarketMetadataCacheExp.set(tid, hitExpAt);
                gammaTokenMarketMetadataMissExp.delete(tid);
                if (v.marketLabel) {
                    gammaTokenLabelCache.set(tid, v.marketLabel);
                    gammaTokenLabelCacheExp.set(tid, hitExpAt);
                }
                out.set(tid, v);
            } else if (fetched) {
                gammaTokenMarketMetadataMissExp.set(tid, missExpAt);
            }
        }
    }
    return out;
}

/**
 * Gamma + CLOB 回退：先 clob_token_ids 查 Gamma，缺失时经 CLOB condition_id 再查。
 */
export async function fetchMarketMetadataForClobTokenIds(
    tokenIds: string[],
    options: { forceRefresh?: boolean; timeoutMs?: number } = {}
): Promise<Map<string, PolymarketTokenMarketMetadata>> {
    const gamma = await fetchGammaMarketMetadataForClobTokenIds(tokenIds, options);
    const missing = [...new Set(tokenIds.map((t) => t.trim()).filter(Boolean))].filter(
        (tid) => /^\d+$/.test(tid) && !gamma.has(tid)
    );
    if (!missing.length) return gamma;

    const clob = await fetchClobFallbackMetadataForTokenIds(missing, options);
    for (const [tid, meta] of clob) {
        gamma.set(tid, meta);
        const hitExpAt = Date.now() + GAMMA_LABEL_CACHE_MS;
        gammaTokenMarketMetadataCache.set(tid, meta);
        gammaTokenMarketMetadataCacheExp.set(tid, hitExpAt);
        gammaTokenMarketMetadataMissExp.delete(tid);
        if (meta.marketLabel) {
            gammaTokenLabelCache.set(tid, meta.marketLabel);
            gammaTokenLabelCacheExp.set(tid, hitExpAt);
        }
    }
    return gamma;
}
