/** BUY + settlement lifecycle merge for execution list display (mirrors web copy-exec-lifecycle). */

import type {
  BuyLotCloseDetail,
  LotCloseBuyLink,
  LotCloseSellLink,
} from '../../copyTrading/services/copyPositionLots';
import { COPY_LOT_DUST_SHARES } from '../../copyTrading/services/copyPositionLots';
import { sharesFilledEnough } from '../../copyTrading/services/copySellSize';

export type ExecutionLifecycleRow = {
  id: string;
  leaderAddress: string;
  tokenID: string;
  side: string;
  price: string;
  size: string;
  status: string;
  polymarketOrderId?: string | null;
  openLotRemaining?: string | null;
  settlementType?: 'market_sell' | 'redeem' | 'expired_worthless' | null;
  marketLabel?: string | null;
  title?: string | null;
  eventTitle?: string | null;
  question?: string | null;
  outcome?: string | null;
  entryAvgPrice?: string | null;
  exitPrice?: string | null;
  closedSize?: string | null;
  costBasisUsd?: string | null;
  proceedsUsd?: string | null;
  realizedPnlUsd?: string | null;
  settlementResult?: 'win' | 'loss' | 'flat' | null;
  createdAt: string;
};

export type DisplayExecutionLifecycleRow = ExecutionLifecycleRow & {
  _lifecycle?: { buy: ExecutionLifecycleRow; settlement: ExecutionLifecycleRow };
};

/** Settlement rows use sentinel leader ids; list display should show the copied leader wallet. */
export const SETTLEMENT_SENTINEL_LEADER_ADDRESSES = new Set([
  'manual_close',
  'virtual_manual_close',
  'manual_expired',
  'manual_redeem',
  'auto_redeem',
]);

export function resolveExecutionDisplayLeaderAddress(
  leaderAddress: string,
  fallbackLeaderAddress?: string | null
): string {
  const leader = leaderAddress?.trim().toLowerCase() ?? '';
  if (!SETTLEMENT_SENTINEL_LEADER_ADDRESSES.has(leader)) return leaderAddress;
  const fallback = fallbackLeaderAddress?.trim();
  if (fallback && !SETTLEMENT_SENTINEL_LEADER_ADDRESSES.has(fallback.toLowerCase())) {
    return fallback;
  }
  return leaderAddress;
}

export function withResolvedDisplayLeaderAddress<
  T extends ExecutionLifecycleRow & { _lifecycle?: { buy?: ExecutionLifecycleRow } },
>(row: T, fallbackLeaderAddress?: string | null): T {
  let resolved = resolveExecutionDisplayLeaderAddress(
    row.leaderAddress,
    row._lifecycle?.buy?.leaderAddress
  );
  resolved = resolveExecutionDisplayLeaderAddress(resolved, fallbackLeaderAddress);
  if (resolved === row.leaderAddress) return row;
  return { ...row, leaderAddress: resolved };
}

function isSettlementRow(row: ExecutionLifecycleRow): boolean {
  if (row.settlementType) return true;
  const side = row.side.toUpperCase();
  if (side.includes('SELL') && !side.includes('BUY')) {
    return !!(
      row.costBasisUsd ??
      row.proceedsUsd ??
      row.realizedPnlUsd ??
      row.closedSize
    );
  }
  return false;
}

function isBuySideRow(row: ExecutionLifecycleRow): boolean {
  const side = row.side.toUpperCase();
  return side.includes('BUY') && !side.includes('SELL');
}

function isSellSideRow(row: ExecutionLifecycleRow): boolean {
  const side = row.side.toUpperCase();
  return side.includes('SELL') && !side.includes('BUY');
}

function isSuccessStatus(status: string): boolean {
  return status.trim().toLowerCase() === 'filled';
}

