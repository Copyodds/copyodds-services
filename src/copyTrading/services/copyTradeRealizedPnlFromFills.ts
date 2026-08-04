import type { CopyExecution, CopyTradeRow, LeaderTrade } from '../../generated/prisma/client';
import { Prisma } from '../../generated/prisma/client';
import { CopyTradeStatus } from '../../generated/prisma/enums';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { logger } from '../../utils/logger';
import { getPnlDayWindowStartUtc } from './pnlDayWindow';
import {
  ensureCopyPnlSummaryLedgerSyncedForUser,
  readCopyPnlSummaryForUser,
  type CopyPnlSummaryResult,
} from './copyPnlSummaryLedger';

export type { CopyPnlSummaryResult as PnlSummaryResult };
export {
  rebuildCopyPnlSummaryFromAggregatesForUser,
  ensureCopyPnlSummaryLedgerSyncedForUser,
} from './copyPnlSummaryLedger';

const SIZE_EPS = 1e-9;
/** 历史 FIFO 回退上限，防止全量 findMany 撑爆堆内存 */
const HISTORICAL_FIFO_MAX_ROWS = 5000;

const FILLED_LEGACY_STATUSES = ['filled', 'Filled', 'FILLED'] as const;

const COPY_TRADE_FILL_SELECT = {
  id: true,
  userId: true,
  status: true,
  intendedPrice: true,
  intendedSize: true,
  polymarketOrderId: true,
  createdAt: true,
  updatedAt: true,
  leaderTrade: {
    select: {
      leaderAddress: true,
      side: true,
      amount: true,
      price: true,
      tokenId: true,
      blockNumber: true,
      logIndex: true,
    },
  },
} as const;

const LEGACY_EXECUTION_FILL_SELECT = {
  id: true,
  followerUserId: true,
  leaderAddress: true,
  tokenID: true,
  side: true,
  price: true,
  size: true,
  polymarketOrderId: true,
  createdAt: true,
  status: true,
} as const;

type CopyTradeFillRow = CopyTradeRow & {
  leaderTrade: Pick<
    LeaderTrade,
    'leaderAddress' | 'side' | 'amount' | 'price' | 'tokenId' | 'blockNumber' | 'logIndex'
  >;
};

type LegacyExecutionFillRow = Pick<
  CopyExecution,
  | 'id'
  | 'followerUserId'
  | 'leaderAddress'
  | 'tokenID'
  | 'side'
  | 'price'
  | 'size'
  | 'polymarketOrderId'
  | 'createdAt'
  | 'status'
>;

type FillEvent = {
  executionKey: string;
  dedupeKey: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  /** 用于「今日收益」归属：成交行更新时间（事件驱动）或 legacy 创建时间 */
  pnlAttributionAt: Date;
  /** 同 token 内排序：链上序优先，否则退化为时间戳 */
  sortParts: readonly [number, number, number, string];
};

function normSide(raw: string): 'BUY' | 'SELL' {
  return raw.trim().toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
}

function normalizeSecond(ts: Date): string {
  return new Date(Math.floor(ts.getTime() / 1000) * 1000).toISOString();
}

function fillDedupeKey(parts: {
  userId: number;
  leaderAddress: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderId?: string | null;
  createdAt: Date;
}): string {
  return [
    parts.userId,
    parts.leaderAddress.trim().toLowerCase(),
    parts.tokenId.trim().toLowerCase(),
    parts.side,
    parts.price.toFixed(8),
    parts.size.toFixed(8),
    parts.orderId ?? '',
    normalizeSecond(parts.createdAt),
  ].join('|');
}

function copyTradeRowToFill(row: CopyTradeFillRow): FillEvent | null {
  if (row.status !== CopyTradeStatus.filled) return null;
  const lt = row.leaderTrade;
  const price = parseFloat(row.intendedPrice ?? lt.price) || 0;
  const size = parseFloat(row.intendedSize ?? lt.amount) || 0;
  if (!(size > SIZE_EPS) || !(price >= 0)) return null;
  const side = normSide(lt.side);
  const bn = lt.blockNumber ?? 0;
  return {
    tokenId: lt.tokenId.trim().toLowerCase(),
    executionKey: `copy:${row.id}`,
    dedupeKey: fillDedupeKey({
      userId: row.userId,
      leaderAddress: lt.leaderAddress,
      tokenId: lt.tokenId,
      side,
      price,
      size,
      orderId: row.polymarketOrderId,
      createdAt: row.createdAt,
    }),
    side,
    price,
    size,
    pnlAttributionAt: row.updatedAt,
    sortParts: [row.updatedAt.getTime(), bn, lt.logIndex, row.id],
  };
}

