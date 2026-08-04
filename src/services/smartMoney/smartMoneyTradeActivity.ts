import {
  fetchDataApiTradesInWindow,
  fetchDataApiTradesInWindowExhaustive,
  normalizeTradeTimestampMs,
  type DataApiTrade,
} from '../polymarket/polymarketTrades';

export type SmartMoneyTradeActivityPeriod = '1D' | '1W' | '1M' | 'ALL';

export type SmartMoneyTradeActivityPoint = {
  date: string;
  ts: string;
  count: number;
  cumulative: number;
};

export type SmartMoneyTradeActivity = {
  period: SmartMoneyTradeActivityPeriod;
  windowStartTs: string;
  windowEndTs: string;
  tradeCount: number;
  lifetimeTradeCount: number | null;
  points: SmartMoneyTradeActivityPoint[];
  source: 'polymarket_data_api';
  truncated: boolean;
  fetchError: string | null;
};

/** 超过该跨度时不再按天填零，避免 ALL/超长窗口返回数万空点 */
export const MAX_DENSE_TRADE_SERIES_DAYS = 62;

function startOfUtcDayMs(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function addUtcDaysMs(ms: number, days: number): number {
  return ms + days * 24 * 60 * 60 * 1000;
}

function utcDaySpan(windowStartMs: number, windowEndMs: number): number {
  const start = startOfUtcDayMs(windowStartMs);
  const end = startOfUtcDayMs(windowEndMs);
  if (end < start) return 0;
  return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function buildSparseTradeActivitySeries(
  countsByDate: Map<string, number>
): SmartMoneyTradeActivityPoint[] {
  const dates = [...countsByDate.keys()].sort();
  const points: SmartMoneyTradeActivityPoint[] = [];
  let cumulative = 0;
  for (const date of dates) {
    const count = countsByDate.get(date) ?? 0;
    cumulative += count;
    points.push({
      date,
      ts: `${date}T00:00:00.000Z`,
      count,
      cumulative,
    });
  }
  return points;
}

/**
 * 成交笔数日序列。
 * - 短窗口（≤ MAX_DENSE_TRADE_SERIES_DAYS）默认按天填零，便于 1D/1W/1M 画连续图
 * - 长窗口 / fillEmptyDays=false：只返回有成交的日期（稀疏），避免 ALL 从 epoch 起铺数万空点
 */
export function buildTradeActivitySeries(
  trades: DataApiTrade[],
  windowStartMs: number,
  windowEndMs: number,
  options?: { fillEmptyDays?: boolean }
): SmartMoneyTradeActivityPoint[] {
  const countsByDate = new Map<string, number>();
  for (const trade of trades) {
    const tsMs = normalizeTradeTimestampMs(trade.timestamp);
    if (tsMs == null) continue;
    if (tsMs < windowStartMs || tsMs > windowEndMs) continue;
    const date = new Date(tsMs).toISOString().slice(0, 10);
    countsByDate.set(date, (countsByDate.get(date) ?? 0) + 1);
  }

  const spanDays = utcDaySpan(windowStartMs, windowEndMs);
  const fillEmptyDays =
    (options?.fillEmptyDays ?? true) && spanDays <= MAX_DENSE_TRADE_SERIES_DAYS;

  if (!fillEmptyDays) {
    return buildSparseTradeActivitySeries(countsByDate);
  }

  const points: SmartMoneyTradeActivityPoint[] = [];
  let cumulative = 0;
  let cursor = startOfUtcDayMs(windowStartMs);
  const end = startOfUtcDayMs(windowEndMs);

  while (cursor <= end) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    const count = countsByDate.get(date) ?? 0;
    cumulative += count;
    points.push({
      date,
      ts: `${date}T00:00:00.000Z`,
      count,
      cumulative,
    });
    cursor = addUtcDaysMs(cursor, 1);
  }

  return points;
}

export function resolveTradeActivityWindow1D(nowMs = Date.now()): {
  windowStartTs: string;
  windowEndTs: string;
} {
  const windowEndMs = nowMs;
  const windowStartMs = windowEndMs - 24 * 60 * 60 * 1000;
  return {
    windowStartTs: new Date(windowStartMs).toISOString(),
    windowEndTs: new Date(windowEndMs).toISOString(),
  };
}

/**
 * 成交笔数统计窗口：1D/1W/1M 用相对当前的滚动窗口（与官网「近 N 天」一致），
 * 不用曲线首尾时间——曲线点常为日切 00:00，会导致当日成交漏计为 0。
 * ALL 仍用 epoch→now 拉全量成交；响应序列在 buildTradeActivitySeries 中改为稀疏点。
 */
export function resolveTradeActivityWindow(
  period: SmartMoneyTradeActivityPeriod,
  _coverage: { startTs: string | null; endTs: string | null },
  nowMs = Date.now()
): { windowStartTs: string; windowEndTs: string } | null {
  const periodDays =
    period === '1D' ? 1 : period === '1W' ? 7 : period === '1M' ? 30 : null;
  if (periodDays != null) {
    const windowEndMs = nowMs;
    const windowStartMs = windowEndMs - periodDays * 24 * 60 * 60 * 1000;
    return {
      windowStartTs: new Date(windowStartMs).toISOString(),
      windowEndTs: new Date(windowEndMs).toISOString(),
    };
  }
  if (period === 'ALL') {
    return {
      windowStartTs: new Date(0).toISOString(),
      windowEndTs: new Date(nowMs).toISOString(),
    };
  }
  return null;
}

export function isHighTradeFrequency(
  tradesPerDay1D: number | null | undefined,
  maxTradesPerDay: number
): boolean {
  return tradesPerDay1D != null && tradesPerDay1D > maxTradesPerDay;
}

/** 30d 日均是否触达高频线（默认 500；现仅打软旗 HIGH_TRADE_FREQUENCY） */
export function isHardTradeFrequency30dAvg(
  trades30d: number | null | undefined,
  hardPerDay: number
): boolean {
  if (trades30d == null || !Number.isFinite(trades30d)) return false;
  return trades30d / 30 > hardPerDay;
}

/** 频率分层：hard 档 → HIGH_TRADE_FREQUENCY（软扣分）；elevated → ELEVATED 软罚 */
export function classifyTradeFrequency(input: {
  tradesPerDay1D?: number | null;
  trades30d?: number | null;
  softPerDay: number;
  hardPerDay: number;
}): 'hard' | 'elevated' | 'ok' {
  const avg30 =
    input.trades30d != null && Number.isFinite(input.trades30d) ? input.trades30d / 30 : null;
  if (avg30 != null && avg30 > input.hardPerDay) return 'hard';
  if (avg30 != null && avg30 > input.softPerDay) return 'elevated';
  const d1 = input.tradesPerDay1D;
  if (d1 != null && Number.isFinite(d1) && d1 > input.hardPerDay) return 'elevated';
  return 'ok';
}

export async function fetchTradesPerDay1D(
  wallet: string,
  lifetimeTradeCount: number | null = null
): Promise<number | null> {
  const window = resolveTradeActivityWindow1D();
  const activity = await buildSmartMoneyTradeActivity({
    wallet,
    period: '1D',
    windowStartTs: window.windowStartTs,
    windowEndTs: window.windowEndTs,
    lifetimeTradeCount,
  });
  if (activity.fetchError) {
    return null;
  }
  return activity.tradeCount;
}

export async function buildSmartMoneyTradeActivity(input: {
  wallet: string;
  period: SmartMoneyTradeActivityPeriod;
  windowStartTs: string;
  windowEndTs: string;
  lifetimeTradeCount: number | null;
}): Promise<SmartMoneyTradeActivity> {
  const windowStartMs = Date.parse(input.windowStartTs);
  const windowEndMs = Date.parse(input.windowEndTs);

  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs < windowStartMs) {
    return {
      period: input.period,
      windowStartTs: input.windowStartTs,
      windowEndTs: input.windowEndTs,
      tradeCount: 0,
      lifetimeTradeCount: input.lifetimeTradeCount,
      points: [],
      source: 'polymarket_data_api',
      truncated: false,
      fetchError: 'invalid_trade_window',
    };
  }

  try {
    // ALL 可能远超 offset=3000，需按时间窗穷尽；短周期窗口内通常 <3000，单次即可
    const fetchTrades =
      input.period === 'ALL' ? fetchDataApiTradesInWindowExhaustive : fetchDataApiTradesInWindow;
    const { trades, truncated } = await fetchTrades(input.wallet, windowStartMs, windowEndMs, {
      takerOnly: false,
    });
    const points = buildTradeActivitySeries(trades, windowStartMs, windowEndMs, {
      fillEmptyDays: input.period !== 'ALL',
    });

    return {
      period: input.period,
      // 稀疏序列时窗口起点对齐首笔成交日，避免对外暴露 epoch
      windowStartTs: points[0]?.ts ?? input.windowStartTs,
      windowEndTs: input.windowEndTs,
      tradeCount: trades.length,
      lifetimeTradeCount: input.lifetimeTradeCount,
      points,
      source: 'polymarket_data_api',
      truncated,
      fetchError: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'trade_fetch_failed';
    return {
      period: input.period,
      windowStartTs: input.windowStartTs,
      windowEndTs: input.windowEndTs,
      tradeCount: 0,
      lifetimeTradeCount: input.lifetimeTradeCount,
      points: [],
      source: 'polymarket_data_api',
      truncated: false,
      fetchError: message,
    };
  }
}
