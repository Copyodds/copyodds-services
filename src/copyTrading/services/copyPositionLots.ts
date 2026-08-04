import { Prisma } from '../../generated/prisma/client';
import type { ExecutionPnlDetail, OpenPositionPnlDetail } from './copyTradeRealizedPnlFromFills';
import { recordCopyPnlEventInTx } from './copyPnlDailyLedger';

const EPS = 1e-9;
/** Residual shares below this are treated as flat for copy-lot bookkeeping. */
export const COPY_LOT_DUST_SHARES = 0.01;

function dec(value: number | string | Prisma.Decimal): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function decimalString(value: number): string {
  return new Prisma.Decimal(value.toFixed(8)).toString();
}

function toNum(value: unknown): number {
  const n = Number(value instanceof Prisma.Decimal ? value.toString() : value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTokenId(tokenID: string): string {
  return tokenID.trim().toLowerCase();
}

export type CopyLotInput = {
  userId: number;
  subscriptionId: string;
  leaderId?: string | null;
  leaderAddress: string;
  tokenID: string;
  buyCopyTradeRowId: string;
  entryPrice: number;
  entrySize: number;
};

export type OpenCopyLotDto = {
  id: string;
  subscriptionId: string;
  leaderId: string | null;
  leaderAddress: string;
  tokenID: string;
  buyCopyTradeRowId: string;
  entryPrice: string;
  entrySize: string;
  remainingSize: string;
  entryNotional: string;
  currentValueUsd: string;
  unrealizedPnlUsd: string;
  unrealizedPnlPercent: string | null;
  createdAt: string;
};

export async function getOpenCopyLotSizeForSubscription(params: {
  prismaClient: any;
  userId: number;
  subscriptionId: string;
  tokenID: string;
}): Promise<number> {
  const targetToken = normalizeTokenId(params.tokenID);
  const rows = await params.prismaClient.copyPositionLot.findMany({
    where: {
      userId: params.userId,
      subscriptionId: params.subscriptionId,
      remainingSize: { gt: new Prisma.Decimal(0) },
    },
    select: { remainingSize: true, tokenID: true, buyCopyTradeRowId: true },
  });
  return rows.reduce((sum: number, row: { remainingSize: Prisma.Decimal; tokenID: string; buyCopyTradeRowId: string }) => {
    if (normalizeTokenId(String(row.tokenID)) !== targetToken) return sum;
    return sum + toNum(row.remainingSize);
  }, 0);
}

/** 已成交 BUY 若缺少 lot（历史/写入失败），在跟卖前补录 open lot。 */
export async function backfillMissingCopyBuyLotsForSubscription(params: {
  prismaClient: any;
  userId: number;
  subscriptionId: string;
  tokenID: string;
}): Promise<number> {
  const targetToken = normalizeTokenId(params.tokenID);
  const existingRowIds = new Set<string>(
    (
      await params.prismaClient.copyPositionLot.findMany({
        where: {
          userId: params.userId,
          subscriptionId: params.subscriptionId,
        },
        select: { buyCopyTradeRowId: true, tokenID: true },
      })
    )
      .filter(
        (row: { tokenID: string }) => normalizeTokenId(String(row.tokenID)) === targetToken
      )
      .map((row: { buyCopyTradeRowId: string }) => row.buyCopyTradeRowId)
  );

  let backfilled = 0;

  const filledBuys = await params.prismaClient.copyTradeRow.findMany({
    where: {
      userId: params.userId,
      subscriptionId: params.subscriptionId,
      status: 'filled',
      leaderTrade: { side: 'BUY' },
    },
    include: {
      subscription: { select: { leaderId: true } },
      leaderTrade: { select: { tokenId: true, leaderAddress: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const row of filledBuys) {
    if (normalizeTokenId(String(row.leaderTrade.tokenId)) !== targetToken) continue;
    if (existingRowIds.has(row.id)) continue;
    const entrySize = toNum(row.filledAmount ?? row.intendedSize);
    const entryPrice = toNum(row.avgPrice ?? row.intendedPrice);
    if (!(entrySize > EPS)) continue;
    await recordCopyBuyLot({
      prismaClient: params.prismaClient,
      lot: {
        userId: params.userId,
        subscriptionId: params.subscriptionId,
        leaderId: row.subscription.leaderId,
        leaderAddress: row.leaderTrade.leaderAddress,
        tokenID: row.leaderTrade.tokenId,
        buyCopyTradeRowId: row.id,
        entryPrice: entryPrice > 0 ? entryPrice : 0,
        entrySize,
      },
    });
    existingRowIds.add(row.id);
    backfilled += 1;
  }

  const subscription = await params.prismaClient.copySubscription.findUnique({
    where: { id: params.subscriptionId },
    select: { leaderId: true, leader: { select: { address: true } } },
  });
  const leaderAddress = subscription?.leader?.address?.trim();
  if (!leaderAddress) return backfilled;

  const legacyBuys = await params.prismaClient.copyExecution.findMany({
    where: {
      followerUserId: params.userId,
      leaderAddress,
      side: 'BUY',
      status: { in: ['filled', 'Filled', 'FILLED'] },
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const legacy of legacyBuys) {
    if (normalizeTokenId(String(legacy.tokenID)) !== targetToken) continue;
    const legacyKey = `legacy:${legacy.id}`;
    if (existingRowIds.has(legacyKey)) continue;
    const entrySize = toNum(legacy.size);
    const entryPrice = toNum(legacy.price);
    if (!(entrySize > EPS)) continue;
    await recordCopyBuyLot({
      prismaClient: params.prismaClient,
      lot: {
        userId: params.userId,
        subscriptionId: params.subscriptionId,
        leaderId: subscription.leaderId ?? null,
        leaderAddress,
        tokenID: String(legacy.tokenID),
        buyCopyTradeRowId: legacyKey,
        entryPrice: entryPrice > 0 ? entryPrice : 0,
        entrySize,
      },
    });
    existingRowIds.add(legacyKey);
    backfilled += 1;
  }

  return backfilled;
}

export async function getOpenCopyLotSizeForUserToken(params: {
  prismaClient: any;
  userId: number;
  tokenID: string;
}): Promise<number> {
  const targetToken = normalizeTokenId(params.tokenID);
  const rows = await params.prismaClient.copyPositionLot.findMany({
    where: {
      userId: params.userId,
      remainingSize: { gt: new Prisma.Decimal(0) },
    },
    select: { remainingSize: true, tokenID: true, buyCopyTradeRowId: true },
  });
  return rows.reduce(
    (
      sum: number,
      row: { remainingSize: Prisma.Decimal; tokenID: string; buyCopyTradeRowId: string }
    ) => {
      if (normalizeTokenId(String(row.tokenID)) !== targetToken) return sum;
      return sum + toNum(row.remainingSize);
    },
    0
  );
}

export async function recordCopyBuyLot(params: {
  prismaClient: any;
  lot: CopyLotInput;
}): Promise<void> {
  const { prismaClient, lot } = params;
  if (!(lot.entrySize > EPS) || !(lot.entryPrice >= 0)) return;
  const entrySize = dec(lot.entrySize.toFixed(8));
  const entryPrice = dec(lot.entryPrice.toFixed(8));
  const entryNotional = dec((lot.entrySize * lot.entryPrice).toFixed(8));
  await prismaClient.copyPositionLot.upsert({
    where: { buyCopyTradeRowId: lot.buyCopyTradeRowId },
    create: {
      userId: lot.userId,
      subscriptionId: lot.subscriptionId,
      leaderId: lot.leaderId ?? null,
      leaderAddress: lot.leaderAddress,
      tokenID: lot.tokenID,
      buyCopyTradeRowId: lot.buyCopyTradeRowId,
      entryPrice,
      entrySize,
      remainingSize: entrySize,
      entryNotional,
    },
    update: {},
  });
}

export async function consumeCopyLotsForSell(params: {
  prismaClient: any;
  userId: number;
  subscriptionId: string;
  sellCopyTradeRowId: string;
  tokenID: string;
  exitPrice: number;
  size: number;
  allowAdditionalClose?: boolean;
}): Promise<ExecutionPnlDetail | null> {
  const { prismaClient, userId, subscriptionId, sellCopyTradeRowId, tokenID } = params;
  let remaining = Math.max(0, params.size);
  if (!(remaining > EPS)) return null;
  const exitPrice = Math.max(0, params.exitPrice);

  return prismaClient.$transaction(async (tx: any) => {
    const settledAt = new Date();
    if (!params.allowAdditionalClose) {
      const existingClose = await tx.copyPositionLotClose.findFirst({
        where: { sellCopyTradeRowId },
        select: { id: true },
      });
      if (existingClose) return null;
    }

    const lots = await tx.copyPositionLot.findMany({
      where: {
        userId,
        subscriptionId,
        remainingSize: { gt: new Prisma.Decimal(0) },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const targetToken = normalizeTokenId(tokenID);

    let closedSize = 0;
    let costBasis = 0;
    let proceeds = 0;

    for (const lot of lots) {
      if (normalizeTokenId(String(lot.tokenID)) !== targetToken) continue;
      if (remaining <= EPS) break;
      const lotRemaining = toNum(lot.remainingSize);
      if (!(lotRemaining > EPS)) continue;
      const take = Math.min(remaining, lotRemaining);
      const entryPrice = toNum(lot.entryPrice);
      const closeCost = take * entryPrice;
      const closeProceeds = take * exitPrice;
      const realized = closeProceeds - closeCost;
      const nextRemaining = Math.max(0, lotRemaining - take);

      await tx.copyPositionLot.update({
        where: { id: lot.id },
        data: { remainingSize: dec(nextRemaining.toFixed(8)) },
      });
      const close = await tx.copyPositionLotClose.create({
        data: {
          userId,
          subscriptionId,
          sellCopyTradeRowId,
          buyCopyTradeRowId: lot.buyCopyTradeRowId,
          lotId: lot.id,
          tokenID,
          closedSize: dec(take.toFixed(8)),
          entryPrice: dec(entryPrice.toFixed(8)),
          exitPrice: dec(exitPrice.toFixed(8)),
          costBasisUsd: dec(closeCost.toFixed(8)),
          proceedsUsd: dec(closeProceeds.toFixed(8)),
          realizedPnlUsd: dec(realized.toFixed(8)),
        },
      });
      await recordCopyPnlEventInTx(tx, {
        eventKey: `copy-pnl:close:${close.id}`,
        userId,
        sourceType: 'COPY_LOT_CLOSE',
        sourceId: close.id,
        previous: 0,
        next: realized.toFixed(8),
        attributionAt: settledAt,
      });

      remaining -= take;
      closedSize += take;
      costBasis += closeCost;
      proceeds += closeProceeds;
    }

    if (!(closedSize > EPS)) return null;

    const allCloseRows = await tx.copyPositionLotClose.findMany({
      where: { userId, sellCopyTradeRowId },
      select: {
        closedSize: true,
        costBasisUsd: true,
        proceedsUsd: true,
        exitPrice: true,
      },
    });
    let cumulativeClosedSize = 0;
    let cumulativeCostBasis = 0;
    let cumulativeProceeds = 0;
    let cumulativeExitWeighted = 0;
    for (const close of allCloseRows) {
      const rowClosedSize = toNum(close.closedSize);
      const rowCostBasis = toNum(close.costBasisUsd);
      const rowProceeds = toNum(close.proceedsUsd);
      const rowExitPrice = toNum(close.exitPrice);
      cumulativeClosedSize += rowClosedSize;
      cumulativeCostBasis += rowCostBasis;
      cumulativeProceeds += rowProceeds;
      cumulativeExitWeighted += rowClosedSize * rowExitPrice;
    }

    const realizedPnl = cumulativeProceeds - cumulativeCostBasis;
    const detail: ExecutionPnlDetail = {
      realizedPnlUsd: decimalString(realizedPnl),
      entryAvgPrice: decimalString(cumulativeCostBasis / cumulativeClosedSize),
      exitPrice: decimalString(cumulativeExitWeighted / cumulativeClosedSize),
      closedSize: decimalString(cumulativeClosedSize),
      costBasisUsd: decimalString(cumulativeCostBasis),
      proceedsUsd: decimalString(cumulativeProceeds),
    };

    await tx.copyTradeRow.update({
      where: { id: sellCopyTradeRowId },
      data: {
        realizedPnlUsd: dec(realizedPnl.toFixed(8)),
        realizedPnlAt: settledAt,
        filledAmount: detail.closedSize,
        avgPrice: detail.exitPrice,
      },
    });

    return detail;
  });
}

/** When the account holds no shares, book-close any leftover copy lot (CLOB fill vs lot drift). */
export async function closeResidualCopyLotWhenFlat(params: {
  prismaClient: any;
  userId: number;
  subscriptionId: string;
  sellCopyTradeRowId: string;
  tokenID: string;
  exitPrice: number;
  accountPositionSize: number | null;
}): Promise<number> {
  if (params.accountPositionSize != null && params.accountPositionSize > COPY_LOT_DUST_SHARES) {
    return 0;
  }
  const lotRemaining = await getOpenCopyLotSizeForSubscription({
    prismaClient: params.prismaClient,
    userId: params.userId,
    subscriptionId: params.subscriptionId,
    tokenID: params.tokenID,
  });
  if (!(lotRemaining > EPS)) return 0;
  await consumeCopyLotsForSell({
    prismaClient: params.prismaClient,
    userId: params.userId,
    subscriptionId: params.subscriptionId,
    sellCopyTradeRowId: params.sellCopyTradeRowId,
    tokenID: params.tokenID,
    exitPrice: params.exitPrice,
    size: lotRemaining,
    allowAdditionalClose: true,
  });
  return lotRemaining;
}

export async function consumeOpenCopyLotsForManualSell(params: {
  prismaClient: any;
  userId: number;
  legacyExecutionId: string;
  tokenID: string;
  exitPrice: number;
  size: number;
  allowAdditionalClose?: boolean;
}): Promise<ExecutionPnlDetail | null> {
  const { prismaClient, userId, legacyExecutionId, tokenID } = params;
  let remaining = Math.max(0, params.size);
  if (!(remaining > EPS)) return null;
  const exitPrice = Math.max(0, params.exitPrice);
  const sellCopyTradeRowId = `legacy:${legacyExecutionId}`;
  return prismaClient.$transaction(async (tx: any) => {
    const settledAt = new Date();
    if (!params.allowAdditionalClose) {
      const existingClose = await tx.copyPositionLotClose.findFirst({
        where: { sellCopyTradeRowId },
        select: { id: true },
      });
      if (existingClose) return null;
    }

    const targetToken = normalizeTokenId(tokenID);
    const allLots = await tx.copyPositionLot.findMany({
      where: {
        userId,
        remainingSize: { gt: new Prisma.Decimal(0) },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const tokenLots = allLots.filter(
      (lot: { tokenID: string }) => normalizeTokenId(String(lot.tokenID)) === targetToken
    );
    const lots = tokenLots;

    let closedSize = 0;
    let costBasis = 0;
    let proceeds = 0;

    for (const lot of lots) {
      if (remaining <= EPS) break;
      const lotRemaining = toNum(lot.remainingSize);
      if (!(lotRemaining > EPS)) continue;
      const take = Math.min(remaining, lotRemaining);
      const entryPrice = toNum(lot.entryPrice);
      const closeCost = take * entryPrice;
      const closeProceeds = take * exitPrice;
      const realized = closeProceeds - closeCost;
      const nextRemaining = Math.max(0, lotRemaining - take);

      await tx.copyPositionLot.update({
        where: { id: lot.id },
        data: { remainingSize: dec(nextRemaining.toFixed(8)) },
      });
      const close = await tx.copyPositionLotClose.create({
        data: {
          userId,
          subscriptionId: lot.subscriptionId,
          sellCopyTradeRowId,
          buyCopyTradeRowId: lot.buyCopyTradeRowId,
          lotId: lot.id,
          tokenID: String(lot.tokenID),
          closedSize: dec(take.toFixed(8)),
          entryPrice: dec(entryPrice.toFixed(8)),
          exitPrice: dec(exitPrice.toFixed(8)),
          costBasisUsd: dec(closeCost.toFixed(8)),
          proceedsUsd: dec(closeProceeds.toFixed(8)),
          realizedPnlUsd: dec(realized.toFixed(8)),
        },
      });
      await recordCopyPnlEventInTx(tx, {
        eventKey: `copy-pnl:close:${close.id}`,
        userId,
        sourceType: 'COPY_LOT_CLOSE',
        sourceId: close.id,
        previous: 0,
        next: realized.toFixed(8),
        attributionAt: settledAt,
      });

      remaining -= take;
      closedSize += take;
      costBasis += closeCost;
      proceeds += closeProceeds;
    }

    if (!(closedSize > EPS)) return null;

    const allCloseRows = await tx.copyPositionLotClose.findMany({
      where: { userId, sellCopyTradeRowId },
      select: {
        closedSize: true,
        costBasisUsd: true,
        proceedsUsd: true,
      },
    });
    let totalClosed = 0;
    let totalCost = 0;
    let totalProceeds = 0;
    for (const row of allCloseRows) {
      totalClosed += toNum(row.closedSize);
      totalCost += toNum(row.costBasisUsd);
      totalProceeds += toNum(row.proceedsUsd);
    }
    if (!(totalClosed > EPS)) return null;

    const realizedPnl = totalProceeds - totalCost;
    return {
      realizedPnlUsd: decimalString(realizedPnl),
      entryAvgPrice: decimalString(totalCost / totalClosed),
      exitPrice: decimalString(exitPrice),
      closedSize: decimalString(totalClosed),
      costBasisUsd: decimalString(totalCost),
      proceedsUsd: decimalString(totalProceeds),
    };
  });
}

export async function getCopyLotCloseDetailsByExecutionForUser(params: {
  prismaClient: any;
  userId: number;
}): Promise<Map<string, ExecutionPnlDetail>> {
  const rows = await params.prismaClient.copyPositionLotClose.findMany({
    where: { userId: params.userId },
    select: {
      sellCopyTradeRowId: true,
      closedSize: true,
      costBasisUsd: true,
      proceedsUsd: true,
      exitPrice: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  return groupLotCloseRowsToExecutionDetails(rows);
}

function groupLotCloseRowsToExecutionDetails(
  rows: Array<{
    sellCopyTradeRowId: string;
    closedSize: unknown;
    costBasisUsd: unknown;
    proceedsUsd: unknown;
    exitPrice: unknown;
  }>
): Map<string, ExecutionPnlDetail> {
  const grouped = new Map<string, {
    closedSize: number;
    costBasis: number;
    proceeds: number;
    exitWeighted: number;
  }>();
  for (const row of rows) {
    const rawCloseId = String(row.sellCopyTradeRowId);
    const key = rawCloseId.startsWith('legacy:') ? rawCloseId : `copy:${rawCloseId}`;
    const closedSize = toNum(row.closedSize);
    const costBasis = toNum(row.costBasisUsd);
    const proceeds = toNum(row.proceedsUsd);
    const exitPrice = toNum(row.exitPrice);
    const prev = grouped.get(key) ?? {
      closedSize: 0,
      costBasis: 0,
      proceeds: 0,
      exitWeighted: 0,
    };
    prev.closedSize += closedSize;
    prev.costBasis += costBasis;
    prev.proceeds += proceeds;
    prev.exitWeighted += exitPrice * closedSize;
    grouped.set(key, prev);
  }

  const out = new Map<string, ExecutionPnlDetail>();
  for (const [key, value] of grouped) {
    if (!(value.closedSize > EPS)) continue;
    out.set(key, {
      realizedPnlUsd: decimalString(value.proceeds - value.costBasis),
      entryAvgPrice: decimalString(value.costBasis / value.closedSize),
      exitPrice: decimalString(value.exitWeighted / value.closedSize),
      closedSize: decimalString(value.closedSize),
      costBasisUsd: decimalString(value.costBasis),
      proceedsUsd: decimalString(value.proceeds),
    });
  }
  return out;
}

export type LotCloseBuyLink = {
  /** List item id (no copy:/legacy: prefix). */
  buyRowId: string;
  closedSize: number;
};

export type LotCloseSellLink = {
  /** List item id (no copy:/legacy: prefix). */
  sellRowId: string;
  closedSize: number;
};

export type BuyLotCloseDetail = ExecutionPnlDetail & {
  primarySellRowId: string;
  settlementType?: 'market_sell' | 'redeem' | 'expired_worthless';
};

function expandBuyRowIdsForLotClose(buyRowIds: string[]): string[] {
  return Array.from(
    new Set(
      buyRowIds.flatMap((id) => {
        const trimmed = id.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('legacy:')) return [trimmed];
        return [trimmed, `legacy:${trimmed}`];
      })
    )
  );
}

function lotCloseRowIdToListItemId(rowId: string): string {
  return rowId.startsWith('legacy:') ? rowId.slice('legacy:'.length) : rowId;
}

function groupLotCloseRowsToBuyLinks(
  rows: Array<{
    sellCopyTradeRowId: string;
    buyCopyTradeRowId: string;
    closedSize: unknown;
  }>
): Map<string, LotCloseBuyLink[]> {
  const grouped = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const sellId = lotCloseRowIdToListItemId(String(row.sellCopyTradeRowId));
    const buyId = lotCloseRowIdToListItemId(String(row.buyCopyTradeRowId));
    const closedSize = toNum(row.closedSize);
    if (!(closedSize > EPS)) continue;
    const byBuy = grouped.get(sellId) ?? new Map<string, number>();
    byBuy.set(buyId, (byBuy.get(buyId) ?? 0) + closedSize);
    grouped.set(sellId, byBuy);
  }

  const out = new Map<string, LotCloseBuyLink[]>();
  for (const [sellId, byBuy] of grouped) {
    out.set(
      sellId,
      Array.from(byBuy.entries()).map(([buyRowId, closedSize]) => ({ buyRowId, closedSize }))
    );
  }
  return out;
}

/** Expand list/copy/legacy sell keys to DB `sellCopyTradeRowId` forms. */
function expandSellRowIdsForLotClose(executionKeys: string[]): string[] {
  return Array.from(
    new Set(
      executionKeys.flatMap((key) => {
        const trimmed = key.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('legacy:')) return [trimmed];
        const bare = trimmed.replace(/^copy:/, '');
        if (!bare) return [];
        return [bare, `legacy:${bare}`];
      })
    )
  );
}

/** Lot-close buy links keyed by sell execution list item id. */
export async function getCopyLotCloseBuyLinksForExecutionKeys(params: {
  prismaClient: any;
  userId: number;
  executionKeys: string[];
}): Promise<Map<string, LotCloseBuyLink[]>> {
  const keys = Array.from(new Set(params.executionKeys.filter(Boolean)));
  if (!keys.length) return new Map();

  const sellIds = expandSellRowIdsForLotClose(keys);
  const rows = await params.prismaClient.copyPositionLotClose.findMany({
    where: {
      userId: params.userId,
      sellCopyTradeRowId: { in: sellIds },
    },
    select: {
      sellCopyTradeRowId: true,
      buyCopyTradeRowId: true,
      closedSize: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  return groupLotCloseRowsToBuyLinks(rows);
}

function groupLotCloseRowsToSellLinks(
  rows: Array<{
    sellCopyTradeRowId: string;
    buyCopyTradeRowId: string;
    closedSize: unknown;
  }>
): Map<string, LotCloseSellLink[]> {
  const grouped = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const buyId = lotCloseRowIdToListItemId(String(row.buyCopyTradeRowId));
    const sellId = lotCloseRowIdToListItemId(String(row.sellCopyTradeRowId));
    const closedSize = toNum(row.closedSize);
    if (!(closedSize > EPS)) continue;
    const bySell = grouped.get(buyId) ?? new Map<string, number>();
    bySell.set(sellId, (bySell.get(sellId) ?? 0) + closedSize);
    grouped.set(buyId, bySell);
  }

  const out = new Map<string, LotCloseSellLink[]>();
  for (const [buyId, bySell] of grouped) {
    out.set(
      buyId,
      Array.from(bySell.entries()).map(([sellRowId, closedSize]) => ({ sellRowId, closedSize }))
    );
  }
  return out;
}

function groupLotCloseRowsToBuyDetails(
  rows: Array<{
    sellCopyTradeRowId: string;
    buyCopyTradeRowId: string;
    closedSize: unknown;
    costBasisUsd: unknown;
    proceedsUsd: unknown;
    exitPrice: unknown;
  }>
): Map<string, BuyLotCloseDetail> {
  const grouped = new Map<
    string,
    {
      closedSize: number;
      costBasis: number;
      proceeds: number;
      exitWeighted: number;
      primarySellRowId: string;
    }
  >();
  for (const row of rows) {
    const buyId = lotCloseRowIdToListItemId(String(row.buyCopyTradeRowId));
    const closedSize = toNum(row.closedSize);
    if (!(closedSize > EPS)) continue;
    const costBasis = toNum(row.costBasisUsd);
    const proceeds = toNum(row.proceedsUsd);
    const exitPrice = toNum(row.exitPrice);
    const prev = grouped.get(buyId) ?? {
      closedSize: 0,
      costBasis: 0,
      proceeds: 0,
      exitWeighted: 0,
      primarySellRowId: String(row.sellCopyTradeRowId),
    };
    prev.closedSize += closedSize;
    prev.costBasis += costBasis;
    prev.proceeds += proceeds;
    prev.exitWeighted += exitPrice * closedSize;
    prev.primarySellRowId = String(row.sellCopyTradeRowId);
    grouped.set(buyId, prev);
  }

  const out = new Map<string, BuyLotCloseDetail>();
  for (const [buyId, value] of grouped) {
    if (!(value.closedSize > EPS)) continue;
    out.set(buyId, {
      realizedPnlUsd: decimalString(value.proceeds - value.costBasis),
      entryAvgPrice: decimalString(value.costBasis / value.closedSize),
      exitPrice: decimalString(value.exitWeighted / value.closedSize),
      closedSize: decimalString(value.closedSize),
      costBasisUsd: decimalString(value.costBasis),
      proceedsUsd: decimalString(value.proceeds),
      primarySellRowId: value.primarySellRowId,
    });
  }
  return out;
}

/** Lot-close sell links keyed by buy execution list item id. */
export async function getCopyLotCloseSellLinksForBuyRowIds(params: {
  prismaClient: any;
  userId: number;
  buyRowIds: string[];
}): Promise<Map<string, LotCloseSellLink[]>> {
  const ids = expandBuyRowIdsForLotClose(params.buyRowIds);
  if (!ids.length) return new Map();

  const rows = await params.prismaClient.copyPositionLotClose.findMany({
    where: {
      userId: params.userId,
      buyCopyTradeRowId: { in: ids },
    },
    select: {
      sellCopyTradeRowId: true,
      buyCopyTradeRowId: true,
      closedSize: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  return groupLotCloseRowsToSellLinks(rows);
}

/** Aggregated lot-close PnL keyed by buy execution list item id. */
export async function getCopyLotCloseDetailsForBuyRowIds(params: {
  prismaClient: any;
  userId: number;
  buyRowIds: string[];
}): Promise<Map<string, BuyLotCloseDetail>> {
  const ids = expandBuyRowIdsForLotClose(params.buyRowIds);
  if (!ids.length) return new Map();

  const rows = await params.prismaClient.copyPositionLotClose.findMany({
    where: {
      userId: params.userId,
      buyCopyTradeRowId: { in: ids },
    },
    select: {
      sellCopyTradeRowId: true,
      buyCopyTradeRowId: true,
      closedSize: true,
      costBasisUsd: true,
      proceedsUsd: true,
      exitPrice: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  const details = groupLotCloseRowsToBuyDetails(rows);
  const legacyExecIds = Array.from(
    new Set(
      rows
        .map((row: { sellCopyTradeRowId: string }) => String(row.sellCopyTradeRowId))
        .filter((sellId: string) => sellId.startsWith('legacy:'))
        .map((sellId: string) => sellId.slice('legacy:'.length))
        .filter(Boolean)
    )
  );
  if (legacyExecIds.length > 0) {
    const expiredSells = await params.prismaClient.copyExecution.findMany({
      where: {
        followerUserId: params.userId,
        id: { in: legacyExecIds },
        leaderAddress: 'manual_expired',
      },
      select: { id: true },
    });
    const expiredSellIds = new Set(expiredSells.map((row: { id: string }) => `legacy:${row.id}`));
    for (const detail of details.values()) {
      if (expiredSellIds.has(detail.primarySellRowId)) {
        detail.settlementType = 'expired_worthless';
      }
    }
  }
  return details;
}

/** Close residual lot shares after a prior partial sell close on the same buy lot. */
export async function reconcilePartiallyClosedBuyLots(params: {
  prismaClient: any;
  userId: number;
}): Promise<number> {
  const lots = await params.prismaClient.copyPositionLot.findMany({
    where: {
      userId: params.userId,
      remainingSize: { gt: new Prisma.Decimal(COPY_LOT_DUST_SHARES) },
    },
    select: {
      buyCopyTradeRowId: true,
      subscriptionId: true,
      tokenID: true,
      remainingSize: true,
    },
    take: 40,
  });
  let repaired = 0;
  for (const lot of lots) {
    const priorClose = await params.prismaClient.copyPositionLotClose.findFirst({
      where: { userId: params.userId, buyCopyTradeRowId: lot.buyCopyTradeRowId },
      orderBy: { createdAt: 'desc' },
      select: { sellCopyTradeRowId: true, exitPrice: true },
    });
    if (!priorClose) continue;
    const exitPrice = toNum(priorClose.exitPrice);
    const remaining = toNum(lot.remainingSize);
    if (!(remaining > EPS)) continue;
    await consumeCopyLotsForSell({
      prismaClient: params.prismaClient,
      userId: params.userId,
      subscriptionId: lot.subscriptionId,
      sellCopyTradeRowId: priorClose.sellCopyTradeRowId,
      tokenID: lot.tokenID,
      exitPrice: exitPrice > 0 ? exitPrice : 0,
      size: remaining,
      allowAdditionalClose: true,
    });
    repaired += 1;
  }
  return repaired;
}

/** 仅查询当前页 execution keys 对应的 lot close 明细，避免全量加载。 */
export async function getCopyLotCloseDetailsForExecutionKeys(params: {
  prismaClient: any;
  userId: number;
  executionKeys: string[];
}): Promise<Map<string, ExecutionPnlDetail>> {
  const keys = Array.from(new Set(params.executionKeys.filter(Boolean)));
  if (!keys.length) return new Map();

  const sellIds = keys.map((key) => (key.startsWith('legacy:') ? key : key.replace(/^copy:/, '')));
  const rows = await params.prismaClient.copyPositionLotClose.findMany({
    where: {
      userId: params.userId,
      sellCopyTradeRowId: { in: sellIds },
    },
    select: {
      sellCopyTradeRowId: true,
      closedSize: true,
      costBasisUsd: true,
      proceedsUsd: true,
      exitPrice: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  return groupLotCloseRowsToExecutionDetails(rows);
}

/** 从 open lots 聚合持仓成本（替代全量 FIFO 重放）。 */
export async function computeOpenPositionDetailsByTokenFromLots(params: {
  prismaClient: any;
  userId: number;
  tokenIds?: string[];
}): Promise<Map<string, OpenPositionPnlDetail>> {
  const normalizedTokens = params.tokenIds?.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const rows = await params.prismaClient.copyPositionLot.findMany({
    where: {
      userId: params.userId,
      remainingSize: { gt: new Prisma.Decimal(0) },
      ...(normalizedTokens?.length
        ? { tokenID: { in: normalizedTokens } }
        : {}),
    },
    select: {
      tokenID: true,
      remainingSize: true,
      entryPrice: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const byToken = new Map<string, { openSize: number; costBasis: number }>();
  for (const row of rows) {
    const token = String(row.tokenID).trim().toLowerCase();
    const remainingSize = toNum(row.remainingSize);
    const entryPrice = toNum(row.entryPrice);
    if (!(remainingSize > EPS)) continue;
    const prev = byToken.get(token) ?? { openSize: 0, costBasis: 0 };
    prev.openSize += remainingSize;
    prev.costBasis += remainingSize * entryPrice;
    byToken.set(token, prev);
  }

  const out = new Map<string, OpenPositionPnlDetail>();
  for (const [tokenId, value] of byToken) {
    if (!(value.openSize > EPS)) continue;
    out.set(tokenId, {
      entryAvgPrice: decimalString(value.costBasis / value.openSize),
      openSize: decimalString(value.openSize),
      costBasisUsd: decimalString(value.costBasis),
    });
  }
  return out;
}

export type PositionCostBasisDetail = {
  entryAvgPrice: string;
  openSize: string;
  costBasisUsd: string;
};

/**
 * 链上仍有仓但 open lot 被误关（remaining=0）时，用 lot 入场价回填展示用成本/跟单来源。
 */
export async function buildClosedLotDisplayFallbackForPositions(params: {
  prismaClient: any;
  userId: number;
  positions: Array<{ asset: string; size: number; curPrice?: number | null }>;
  openLotsByToken: Map<string, OpenCopyLotDto[]>;
  markPriceByToken: Map<string, number>;
}): Promise<{
  costByToken: Map<string, PositionCostBasisDetail>;
  lotsByToken: Map<string, OpenCopyLotDto[]>;
}> {
  const costByToken = new Map<string, PositionCostBasisDetail>();
  const lotsByToken = new Map<string, OpenCopyLotDto[]>();
  const needsFallback = params.positions.filter((p) => {
    const tokenKey = normalizeTokenId(p.asset);
    const hasOpen = (params.openLotsByToken.get(tokenKey) ?? []).some(
      (lot) => Number(lot.remainingSize) > EPS
    );
    return !hasOpen && Number(p.size) > EPS;
  });
  if (!needsFallback.length) return { costByToken, lotsByToken };
  const fallbackTokenIds = Array.from(
    new Set(needsFallback.map((p) => p.asset.trim()).filter(Boolean))
  );

  const rows = await params.prismaClient.copyPositionLot.findMany({
    where: {
      userId: params.userId,
      tokenID: { in: fallbackTokenIds },
    },
    select: {
      id: true,
      subscriptionId: true,
      leaderId: true,
      leaderAddress: true,
      tokenID: true,
      buyCopyTradeRowId: true,
      entryPrice: true,
      entrySize: true,
      remainingSize: true,
      entryNotional: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const rowsByToken = new Map<string, typeof rows>();
  for (const row of rows) {
    const tokenKey = normalizeTokenId(String(row.tokenID));
    const list = rowsByToken.get(tokenKey);
    if (list) list.push(row);
    else rowsByToken.set(tokenKey, [row]);
  }

  for (const p of needsFallback) {
    const tokenKey = normalizeTokenId(p.asset);
    const chainSize = Number(p.size);
    const markPrice = params.markPriceByToken.get(tokenKey) ?? Number(p.curPrice ?? 0);
    const matchedLots = rowsByToken.get(tokenKey) ?? [];
    if (!matchedLots.length) continue;

    let displaySize = 0;
    let costBasis = 0;
    const dtoList: OpenCopyLotDto[] = [];
    let chainRemaining = chainSize;

    for (const lot of matchedLots) {
      const entryPrice = toNum(lot.entryPrice);
      const entrySize = toNum(lot.entrySize);
      const remaining = toNum(lot.remainingSize);
      let lotDisplaySize = remaining;
      if (!(lotDisplaySize > EPS)) {
        lotDisplaySize = Math.min(chainRemaining, entrySize > EPS ? entrySize : chainRemaining);
      }
      if (!(lotDisplaySize > EPS) || !(entryPrice >= 0)) continue;

      const lotCost = lotDisplaySize * entryPrice;
      displaySize += lotDisplaySize;
      costBasis += lotCost;
      chainRemaining = Math.max(0, chainRemaining - lotDisplaySize);
      const currentValue = lotDisplaySize * markPrice;
      const pnl = currentValue - lotCost;
      const costForLot = lotDisplaySize * entryPrice;
      dtoList.push({
        id: lot.id,
        subscriptionId: lot.subscriptionId,
        leaderId: lot.leaderId ?? null,
        leaderAddress: lot.leaderAddress,
        tokenID: lot.tokenID,
        buyCopyTradeRowId: lot.buyCopyTradeRowId,
        entryPrice: decimalString(entryPrice),
        entrySize: decimalString(entrySize),
        remainingSize: decimalString(lotDisplaySize),
        entryNotional: decimalString(toNum(lot.entryNotional) || costForLot),
        currentValueUsd: decimalString(currentValue),
        unrealizedPnlUsd: decimalString(pnl),
        unrealizedPnlPercent:
          costForLot > EPS ? decimalString((pnl / costForLot) * 100) : null,
        createdAt: lot.createdAt.toISOString(),
      });
    }

    if (!(displaySize > EPS)) continue;
    costByToken.set(tokenKey, {
      entryAvgPrice: decimalString(costBasis / displaySize),
      openSize: decimalString(displaySize),
      costBasisUsd: decimalString(costBasis),
    });
    lotsByToken.set(tokenKey, dtoList);
  }

  return { costByToken, lotsByToken };
}

export async function getOpenCopyLotsByTokenForUser(params: {
  prismaClient: any;
  userId: number;
  markPriceByToken: Map<string, number>;
  tokenIds?: string[];
}): Promise<Map<string, OpenCopyLotDto[]>> {
  const normalizedTokens = Array.from(
    new Set(params.tokenIds?.map((t) => normalizeTokenId(t)).filter(Boolean) ?? [])
  );
  const rows = await params.prismaClient.copyPositionLot.findMany({
    where: {
      userId: params.userId,
      remainingSize: { gt: new Prisma.Decimal(0) },
      ...(normalizedTokens.length ? { tokenID: { in: normalizedTokens } } : {}),
    },
    select: {
      id: true,
      subscriptionId: true,
      leaderId: true,
      leaderAddress: true,
      tokenID: true,
      buyCopyTradeRowId: true,
      entryPrice: true,
      entrySize: true,
      remainingSize: true,
      entryNotional: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const out = new Map<string, OpenCopyLotDto[]>();
  for (const row of rows) {
    const token = String(row.tokenID).trim().toLowerCase();
    const remainingSize = toNum(row.remainingSize);
    const entryPrice = toNum(row.entryPrice);
    const costBasis = remainingSize * entryPrice;
    const markPrice = params.markPriceByToken.get(token) ?? 0;
    const currentValue = remainingSize * markPrice;
    const pnl = currentValue - costBasis;
    const dto: OpenCopyLotDto = {
      id: row.id,
      subscriptionId: row.subscriptionId,
      leaderId: row.leaderId ?? null,
      leaderAddress: row.leaderAddress,
      tokenID: row.tokenID,
      buyCopyTradeRowId: row.buyCopyTradeRowId,
      entryPrice: decimalString(entryPrice),
      entrySize: decimalString(toNum(row.entrySize)),
      remainingSize: decimalString(remainingSize),
      entryNotional: decimalString(toNum(row.entryNotional)),
      currentValueUsd: decimalString(currentValue),
      unrealizedPnlUsd: decimalString(pnl),
      unrealizedPnlPercent:
        costBasis > EPS ? decimalString((pnl / costBasis) * 100) : null,
      createdAt: row.createdAt.toISOString(),
    };
    const list = out.get(token);
    if (list) list.push(dto);
    else out.set(token, [dto]);
  }
  return out;
}

export async function loadOpenCopyLotTokenKeysForUser(params: {
  prismaClient: any;
  userId: number;
}): Promise<Set<string>> {
  const rows = await params.prismaClient.copyPositionLot.findMany({
    where: {
      userId: params.userId,
      remainingSize: { gt: new Prisma.Decimal(COPY_LOT_DUST_SHARES) },
    },
    select: { tokenID: true, buyCopyTradeRowId: true },
  });
  return new Set(
    rows.map((row: { tokenID: string }) => normalizeTokenId(String(row.tokenID)))
  );
}

export async function countOpenCopyLotsForUser(params: {
  prismaClient: any;
  userId: number;
}): Promise<number> {
  const rows = await params.prismaClient.copyPositionLot.findMany({
    where: {
      userId: params.userId,
      remainingSize: { gt: new Prisma.Decimal(COPY_LOT_DUST_SHARES) },
    },
    select: { buyCopyTradeRowId: true },
  });
  return rows.length;
}