function legacyExecutionToFill(e: LegacyExecutionFillRow): FillEvent | null {
  if (e.status.trim().toLowerCase() !== 'filled') return null;
  const price = parseFloat(e.price.toString()) || 0;
  const size = parseFloat(e.size.toString()) || 0;
  if (!(size > SIZE_EPS) || !(price >= 0)) return null;
  const side = normSide(e.side);
  return {
    tokenId: e.tokenID.trim().toLowerCase(),
    executionKey: `legacy:${e.id}`,
    dedupeKey: fillDedupeKey({
      userId: e.followerUserId,
      leaderAddress: e.leaderAddress,
      tokenId: e.tokenID,
      side,
      price,
      size,
      orderId: e.polymarketOrderId,
      createdAt: e.createdAt,
    }),
    side,
    price,
    size,
    pnlAttributionAt: e.createdAt,
    // 与链上 leader 行交错时：无 block 信息时用时间戳；首项 0 保证与 bn=0 的 leader 行按 logIndex/时间再比
    sortParts: [e.createdAt.getTime(), 0, 0, e.id],
  };
}

function compareFills(a: FillEvent, b: FillEvent): number {
  const [a0, a1, a2, a3] = a.sortParts;
  const [b0, b1, b2, b3] = b.sortParts;
  if (a0 !== b0) return a0 - b0;
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3.localeCompare(b3);
}

type Lot = { size: number; unitPrice: number };

export type ExecutionPnlDetail = {
  realizedPnlUsd: string;
  entryAvgPrice: string;
  exitPrice: string;
  closedSize: string;
  costBasisUsd: string;
  proceedsUsd: string;
};

export type OpenPositionPnlDetail = {
  entryAvgPrice: string;
  openSize: string;
  costBasisUsd: string;
};

type ExecutionPnlDetailNum = {
  realizedPnlUsd: number;
  entryAvgPrice: number;
  exitPrice: number;
  closedSize: number;
  costBasisUsd: number;
  proceedsUsd: number;
};

function decimalString(value: number): string {
  return new Prisma.Decimal(value.toFixed(8)).toString();
}

function stringifyExecutionPnlDetail(detail: ExecutionPnlDetailNum): ExecutionPnlDetail {
  return {
    realizedPnlUsd: decimalString(detail.realizedPnlUsd),
    entryAvgPrice: decimalString(detail.entryAvgPrice),
    exitPrice: decimalString(detail.exitPrice),
    closedSize: decimalString(detail.closedSize),
    costBasisUsd: decimalString(detail.costBasisUsd),
    proceedsUsd: decimalString(detail.proceedsUsd),
  };
}

export type AggregateRealizedPnlOptions = {
  now?: Date;
  /** 今日收益窗口起点（含）；默认按 CONFIG 时区与每日 resetHour 计算 */
  todayWindowStart?: Date;
};

/**
 * 按 outcome token 维度 FIFO：卖出匹配最早买入成本，累计已实现盈亏（USD，与列表展示价量口径一致）。
 * `todayPnl`：自 `todayWindowStart` 起平仓产生的已实现盈亏（默认每日 resetHour 起算）。
 */
export function aggregateRealizedPnlFromFillEvents(
  fills: FillEvent[],
  options: AggregateRealizedPnlOptions = {}
): {
  total: Prisma.Decimal;
  todayPnl: Prisma.Decimal;
  todayWindowStart: Date;
  byExecutionKey: Map<string, Prisma.Decimal>;
  detailByExecutionKey: Map<string, ExecutionPnlDetail>;
  openCostByToken: Map<string, Prisma.Decimal>;
  openPositionByToken: Map<string, OpenPositionPnlDetail>;
} {
  const now = options.now ?? new Date();
  const todayWindowStart =
    options.todayWindowStart ??
    getPnlDayWindowStartUtc(now, CONFIG.copyPnlDayTimezone, CONFIG.copyPnlDayResetHour);
  const todayCutoffMs = todayWindowStart.getTime();
  const byToken = new Map<string, FillEvent[]>();
  const seen = new Set<string>();
  for (const f of fills) {
    if (seen.has(f.dedupeKey)) continue;
    seen.add(f.dedupeKey);
    const list = byToken.get(f.tokenId);
    if (list) list.push(f);
    else byToken.set(f.tokenId, [f]);
  }

  let totalNum = 0;
  let todayPnlNum = 0;
  const byExecutionKey = new Map<string, Prisma.Decimal>();
  const detailByExecutionKey = new Map<string, ExecutionPnlDetail>();
  const openCostByToken = new Map<string, Prisma.Decimal>();
  const openPositionByToken = new Map<string, OpenPositionPnlDetail>();

  for (const [tokenId, events] of byToken) {
    events.sort(compareFills);
    const lots: Lot[] = [];

    for (const ev of events) {
      if (ev.side === 'BUY') {
        lots.push({ size: ev.size, unitPrice: ev.price });
        continue;
      }

      let rem = ev.size;
      let rowPnl = 0;
      let matchedSize = 0;
      let costBasis = 0;
      while (rem > SIZE_EPS && lots.length > 0) {
        const lot = lots[0]!;
        const take = Math.min(rem, lot.size);
        rowPnl += take * (ev.price - lot.unitPrice);
        matchedSize += take;
        costBasis += take * lot.unitPrice;
        lot.size -= take;
        rem -= take;
        if (lot.size <= SIZE_EPS) lots.shift();
      }

      if (ev.side === 'SELL') {
        totalNum += rowPnl;
        byExecutionKey.set(ev.executionKey, new Prisma.Decimal(rowPnl.toFixed(8)));
        if (matchedSize > SIZE_EPS) {
          detailByExecutionKey.set(
            ev.executionKey,
            stringifyExecutionPnlDetail({
              realizedPnlUsd: rowPnl,
              entryAvgPrice: costBasis / matchedSize,
              exitPrice: ev.price,
              closedSize: matchedSize,
              costBasisUsd: costBasis,
              proceedsUsd: matchedSize * ev.price,
            })
          );
        }
        if (ev.pnlAttributionAt.getTime() >= todayCutoffMs) {
          todayPnlNum += rowPnl;
        }
      }
    }

    const openCost = lots.reduce((sum, lot) => sum + lot.size * lot.unitPrice, 0);
    const openSize = lots.reduce((sum, lot) => sum + lot.size, 0);
    if (openCost > SIZE_EPS) {
      openCostByToken.set(tokenId, new Prisma.Decimal(openCost.toFixed(8)));
      openPositionByToken.set(tokenId, {
        entryAvgPrice: decimalString(openSize > SIZE_EPS ? openCost / openSize : 0),
        openSize: decimalString(openSize),
        costBasisUsd: decimalString(openCost),
      });
    }
  }

  return {
    total: new Prisma.Decimal(totalNum.toFixed(8)),
    todayPnl: new Prisma.Decimal(todayPnlNum.toFixed(8)),
    todayWindowStart,
    byExecutionKey,
    detailByExecutionKey,
    openCostByToken,
    openPositionByToken,
  };
}

