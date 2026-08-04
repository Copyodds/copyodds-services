import { Prisma } from '../../generated/prisma/client';
import { CopyTradeStatus } from '../../generated/prisma/enums';
import { prisma } from '../../db';
import { COPY_LOT_DUST_SHARES } from '../../copyTrading/services/copyPositionLots';
import { classifyPositions } from './positionClassifier';
import type { DataApiPosition } from './polymarketData';

export const WORTHLESS_POSITION_PRICE_MAX = 0.01;
export const WORTHLESS_POSITION_VALUE_MAX_USD = 0.05;
export const WORTHLESS_POSITION_SETTLE_GRACE_MS = 0;
/** 市场结束后，再等待此时长才将「不可赎回 + 近零」仓位视为确认输面（有 open lot 时）。 */
export const EXPIRED_LOSER_AUTO_SETTLE_GRACE_MS = 6 * 60 * 60 * 1000;
export const DUST_POSITION_HIDE_PRICE_MAX = 0.001;
export const DUST_POSITION_HIDE_VALUE_MAX_USD = 0.05;
export const DUST_POSITION_HIDE_VALUE_MAX_USD_STALE = 0.05;
/** 新开 lot：Data API 未索引时禁止按「链上无仓」归零。 */
export const OPEN_LOT_CHAIN_FLAT_AUTO_SETTLE_MIN_AGE_MS = 30 * 60 * 1000;
/** 新开 lot：除已确认过期输面外，暂缓自动 manual_expired。 */
export const OPEN_LOT_AUTO_SETTLE_MIN_AGE_MS = 15 * 60 * 1000;

const MANUAL_SETTLEMENT_LEADER_ADDRESSES = [
  'manual_close',
  'manual_expired',
  'manual_redeem',
  'auto_redeem',
  'virtual_manual_close',
] as const;

function positionValueUsd(p: DataApiPosition): number {
  const price = Number(p.curPrice ?? 0);
  const value = Number(p.currentValue ?? price * p.size);
  return Number.isFinite(value) ? value : NaN;
}

/** 链上仍有明显价值 — 禁止自动归零。 */
export function isActiveValuedApiPosition(p: DataApiPosition | null): boolean {
  if (!p || !(Number(p.size ?? 0) > 0)) return false;
  const price = Number(p.curPrice ?? 0);
  const value = positionValueUsd(p);
  return (
    (Number.isFinite(price) && price > WORTHLESS_POSITION_PRICE_MAX) ||
    (Number.isFinite(value) && value > WORTHLESS_POSITION_VALUE_MAX_USD)
  );
}

/** Expired market, not redeemable, price/value near zero — ledger auto-settle as loss. */
export function isExpiredWorthlessPosition(p: DataApiPosition, now = new Date()): boolean {
  if (!(p.size > 0)) return false;
  if (p.redeemable === true) return false;
  const end = p.endDate ? new Date(p.endDate) : null;
  if (!end || Number.isNaN(end.getTime())) return false;
  if (end.getTime() + WORTHLESS_POSITION_SETTLE_GRACE_MS > now.getTime()) return false;

  const price = Number(p.curPrice ?? 0);
  const value = positionValueUsd(p);
  return (
    Number.isFinite(price) &&
    Number.isFinite(value) &&
    price <= WORTHLESS_POSITION_PRICE_MAX &&
    value <= WORTHLESS_POSITION_VALUE_MAX_USD
  );
}

/** Redeemable loser (value ~0) — hide from holdings and auto-settle copy lots. */
export function isWorthlessRedeemablePosition(p: DataApiPosition): boolean {
  if (!(p.size > 0)) return false;
  if (p.redeemable !== true) return false;
  const price = Number(p.curPrice ?? 0);
  const value = positionValueUsd(p);
  return (
    Number.isFinite(price) &&
    Number.isFinite(value) &&
    price <= WORTHLESS_POSITION_PRICE_MAX &&
    value <= WORTHLESS_POSITION_VALUE_MAX_USD
  );
}

export function isWorthlessForLotAutoSettle(p: DataApiPosition, now = new Date()): boolean {
  return isExpiredWorthlessPosition(p, now) || isWorthlessRedeemablePosition(p);
}