function rowExecutionSize(row: ExecutionLifecycleRow): number {
  const closed = row.closedSize != null ? Number(row.closedSize) : NaN;
  if (Number.isFinite(closed) && closed > 0) return closed;
  const n = Number(row.size);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isFullLifecycleSettlement(
  buy: ExecutionLifecycleRow,
  settlement: ExecutionLifecycleRow
): boolean {
  const buySize = Number(buy.size);
  const settleSize = rowExecutionSize(settlement);
  if (!(Number.isFinite(buySize) && buySize > 0) || !(settleSize > 0)) return false;
  // Lot dust / CLOB rounding can leave buy.size slightly above closed shares (e.g. 2.973 vs 2.97).
  return sharesFilledEnough(settleSize, buySize, COPY_LOT_DUST_SHARES);
}

function buyLotRemainingClosed(row: ExecutionLifecycleRow): boolean {
  const rem =
    row.openLotRemaining != null && row.openLotRemaining !== ''
      ? Number(row.openLotRemaining)
      : null;
  return rem != null && Number.isFinite(rem) && rem <= COPY_LOT_DUST_SHARES;
}

function positionGroupKey(row: ExecutionLifecycleRow): string {
  const leader = row.leaderAddress?.trim().toLowerCase() ?? '';
  const token = row.tokenID?.trim().toLowerCase() ?? '';
  return `${leader}|${token}`;
}

function mergeTitleFields(
  primary: ExecutionLifecycleRow,
  fallback: ExecutionLifecycleRow
): ExecutionLifecycleRow {
  return {
    ...primary,
    marketLabel: primary.marketLabel?.trim() || fallback.marketLabel?.trim() || null,
    eventTitle: primary.eventTitle?.trim() || fallback.eventTitle?.trim() || null,
    title: primary.title?.trim() || fallback.title?.trim() || null,
    question: primary.question?.trim() || fallback.question?.trim() || null,
    outcome: primary.outcome?.trim() || fallback.outcome?.trim() || null,
  };
}

function settlementResultFromPnl(pnl: string | null | undefined): 'win' | 'loss' | 'flat' | null {
  if (pnl == null || pnl === '') return null;
  const n = Number(pnl);
  if (!Number.isFinite(n)) return null;
  if (n > 0) return 'win';
  if (n < 0) return 'loss';
  return 'flat';
}

function findRelatedBuy(
  settlement: ExecutionLifecycleRow,
  buys: ExecutionLifecycleRow[]
): ExecutionLifecycleRow | undefined {
  const settleAt = new Date(settlement.createdAt).getTime();
  if (!Number.isFinite(settleAt)) return undefined;
  let best: ExecutionLifecycleRow | undefined;
  let bestAt = -Infinity;
  for (const buy of buys) {
    const buyAt = new Date(buy.createdAt).getTime();
    if (!Number.isFinite(buyAt) || buyAt >= settleAt) continue;
    if (buyAt > bestAt) {
      bestAt = buyAt;
      best = buy;
    }
  }
  return best;
}

function dedupeFilledExecutionsByOrderId<T extends ExecutionLifecycleRow>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const orderId = row.polymarketOrderId?.trim();
    if (orderId && isSuccessStatus(row.status)) {
      const key = `${orderId}|${row.side.trim().toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(row);
  }
  return out;
}

type LifecyclePair<T extends ExecutionLifecycleRow> = { buy: T; settlement: T };

function lotCloseRowIdToListItemId(rowId: string): string {
  return rowId.startsWith('legacy:') ? rowId.slice('legacy:'.length) : rowId;
}

function applyBuyCloseDetail<T extends ExecutionLifecycleRow>(
  row: T,
  detail: BuyLotCloseDetail
): T {
  return {
    ...row,
    realizedPnlUsd: detail.realizedPnlUsd,
    entryAvgPrice: detail.entryAvgPrice,
    exitPrice: detail.exitPrice,
    closedSize: detail.closedSize,
    costBasisUsd: detail.costBasisUsd,
    proceedsUsd: detail.proceedsUsd,
    settlementResult: settlementResultFromPnl(detail.realizedPnlUsd),
    settlementType: row.settlementType ?? 'market_sell',
    size: detail.closedSize && Number(detail.closedSize) > 0 ? detail.closedSize : row.size,
  };
}

function buildSyntheticSettlementFromBuy<T extends ExecutionLifecycleRow>(
  buy: T,
  detail: BuyLotCloseDetail
): T {
  const sellRowId = lotCloseRowIdToListItemId(detail.primarySellRowId);
  return applyBuyCloseDetail(
    {
      ...buy,
      id: sellRowId,
      side: 'SELL',
      status: 'filled',
      price: detail.exitPrice ?? buy.price,
    },
    detail
  );
}

/** Closed buy + lot-close ledger → settled lifecycle row (detail/list). */
export function buildSettledDisplayFromClosedBuy<T extends ExecutionLifecycleRow>(
  buy: T,
  detail: BuyLotCloseDetail
): T & { _lifecycle: { buy: T; settlement: T } } {
  const buySnapshot = { ...buy };
  const settlement = {
    ...buildSyntheticSettlementFromBuy(buySnapshot, detail),
    settlementType: detail.settlementType ?? 'market_sell',
  };
  return {
    ...buySnapshot,
    ...mergeTitleFields(buySnapshot, settlement),
    realizedPnlUsd: settlement.realizedPnlUsd,
    entryAvgPrice: settlement.entryAvgPrice,
    exitPrice: settlement.exitPrice,
    closedSize: settlement.closedSize,
    costBasisUsd: settlement.costBasisUsd,
    proceedsUsd: settlement.proceedsUsd,
    settlementResult: settlement.settlementResult,
    settlementType: settlement.settlementType,
    _lifecycle: { buy: buySnapshot, settlement },
  };
}

function registerLifecyclePair<T extends ExecutionLifecycleRow>(
  pairsBySettlementId: Map<string, LifecyclePair<T>>,
  mergedBuyIds: Set<string>,
  buy: T,
  settlement: T
): void {
  mergedBuyIds.add(buy.id);
  pairsBySettlementId.set(settlement.id, { buy, settlement });
}

function uniqueBuyIdsFromLinks(links: LotCloseBuyLink[]): string[] {
  return Array.from(new Set(links.map((link) => link.buyRowId)));
}

/**
 * When one settlement closes multiple buys and that settlement row is present,
 * fold those buys into the single settlement card (do not also emit per-buy synthetics).
 */
function buysCoveredByPresentMultiBuySettlements(
  rows: ExecutionLifecycleRow[],
  lotCloseBuyLinksBySellId: Map<string, LotCloseBuyLink[]>
): Set<string> {
  const rowIds = new Set(rows.map((row) => row.id));
  const covered = new Set<string>();
  for (const [sellId, links] of lotCloseBuyLinksBySellId) {
    if (!rowIds.has(sellId) || !links.length) continue;
    const buyIds = uniqueBuyIdsFromLinks(links);
    if (buyIds.length <= 1) continue;
    for (const buyId of buyIds) covered.add(buyId);
  }
  return covered;
}

/** Pair settlements to buys using copyPositionLotClose ledger (not token FIFO). */
function pairLifecyclesFromLotCloses<T extends ExecutionLifecycleRow>(
  rows: T[],
  lotCloseBuyLinksBySellId: Map<string, LotCloseBuyLink[]>,
  lotCloseSellLinksByBuyId: Map<string, LotCloseSellLink[]>
): {
  pairsBySettlementId: Map<string, LifecyclePair<T>>;
  mergedBuyIds: Set<string>;
} {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const pairsBySettlementId = new Map<string, LifecyclePair<T>>();
  const mergedBuyIds = new Set<string>();

  for (const row of rows) {
    if (!isSellSideRow(row)) continue;
    const links = lotCloseBuyLinksBySellId.get(row.id);
    if (!links?.length) continue;

    const closedByBuy = new Map<string, number>();
    for (const link of links) {
      closedByBuy.set(link.buyRowId, (closedByBuy.get(link.buyRowId) ?? 0) + link.closedSize);
    }
    // Multi-buy settlements stay as one merged card; do not attach a single buy lifecycle.
    if (closedByBuy.size !== 1) continue;

    const [buyRowId] = closedByBuy.keys();
    const buy = rowById.get(buyRowId);
    if (!buy) continue;

    registerLifecyclePair(pairsBySettlementId, mergedBuyIds, buy, row);
  }

  for (const row of rows) {
    if (!isBuySideRow(row) || mergedBuyIds.has(row.id)) continue;
    const links = lotCloseSellLinksByBuyId.get(row.id);
    if (!links?.length) continue;

    const closedBySell = new Map<string, number>();
    for (const link of links) {
      closedBySell.set(link.sellRowId, (closedBySell.get(link.sellRowId) ?? 0) + link.closedSize);
    }
    if (closedBySell.size !== 1) continue;

    const [sellRowId] = closedBySell.keys();
    const sell = rowById.get(sellRowId);
    if (!sell) continue;

    // Sell already closes multiple buys → keep merged settlement, hide this buy separately.
    const sellBuyLinks = lotCloseBuyLinksBySellId.get(sellRowId);
    if (sellBuyLinks && uniqueBuyIdsFromLinks(sellBuyLinks).length > 1) continue;

    registerLifecyclePair(pairsBySettlementId, mergedBuyIds, row, sell);
  }

  return { pairsBySettlementId, mergedBuyIds };
}

function buysByGroup<T extends ExecutionLifecycleRow>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!isBuySideRow(row) || !isSuccessStatus(row.status) || isSettlementRow(row)) {
      continue;
    }
    const key = positionGroupKey(row);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

function renderLifecycleRow<T extends ExecutionLifecycleRow>(
  pair: LifecyclePair<T>
): T & { _lifecycle?: { buy: T; settlement: T } } {
  const titles = mergeTitleFields(pair.buy, pair.settlement);
  const settlement = {
    ...pair.settlement,
    settlementType: pair.settlement.settlementType ?? 'market_sell',
    marketLabel: titles.marketLabel,
    eventTitle: titles.eventTitle,
    title: titles.title,
    question: titles.question,
    outcome: titles.outcome,
  };
  return {
    ...settlement,
    leaderAddress: resolveExecutionDisplayLeaderAddress(
      settlement.leaderAddress,
      pair.buy.leaderAddress
    ),
    _lifecycle: isFullLifecycleSettlement(pair.buy, settlement) ? { buy: pair.buy, settlement } : undefined,
  };
}

/** Merge BUY + settlement into lifecycle rows for list display. */
export function buildDisplayExecutionRows<T extends ExecutionLifecycleRow>(
  rows: T[],
  lotCloseBuyLinksBySellId: Map<string, LotCloseBuyLink[]> = new Map(),
  lotCloseSellLinksByBuyId: Map<string, LotCloseSellLink[]> = new Map(),
  lotCloseDetailsByBuyId: Map<string, BuyLotCloseDetail> = new Map()
): (T & { _lifecycle?: { buy: T; settlement: T } })[] {
  const filtered = dedupeFilledExecutionsByOrderId(rows);
  const { pairsBySettlementId, mergedBuyIds } = pairLifecyclesFromLotCloses(
    filtered,
    lotCloseBuyLinksBySellId,
    lotCloseSellLinksByBuyId
  );
  const multiBuyCoveredBuyIds = buysCoveredByPresentMultiBuySettlements(
    filtered,
    lotCloseBuyLinksBySellId
  );
  const groupedBuys = buysByGroup(filtered);
  const syntheticSettlementIds = new Set<string>();

  const displayRows = filtered
    .filter((row) => !mergedBuyIds.has(row.id) && !multiBuyCoveredBuyIds.has(row.id))
    .map((row): (T & { _lifecycle?: { buy: T; settlement: T } }) | null => {
      const pair = pairsBySettlementId.get(row.id);
      if (pair) {
        return renderLifecycleRow(pair);
      }

      if (isSettlementRow(row)) {
        const related = findRelatedBuy(row, groupedBuys.get(positionGroupKey(row)) ?? []);
        if (related) {
          const titles = mergeTitleFields(related, row);
          return {
            ...row,
            marketLabel: titles.marketLabel,
            eventTitle: titles.eventTitle,
            title: titles.title,
            question: titles.question,
            outcome: titles.outcome,
            leaderAddress: resolveExecutionDisplayLeaderAddress(
              row.leaderAddress,
              related.leaderAddress
            ),
          };
        }
      }

      if (
        isBuySideRow(row) &&
        isSuccessStatus(row.status) &&
        lotCloseDetailsByBuyId.has(row.id)
      ) {
        const detail = lotCloseDetailsByBuyId.get(row.id)!;
        const buySize = Number(row.size);
        const closed = Number(detail.closedSize);
        const lotClosed =
          buyLotRemainingClosed(row) ||
          (Number.isFinite(buySize) &&
            buySize > 0 &&
            Number.isFinite(closed) &&
            sharesFilledEnough(closed, buySize, COPY_LOT_DUST_SHARES));
        if (lotClosed) {
          const settled = buildSettledDisplayFromClosedBuy(row, detail);
          syntheticSettlementIds.add(settled._lifecycle.settlement.id);
          return settled;
        }
      }

      return row;
    })
    .filter((row): row is T & { _lifecycle?: { buy: T; settlement: T } } => row != null);

  // Buy-centric synthetics already carry per-buy PnL; drop the raw settlement row so it
  // cannot also appear with sell-aggregated (merged) amounts.
  return displayRows.filter((row) => {
    if (!syntheticSettlementIds.has(row.id)) return true;
    return !!row._lifecycle;
  });
}