/** @deprecated 仅保留给内部回退；新代码请优先按 execution key 范围查询。 */
async function loadFillEventsForUser(userId: number): Promise<FillEvent[]> {
  const [rows, legacyRows] = await Promise.all([
    prisma.copyTradeRow.findMany({
      where: { userId, status: CopyTradeStatus.filled },
      select: COPY_TRADE_FILL_SELECT,
      orderBy: { updatedAt: 'asc' },
      take: HISTORICAL_FIFO_MAX_ROWS,
    }),
    prisma.copyExecution.findMany({
      where: {
        followerUserId: userId,
        status: { in: [...FILLED_LEGACY_STATUSES] },
      },
      select: LEGACY_EXECUTION_FILL_SELECT,
      orderBy: { createdAt: 'asc' },
      take: HISTORICAL_FIFO_MAX_ROWS,
    }),
  ]);

  const fills: FillEvent[] = [];
  for (const row of rows) {
    const f = copyTradeRowToFill(row as CopyTradeFillRow);
    if (f) fills.push(f);
  }
  for (const e of legacyRows) {
    const f = legacyExecutionToFill(e);
    if (f) fills.push(f);
  }
  if (rows.length >= HISTORICAL_FIFO_MAX_ROWS || legacyRows.length >= HISTORICAL_FIFO_MAX_ROWS) {
    logger.warn(
      { userId, copyTradeRows: rows.length, legacyRows: legacyRows.length },
      'loadFillEventsForUser capped'
    );
  }
  return fills;
}

export async function computeCopyTradeRealizedPnlByExecutionForUser(
  userId: number,
  now: Date = new Date()
): Promise<Map<string, string>> {
  const fills = await loadFillEventsForUser(userId);
  const { byExecutionKey } = aggregateRealizedPnlFromFillEvents(fills, { now });
  return new Map(Array.from(byExecutionKey.entries()).map(([key, value]) => [key, value.toString()]));
}

export async function computeCopyTradePnlDetailsByExecutionForUser(
  userId: number,
  now: Date = new Date()
): Promise<Map<string, ExecutionPnlDetail>> {
  const fills = await loadFillEventsForUser(userId);
  const { detailByExecutionKey } = aggregateRealizedPnlFromFillEvents(fills, { now });
  return detailByExecutionKey;
}

export async function computeCopyTradeOpenCostByTokenForUser(
  userId: number,
  now: Date = new Date()
): Promise<Map<string, string>> {
  const fills = await loadFillEventsForUser(userId);
  const { openCostByToken } = aggregateRealizedPnlFromFillEvents(fills, { now });
  return new Map(Array.from(openCostByToken.entries()).map(([key, value]) => [key, value.toString()]));
}

export async function computeCopyTradeOpenPositionDetailsByTokenForUser(
  userId: number,
  now: Date = new Date()
): Promise<Map<string, OpenPositionPnlDetail>> {
  const fills = await loadFillEventsForUser(userId);
  const { openPositionByToken } = aggregateRealizedPnlFromFillEvents(fills, { now });
  return openPositionByToken;
}

/** GET pnl-summary：返回真实跟单账本。 */
export async function computeCopyTradeRealizedPnlSummaryForUser(
  userId: number,
  now: Date = new Date()
): Promise<CopyPnlSummaryResult> {
  await ensureCopyPnlSummaryLedgerSyncedForUser(userId);
  return readCopyPnlSummaryForUser(userId, now);
}
