import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import {
  fetchDataApiPositionsForWalletPair,
  type DataApiPosition,
} from '../../services/polymarket/polymarketData';
import { getExecutionWalletForUser } from '../../services/polymarket/automationSession';
import {
  buildSettlementFields,
  deriveSettlementStatusFromApiPosition,
} from '../../services/polymarket/settlementStatus';
import {
  fetchMarketMetadataForClobTokenIds,
  type PolymarketTokenMarketMetadata,
} from '../../services/polymarket/markets';
import {
  GAMMA_MARKET_METADATA_TIMEOUT_MS,
  pickMarketTitleFromMetadata,
} from './leaderTradeMarketMetadata';
import { COPY_LOT_DUST_SHARES } from './copyPositionLots';
import { autoSettleExpiredWorthlessPositions } from './copyExpiredWorthlessSettlement';

const EPS = 1e-9;

export type SubscriptionCopyPositionLotDto = {
  id: string;
  buyCopyTradeRowId: string;
  remainingSize: string;
  entryPrice: string;
  entryNotional: string;
  currentValueUsd: string | null;
  unrealizedPnlUsd: string | null;
  createdAt: string;
};

export type SubscriptionCopyPositionDto = {
  tokenID: string;
  title: string | null;
  outcome: string | null;
  remainingSize: string;
  avgEntryPrice: string;
  costBasisUsd: string;
  markPrice: string | null;
  currentValueUsd: string | null;
  unrealizedPnlUsd: string | null;
  unrealizedPnlPercent: string | null;
  settlementStatus: 'active' | 'redeemable' | 'pending_settlement' | 'settled_loss';
  settlementHint: string;
  suggestedAction: 'close' | 'redeem' | 'wait' | 'none';
  canClose: boolean;
  canRedeem: boolean;
  conditionId: string | null;
  outcomeIndex: number | null;
  redeemable: boolean;
  lots: SubscriptionCopyPositionLotDto[];
};

export type SubscriptionCopyPositionsSummary = {
  positionCount: number;
  totalCostBasisUsd: string;
  totalCurrentValueUsd: string | null;
  totalUnrealizedPnlUsd: string | null;
};

export type SubscriptionCopyPositionsResult = {
  subscriptionId: string;
  leaderAddress: string;
  positions: SubscriptionCopyPositionDto[];
  summary: SubscriptionCopyPositionsSummary;
};

function decimalString(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return new Prisma.Decimal(value.toFixed(8)).toString();
}

function toNum(value: unknown): number {
  const n = Number(value instanceof Prisma.Decimal ? value.toString() : value);
  return Number.isFinite(n) ? n : 0;
}

async function loadApiPositionsByToken(
  userId: number,
  tokenIds: string[]
): Promise<{
  markPrices: Map<string, number>;
  apiByToken: Map<string, DataApiPosition>;
  positions: DataApiPosition[];
}> {
  const markPrices = new Map<string, number>();
  const apiByToken = new Map<string, DataApiPosition>();
  if (!tokenIds.length) return { markPrices, apiByToken, positions: [] };

  const ctx = await getExecutionWalletForUser(userId).catch(() => null);
  if (!ctx) return { markPrices, apiByToken, positions: [] };

  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  try {
    const positions = await fetchDataApiPositionsForWalletPair(
      { custodial: ctx.address, deposit },
      { sizeThreshold: 0, limit: 200 }
    );
    for (const p of positions as DataApiPosition[]) {
      const token = p.asset.trim().toLowerCase();
      apiByToken.set(token, p);
      const price = Number(p.curPrice ?? 0);
      if (Number.isFinite(price) && price > 0) {
        markPrices.set(token, price);
      }
    }
    return { markPrices, apiByToken, positions };
  } catch {
    // Data API unavailable; mark prices stay empty for those tokens.
  }

  return { markPrices, apiByToken, positions: [] };
}