function readResolvedPriceUsd(p: DataApiPosition): number | null {
  const raw = p.resolvedPrice ?? p.resolved_price;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 已确认输面（过期 + 近零 + 不可赎回）：允许在有 open lot 时自动 manual_expired。
 * - API 提供 resolvedPrice≈0 → 立即确认；
 * - 否则需 market end + EXPIRED_LOSER_AUTO_SETTLE_GRACE_MS，避免赢面 redeemable 延迟期误伤。
 */
export function isConfirmedExpiredLoserPosition(p: DataApiPosition, now = new Date()): boolean {
  if (!(p.size > 0)) return false;
  if (p.redeemable === true) return false;
  if (!isExpiredWorthlessPosition(p, now)) return false;

  const resolvedPrice = readResolvedPriceUsd(p);
  if (resolvedPrice !== null) {
    return resolvedPrice <= WORTHLESS_POSITION_PRICE_MAX;
  }

  const end = p.endDate ? new Date(p.endDate) : null;
  if (!end || Number.isNaN(end.getTime())) return false;
  return end.getTime() + EXPIRED_LOSER_AUTO_SETTLE_GRACE_MS <= now.getTime();
}

/**
 * 跟单账本仍有 open lot 时：
 * - 可赎回输面 (redeemable + 近零) → 自动归零；
 * - 已确认过期输面 → 自动 manual_expired；
 * 赢面在 redeemable 标出前 curPrice 可能短暂为 0，靠 grace / resolvedPrice 区分。
 */
export function shouldAutoSettleCopyLotAsWorthless(
  p: DataApiPosition,
  hasOpenCopyLots: boolean,
  now = new Date()
): boolean {
  if (!isWorthlessForLotAutoSettle(p, now)) return false;
  if (!hasOpenCopyLots) return true;
  if (isWorthlessRedeemablePosition(p)) return true;
  return isConfirmedExpiredLoserPosition(p, now);
}

/**
 * 跟单 open lot 仍存时的强制归零判定（比 shouldAutoSettleCopyLotAsWorthless 更宽）：
 * - 链上已无持仓但 lot 仍在；
 * - 或 Data API 缺 endDate 但价格/市值已近零且不可赎回（常见于已结束 Exact Score 市场）。
 */
export function shouldForceAutoSettleOpenCopyLot(
  apiPos: DataApiPosition | null,
  now = new Date(),
  options?: { chainFlatWhenMissing?: boolean }
): boolean {
  if (!apiPos || !(Number(apiPos.size ?? 0) > 0)) {
    return options?.chainFlatWhenMissing === true;
  }

  if (isWorthlessRedeemablePosition(apiPos)) return true;
  if (isConfirmedExpiredLoserPosition(apiPos, now)) return true;

  if (apiPos.redeemable === true) {
    const value = positionValueUsd(apiPos);
    if (Number.isFinite(value) && value > WORTHLESS_POSITION_VALUE_MAX_USD) {
      return false;
    }
  }

  if (apiPos.redeemable !== true) {
    const price = Number(apiPos.curPrice ?? 0);
    const value = positionValueUsd(apiPos);
    const nearZero =
      Number.isFinite(price) &&
      Number.isFinite(value) &&
      price <= WORTHLESS_POSITION_PRICE_MAX &&
      value <= WORTHLESS_POSITION_VALUE_MAX_USD;
    if (!nearZero) return false;

    const resolvedPrice = readResolvedPriceUsd(apiPos);
    if (resolvedPrice !== null) {
      return resolvedPrice <= WORTHLESS_POSITION_PRICE_MAX;
    }

    const end = apiPos.endDate ? new Date(apiPos.endDate) : null;
    if (end && !Number.isNaN(end.getTime())) {
      return end.getTime() + EXPIRED_LOSER_AUTO_SETTLE_GRACE_MS <= now.getTime();
    }

    return true;
  }

  return false;
}

export function isDustPositionHiddenFromHoldings(p: DataApiPosition): boolean {
  if (!(p.size > 0)) return false;
  if (p.redeemable === true) return false;
  const price = Number(p.curPrice ?? 0);
  const value = positionValueUsd(p);
  return (
    Number.isFinite(price) &&
    Number.isFinite(value) &&
    price <= DUST_POSITION_HIDE_PRICE_MAX &&
    value <= DUST_POSITION_HIDE_VALUE_MAX_USD
  );
}

export function shouldHideLedgerSettledStalePosition(
  p: DataApiPosition,
  options: { hasOpenLots: boolean; isLedgerSettled: boolean }
): boolean {
  if (options.hasOpenLots || !options.isLedgerSettled) return false;
  // Still-claimable winners must stay visible even after mistaken manual_expired.
  // Hiding them made FC Dallas-style failures look "settled" while chain still paid.
  if (p.redeemable === true && isActiveValuedApiPosition(p)) return false;
  const price = Number(p.curPrice ?? 0);
  const size = Number(p.size ?? 0);
  const value = Number(p.currentValue ?? price * size);
  const nearZero =
    Number.isFinite(price) &&
    Number.isFinite(value) &&
    price <= WORTHLESS_POSITION_PRICE_MAX &&
    value <= DUST_POSITION_HIDE_VALUE_MAX_USD_STALE;
  if (nearZero) return true;
  // Worthless redeemable lag after settle/redeem may still list size > 0.
  if (p.redeemable === true && Number.isFinite(size) && size > 0) return true;
  return false;
}

export async function collectStalePositionAssetsToHide(
  userId: number,
  positions: DataApiPosition[]
): Promise<Set<string>> {
  if (positions.length === 0) return new Set();

  const hidden = new Set<string>();
  const tokenIds = [...new Set(positions.map((p) => p.asset).filter(Boolean))];
  const conditionIds = [...new Set(positions.map((p) => p.conditionId.toLowerCase()))];

  const [redeemLogs, openLotRows, dustLotRows, legacySettlementRows, copyLotCloseRows] =
    await Promise.all([
    conditionIds.length
      ? prisma.polymarketRedeemLog.findMany({
          where: { userId, conditionId: { in: conditionIds } },
          select: { conditionId: true },
        })
      : [],
    tokenIds.length
      ? prisma.copyPositionLot.findMany({
          where: {
            userId,
            tokenID: { in: tokenIds },
            remainingSize: { gt: new Prisma.Decimal(COPY_LOT_DUST_SHARES) },
          },
          select: { tokenID: true },
          distinct: ['tokenID'],
        })
      : [],
    tokenIds.length
      ? prisma.copyPositionLot.findMany({
          where: {
            userId,
            tokenID: { in: tokenIds },
            remainingSize: {
              gt: new Prisma.Decimal(0),
              lte: new Prisma.Decimal(COPY_LOT_DUST_SHARES),
            },
          },
          select: { id: true, tokenID: true },
        })
      : [],
    tokenIds.length
      ? prisma.copyExecution.findMany({
          where: {
            followerUserId: userId,
            tokenID: { in: tokenIds },
            leaderAddress: { in: [...MANUAL_SETTLEMENT_LEADER_ADDRESSES] },
            status: 'filled',
          },
          select: { tokenID: true },
          distinct: ['tokenID'],
        })
      : [],
    tokenIds.length
      ? prisma.copyPositionLotClose.findMany({
          where: { userId, tokenID: { in: tokenIds } },
          select: { sellCopyTradeRowId: true },
          distinct: ['sellCopyTradeRowId'],
        })
      : [],
  ]);

  const sellCopyTradeRowIds = copyLotCloseRows
    .map((row) => row.sellCopyTradeRowId)
    .filter((id) => id && !id.startsWith('legacy:'));
  const copySettlementRows = sellCopyTradeRowIds.length
    ? await prisma.copyTradeRow.findMany({
        where: {
          id: { in: sellCopyTradeRowIds },
          userId,
          tokenId: { in: tokenIds },
          status: CopyTradeStatus.filled,
          leaderTrade: { side: 'SELL' },
        },
        select: { tokenId: true },
        distinct: ['tokenId'],
      })
    : [];

  const normalizeTokenId = (tokenID: string) => tokenID.trim().toLowerCase();
  const redeemedConditions = new Set(redeemLogs.map((r) => r.conditionId.toLowerCase()));
  const openLotTokenIds = new Set(openLotRows.map((row) => normalizeTokenId(row.tokenID)));
  const settledTokenIds = new Set(
    [
      ...legacySettlementRows.map((row) => row.tokenID),
      ...copySettlementRows.map((row) => row.tokenId ?? ''),
    ]
      .filter(Boolean)
      .map((tokenID) => normalizeTokenId(tokenID))
  );

  for (const p of positions) {
    // RedeemLog alone is not enough: a noop / wrong-path tx can log while shares remain.
    // Keep valued redeemable visible so the user can retry claim.
    if (
      redeemedConditions.has(p.conditionId.toLowerCase()) &&
      !(p.redeemable === true && isActiveValuedApiPosition(p))
    ) {
      hidden.add(p.asset);
      continue;
    }
    const tokenKey = normalizeTokenId(p.asset);
    if (
      shouldHideLedgerSettledStalePosition(p, {
        hasOpenLots: openLotTokenIds.has(tokenKey),
        isLedgerSettled: settledTokenIds.has(tokenKey),
      })
    ) {
      hidden.add(p.asset);
    }
  }

  // Zero residual dust on tokens we are hiding / already ledger-settled so later
  // scans do not treat 1e-5 shares as an open position.
  const dustIdsToClear = [
    ...new Set(
      dustLotRows
        .filter((row) => {
          const tokenKey = normalizeTokenId(row.tokenID);
          return (
            settledTokenIds.has(tokenKey) ||
            [...hidden].some((asset) => normalizeTokenId(asset) === tokenKey)
          );
        })
        .map((row) => row.id)
    ),
  ];
  if (dustIdsToClear.length) {
    await prisma.copyPositionLot.updateMany({
      where: { id: { in: dustIdsToClear }, userId },
      data: { remainingSize: new Prisma.Decimal(0) },
    });
  }

  return hidden;
}

export function filterRawPositionsForUserDisplay(
  raw: DataApiPosition[],
  options: {
    staleHiddenAssets: Set<string>;
    worthlessHiddenAssets?: Set<string>;
  }
): DataApiPosition[] {
  const worthlessHidden = options.worthlessHiddenAssets ?? new Set<string>();
  const hiddenDustAssets = new Set(
    raw.filter((p) => isDustPositionHiddenFromHoldings(p)).map((p) => p.asset)
  );

  return raw.filter(
    (p) =>
      !worthlessHidden.has(p.asset) &&
      !options.staleHiddenAssets.has(p.asset) &&
      !hiddenDustAssets.has(p.asset)
  );
}

export type UserDisplayPositionsPartition = {
  displayRaw: DataApiPosition[];
  hiddenDustPositionsRaw: DataApiPosition[];
  hiddenDustAssets: Set<string>;
  staleHiddenAssets: Set<string>;
  worthlessHiddenAssets: Set<string>;
};

export async function partitionUserDisplayPositions(
  userId: number,
  raw: DataApiPosition[]
): Promise<UserDisplayPositionsPartition> {
  const staleHiddenAssets = await collectStalePositionAssetsToHide(userId, raw);
  const worthlessHiddenAssets = new Set(
    raw.filter((p) => isExpiredWorthlessPosition(p) || isWorthlessRedeemablePosition(p)).map((p) => p.asset)
  );
  const hiddenDustPositionsRaw = raw.filter((p) => isDustPositionHiddenFromHoldings(p));
  const hiddenDustAssets = new Set(hiddenDustPositionsRaw.map((p) => p.asset));
  const displayRaw = filterRawPositionsForUserDisplay(raw, {
    staleHiddenAssets,
    worthlessHiddenAssets,
  });

  return {
    displayRaw,
    hiddenDustPositionsRaw,
    hiddenDustAssets,
    staleHiddenAssets,
    worthlessHiddenAssets,
  };
}

/** Positions the user would see on the holdings page (no auto-settle/redeem). */
export async function countUserDisplayOpenPositions(userId: number): Promise<number> {
  const { getExecutionWalletForUser } = await import('./automationSession.js');
  const { fetchDataApiPositionsForWalletPair } = await import('./polymarketData.js');

  const ctx = await getExecutionWalletForUser(userId).catch(() => null);
  if (!ctx) return 0;

  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  const raw = await fetchDataApiPositionsForWalletPair(
    { custodial: ctx.address, deposit },
    { sizeThreshold: 0, limit: 200 }
  );

  const { displayRaw } = await partitionUserDisplayPositions(userId, raw);
  return classifyPositions(displayRaw).length;
}