async function enrichMarketFieldsByToken(
  tokenIds: string[],
  existingByToken: Map<string, { title: string | null; outcome: string | null }>
): Promise<Map<string, { title: string | null; outcome: string | null }>> {
  const missing = tokenIds.filter((tokenId) => {
    const key = tokenId.trim().toLowerCase();
    const existing = existingByToken.get(key);
    return !existing?.title || !existing?.outcome;
  });
  if (!missing.length) return existingByToken;

  const numericIds = [
    ...new Set(missing.map((tokenId) => tokenId.trim()).filter((tokenId) => /^\d+$/.test(tokenId))),
  ];
  if (!numericIds.length) return existingByToken;

  const metaMap = await fetchMarketMetadataForClobTokenIds(numericIds, {
    forceRefresh: false,
    timeoutMs: GAMMA_MARKET_METADATA_TIMEOUT_MS,
  }).catch(() => new Map<string, PolymarketTokenMarketMetadata>());

  const out = new Map(existingByToken);
  for (const tokenId of numericIds) {
    const key = tokenId.toLowerCase();
    const meta = metaMap.get(tokenId);
    const prev = out.get(key) ?? { title: null, outcome: null };
    out.set(key, {
      title: prev.title ?? pickMarketTitleFromMetadata(meta),
      outcome: prev.outcome ?? meta?.outcome?.trim() ?? null,
    });
  }
  return out;
}

function emptySummary(): SubscriptionCopyPositionsSummary {
  return {
    positionCount: 0,
    totalCostBasisUsd: '0',
    totalCurrentValueUsd: null,
    totalUnrealizedPnlUsd: null,
  };
}

function buildSummary(positions: SubscriptionCopyPositionDto[]): SubscriptionCopyPositionsSummary {
  let totalCost = 0;
  let markedCost = 0;
  let totalValue = 0;
  let hasAnyValue = false;
  for (const position of positions) {
    const cost = Number(position.costBasisUsd);
    if (Number.isFinite(cost)) totalCost += cost;
    if (position.currentValueUsd == null) continue;
    const value = Number(position.currentValueUsd);
    if (!Number.isFinite(value)) continue;
    totalValue += value;
    if (Number.isFinite(cost)) markedCost += cost;
    hasAnyValue = true;
  }
  // Only subtract cost of marked positions — unmarked lots must not drag unrealized down.
  const totalPnl = hasAnyValue ? totalValue - markedCost : null;
  return {
    positionCount: positions.length,
    totalCostBasisUsd: decimalString(totalCost),
    totalCurrentValueUsd: hasAnyValue ? decimalString(totalValue) : null,
    totalUnrealizedPnlUsd: totalPnl != null ? decimalString(totalPnl) : null,
  };
}

/** Open real copy lots for one subscription, grouped by token. */
export async function listOpenCopyPositionsForSubscription(params: {
  userId: number;
  subscriptionId: string;
}): Promise<SubscriptionCopyPositionsResult | null> {
  const subscription = await prisma.copySubscription.findFirst({
    where: {
      id: params.subscriptionId,
      userId: params.userId,
      deletedAt: null,
    },
    include: { leader: { select: { address: true } } },
  });
  if (!subscription) return null;

  const leaderAddress = subscription.leader.address;

  const lots = await prisma.copyPositionLot.findMany({
    where: {
      userId: params.userId,
      subscriptionId: params.subscriptionId,
      remainingSize: { gt: new Prisma.Decimal(COPY_LOT_DUST_SHARES) },
    },
    select: {
      id: true,
      tokenID: true,
      buyCopyTradeRowId: true,
      entryPrice: true,
      remainingSize: true,
      entryNotional: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  if (!lots.length) {
    return {
      subscriptionId: subscription.id,
      leaderAddress,
      positions: [],
      summary: emptySummary(),
    };
  }

  const buyRowIds = [...new Set(lots.map((lot) => lot.buyCopyTradeRowId))];
  const buyRows = await prisma.copyTradeRow.findMany({
    where: { id: { in: buyRowIds }, userId: params.userId },
    select: { id: true, marketTitle: true, outcome: true },
  });
  const allowedBuyRowIds = new Set(buyRows.map((row) => row.id));
  const filteredLots = lots.filter((lot) => {
    if (lot.buyCopyTradeRowId.startsWith('legacy:')) {
      return true;
    }
    return allowedBuyRowIds.has(lot.buyCopyTradeRowId);
  });
  if (!filteredLots.length) {
    return {
      subscriptionId: subscription.id,
      leaderAddress,
      positions: [],
      summary: emptySummary(),
    };
  }
  const marketByBuyRowId = new Map(
    buyRows.map((row) => [
      row.id,
      {
        title: row.marketTitle?.trim() || null,
        outcome: row.outcome?.trim() || null,
      },
    ])
  );

  const tokenIds = [...new Set(filteredLots.map((lot) => lot.tokenID.trim()))];
  const { markPrices: markPriceByToken, apiByToken, positions: apiPositions } =
    await loadApiPositionsByToken(params.userId, tokenIds);

  // Open「我的跟单」时顺带关账：过期输面 / Data API 已消失的老 open lot。
  const settledTokens = await autoSettleExpiredWorthlessPositions(
    params.userId,
    apiPositions
  ).catch((e) => {
    console.warn('[subscription-copy-positions] auto-settle failed', {
      userId: params.userId,
      subscriptionId: params.subscriptionId,
      error: e instanceof Error ? e.message : String(e),
    });
    return new Set<string>();
  });

  const activeLots =
    settledTokens.size > 0
      ? filteredLots.filter(
          (lot) => !settledTokens.has(lot.tokenID.trim().toLowerCase())
        )
      : filteredLots;
  if (!activeLots.length) {
    return {
      subscriptionId: subscription.id,
      leaderAddress,
      positions: [],
      summary: emptySummary(),
    };
  }

  const existingFieldsByToken = new Map<string, { title: string | null; outcome: string | null }>();
  for (const lot of activeLots) {
    const tokenKey = lot.tokenID.trim().toLowerCase();
    const buyMeta = marketByBuyRowId.get(lot.buyCopyTradeRowId);
    const prev = existingFieldsByToken.get(tokenKey) ?? { title: null, outcome: null };
    existingFieldsByToken.set(tokenKey, {
      title: prev.title ?? buyMeta?.title ?? null,
      outcome: prev.outcome ?? buyMeta?.outcome ?? null,
    });
  }
  const marketFieldsByToken = await enrichMarketFieldsByToken(
    [...new Set(activeLots.map((lot) => lot.tokenID.trim()))],
    existingFieldsByToken
  );

  const grouped = new Map<string, SubscriptionCopyPositionDto>();

  for (const lot of activeLots) {
    const token = lot.tokenID.trim();
    const tokenKey = token.toLowerCase();
    const remainingSize = toNum(lot.remainingSize);
    const entryPrice = toNum(lot.entryPrice);
    const costBasis = remainingSize * entryPrice;
    const markPrice = markPriceByToken.get(tokenKey);
    const hasMark = markPrice != null && markPrice > 0;
    const currentValue = hasMark ? remainingSize * markPrice! : null;
    const pnl = currentValue != null ? currentValue - costBasis : null;

    const lotDto: SubscriptionCopyPositionLotDto = {
      id: lot.id,
      buyCopyTradeRowId: lot.buyCopyTradeRowId,
      remainingSize: decimalString(remainingSize),
      entryPrice: decimalString(entryPrice),
      entryNotional: decimalString(toNum(lot.entryNotional)),
      currentValueUsd: currentValue != null ? decimalString(currentValue) : null,
      unrealizedPnlUsd: pnl != null ? decimalString(pnl) : null,
      createdAt: lot.createdAt.toISOString(),
    };

    const fields = marketFieldsByToken.get(tokenKey) ?? { title: null, outcome: null };
    const apiPos = apiByToken.get(tokenKey) ?? null;
    const settlementStatus = deriveSettlementStatusFromApiPosition(apiPos, true);
    const settlement = buildSettlementFields(settlementStatus, apiPos);
    const existing = grouped.get(tokenKey);
    if (!existing) {
      grouped.set(tokenKey, {
        tokenID: token,
        title: fields.title,
        outcome: fields.outcome,
        remainingSize: decimalString(remainingSize),
        avgEntryPrice: decimalString(entryPrice),
        costBasisUsd: decimalString(costBasis),
        markPrice: hasMark ? decimalString(markPrice!) : null,
        currentValueUsd: currentValue != null ? decimalString(currentValue) : null,
        unrealizedPnlUsd: pnl != null ? decimalString(pnl) : null,
        unrealizedPnlPercent:
          pnl != null && costBasis > EPS ? decimalString((pnl / costBasis) * 100) : null,
        conditionId: apiPos?.conditionId?.trim() || null,
        outcomeIndex:
          apiPos?.outcomeIndex != null && Number.isFinite(Number(apiPos.outcomeIndex))
            ? Number(apiPos.outcomeIndex)
            : null,
        redeemable: apiPos?.redeemable === true,
        ...settlement,
        lots: [lotDto],
      });
      continue;
    }

    existing.lots.push(lotDto);
    const totalSize = Number(existing.remainingSize) + remainingSize;
    const totalCost = Number(existing.costBasisUsd) + costBasis;
    const totalValue =
      currentValue != null
        ? Number(existing.currentValueUsd ?? 0) + currentValue
        : existing.currentValueUsd != null
          ? Number(existing.currentValueUsd)
          : null;
    const totalPnl = totalValue != null ? totalValue - totalCost : null;

    existing.remainingSize = decimalString(totalSize);
    existing.avgEntryPrice = decimalString(totalCost / totalSize);
    existing.costBasisUsd = decimalString(totalCost);
    existing.currentValueUsd = totalValue != null ? decimalString(totalValue) : null;
    existing.unrealizedPnlUsd = totalPnl != null ? decimalString(totalPnl) : null;
    existing.unrealizedPnlPercent =
      totalPnl != null && totalCost > EPS ? decimalString((totalPnl / totalCost) * 100) : null;
    if (!existing.title && fields.title) existing.title = fields.title;
    if (!existing.outcome && fields.outcome) existing.outcome = fields.outcome;
    if (!existing.markPrice && hasMark) existing.markPrice = decimalString(markPrice!);
  }

  const positions = [...grouped.values()].sort((a, b) => a.tokenID.localeCompare(b.tokenID));

  return {
    subscriptionId: subscription.id,
    leaderAddress,
    positions,
    summary: buildSummary(positions),
  };
}

/**
 * Cheap open-position counts for the Status list (distinct tokens with remainingSize > dust).
 * Matches expand-API grouping without Data API / Gamma; orphan-lot filter omitted as rare.
 */
export async function loadOpenPositionCountBySubscriptionIdForUser(
  userId: number
): Promise<Map<string, number>> {
  type AggRow = { subscriptionId: string; positionCount: number | bigint | string };
  const rows = await prisma.$queryRaw<AggRow[]>`
    SELECT
      l."subscriptionId" AS "subscriptionId",
      COUNT(DISTINCT LOWER(TRIM(l."tokenID")))::int AS "positionCount"
    FROM copy_position_lots l
    WHERE l."userId" = ${userId}
      AND l."remainingSize" > ${COPY_LOT_DUST_SHARES}
    GROUP BY l."subscriptionId"
  `;
  const out = new Map<string, number>();
  for (const row of rows) {
    const n = Number(row.positionCount);
    if (row.subscriptionId && Number.isFinite(n) && n > 0) {
      out.set(row.subscriptionId, n);
    }
  }
  return out;
}

export type CopyOpenPositionsWinLoss = {
  win: number;
  loss: number;
  flat: number;
};

export type CopyOpenPositionsSubscriptionSummary = SubscriptionCopyPositionsSummary & {
  winLoss: CopyOpenPositionsWinLoss;
};

/** One-shot open-position mark summary for all of a user's copy subscriptions. */
export type CopyOpenPositionsUserSummary = {
  summary: SubscriptionCopyPositionsSummary;
  winLoss: CopyOpenPositionsWinLoss;
  /** Per-subscription open summaries (same mark prices as the total). */
  bySubscriptionId: Record<string, CopyOpenPositionsSubscriptionSummary>;
};

type AccBucket = {
  positionCount: number;
  totalCost: number;
  markedCost: number;
  totalValue: number;
  hasValue: boolean;
  win: number;
  loss: number;
  flat: number;
};

function emptyAcc(): AccBucket {
  return {
    positionCount: 0,
    totalCost: 0,
    markedCost: 0,
    totalValue: 0,
    hasValue: false,
    win: 0,
    loss: 0,
    flat: 0,
  };
}

function accToSummary(acc: AccBucket): CopyOpenPositionsSubscriptionSummary {
  const totalPnl = acc.hasValue ? acc.totalValue - acc.markedCost : null;
  return {
    positionCount: acc.positionCount,
    totalCostBasisUsd: decimalString(acc.totalCost),
    totalCurrentValueUsd: acc.hasValue ? decimalString(acc.totalValue) : null,
    totalUnrealizedPnlUsd: totalPnl != null ? decimalString(totalPnl) : null,
    winLoss: { win: acc.win, loss: acc.loss, flat: acc.flat },
  };
}

/**
 * Aggregate open copy lots across all subscriptions with a single Data API mark pull.
 * Used by the copy-rules page so the UI does not N+1 `/positions`.
 */
export async function summarizeOpenCopyPositionsForUser(
  userId: number
): Promise<CopyOpenPositionsUserSummary> {
  const lots = await prisma.copyPositionLot.findMany({
    where: {
      userId,
      remainingSize: { gt: new Prisma.Decimal(COPY_LOT_DUST_SHARES) },
    },
    select: {
      subscriptionId: true,
      tokenID: true,
      buyCopyTradeRowId: true,
      entryPrice: true,
      remainingSize: true,
    },
  });

  if (!lots.length) {
    return {
      summary: emptySummary(),
      winLoss: { win: 0, loss: 0, flat: 0 },
      bySubscriptionId: {},
    };
  }

  const buyRowIds = [
    ...new Set(
      lots
        .map((lot) => lot.buyCopyTradeRowId)
        .filter((id) => id && !id.startsWith('legacy:'))
    ),
  ];
  const buyRows =
    buyRowIds.length > 0
      ? await prisma.copyTradeRow.findMany({
          where: { id: { in: buyRowIds }, userId },
          select: { id: true },
        })
      : [];
  const allowedBuyRowIds = new Set(buyRows.map((row) => row.id));
  const filteredLots = lots.filter((lot) => {
    if (!lot.subscriptionId) return false;
    if (lot.buyCopyTradeRowId.startsWith('legacy:')) return true;
    return allowedBuyRowIds.has(lot.buyCopyTradeRowId);
  });

  if (!filteredLots.length) {
    return {
      summary: emptySummary(),
      winLoss: { win: 0, loss: 0, flat: 0 },
      bySubscriptionId: {},
    };
  }

  const tokenIds = [...new Set(filteredLots.map((lot) => lot.tokenID.trim()))];
  const { markPrices } = await loadApiPositionsByToken(userId, tokenIds);

  const grouped = new Map<string, Map<string, { size: number; cost: number }>>();
  for (const lot of filteredLots) {
    const subscriptionId = lot.subscriptionId!;
    const tokenKey = lot.tokenID.trim().toLowerCase();
    const size = toNum(lot.remainingSize);
    const cost = size * toNum(lot.entryPrice);
    let byToken = grouped.get(subscriptionId);
    if (!byToken) {
      byToken = new Map();
      grouped.set(subscriptionId, byToken);
    }
    const prev = byToken.get(tokenKey) ?? { size: 0, cost: 0 };
    byToken.set(tokenKey, { size: prev.size + size, cost: prev.cost + cost });
  }

  const total = emptyAcc();
  const bySubscriptionId: Record<string, CopyOpenPositionsSubscriptionSummary> = {};

  for (const [subscriptionId, byToken] of grouped) {
    const acc = emptyAcc();
    for (const [tokenKey, pos] of byToken) {
      acc.positionCount += 1;
      acc.totalCost += pos.cost;
      const mark = markPrices.get(tokenKey);
      let pnl: number | null = null;
      if (mark != null && mark > 0) {
        const value = pos.size * mark;
        acc.totalValue += value;
        acc.markedCost += pos.cost;
        acc.hasValue = true;
        pnl = value - pos.cost;
      }
      if (pnl == null) acc.flat += 1;
      else if (pnl > 0) acc.win += 1;
      else if (pnl < 0) acc.loss += 1;
      else acc.flat += 1;
    }

    bySubscriptionId[subscriptionId] = accToSummary(acc);
    total.positionCount += acc.positionCount;
    total.totalCost += acc.totalCost;
    total.markedCost += acc.markedCost;
    total.totalValue += acc.totalValue;
    total.hasValue = total.hasValue || acc.hasValue;
    total.win += acc.win;
    total.loss += acc.loss;
    total.flat += acc.flat;
  }

  const totalSummary = accToSummary(total);
  return {
    summary: {
      positionCount: totalSummary.positionCount,
      totalCostBasisUsd: totalSummary.totalCostBasisUsd,
      totalCurrentValueUsd: totalSummary.totalCurrentValueUsd,
      totalUnrealizedPnlUsd: totalSummary.totalUnrealizedPnlUsd,
    },
    winLoss: totalSummary.winLoss,
    bySubscriptionId,
  };
}
