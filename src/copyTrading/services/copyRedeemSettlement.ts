import { formatUnits, getAddress, parseAbiItem } from 'viem';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { resolveRedeemUsdcProceedsFromChain } from '../../services/polymarket/redeemProceedsFromChain';
import type { DataApiPosition } from '../../services/polymarket/polymarketData';
import { recordRedeemLog, redeemIfLoggedOrSkip } from '../../services/polymarket/polymarketRedeem';
import { getExecutionWalletForUser } from '../../services/polymarket/automationSession';
import { resolveConditionIdForClobToken } from '../../services/polymarket/markets';
import { PUSD_TOKEN, publicClient, USDC_E_ADDRESS } from '../../services/polymarket/web3';
import { consumeOpenCopyLotsForManualSell } from './copyPositionLots';
import {
  buildCopyPnlRevisionEventKey,
  recordCopyPnlEventInTx,
} from './copyPnlDailyLedger';
import {
  capRedeemGroupProceedsToTxBudget,
  planFollowerRedeemProceedsUsd,
} from './copySettlementProceeds';
import {
  clearAutoRedeemFailures,
  recordAutoRedeemFailure,
  shouldSkipAutoRedeemForFailures,
} from './autoRedeemFailureGuard';
import {
  isRedeemTxHashInUseSet,
  MANUAL_CLOSE_LEADER_ADDRESSES,
  normalizeRedeemTxHash,
  partitionSharedRedeemTxRows,
  resolveProfitRedeemCloseSize,
  shouldSkipAutoRedeemAfterManualClose,
} from './copyRedeemSettlementGuards';
import { isWorthlessRedeemablePosition } from '../../services/polymarket/positionVisibility';

const TX_HASH_RE = /^0x[a-f0-9]{64}$/;
const REDEEM_DISCOVER_BLOCKS_LOOKBACK = 300_000n;
const transferInEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

export const REDEEM_LEADER_MANUAL = 'manual_redeem';
export const REDEEM_LEADER_AUTO = 'auto_redeem';
export const REDEEM_LEADER_ADDRESSES = [REDEEM_LEADER_MANUAL, REDEEM_LEADER_AUTO] as const;
/** 用户点击「立即赎回」时写入，防止历史归类逻辑覆盖为 auto_redeem */
export const REDEEM_SOURCE_MANUAL_ERROR = 'redeem_source:manual';

function redeemLeaderAddress(source: 'manual' | 'auto'): string {
  return source === 'manual' ? REDEEM_LEADER_MANUAL : REDEEM_LEADER_AUTO;
}

/** Data API 保守估算：禁止把 share 数量直接当 USD（旧逻辑会导致假盈利）。 */
export function conservativeRedeemEstimateUsd(position: DataApiPosition): number {
  const currentValue = Number(position.currentValue);
  if (Number.isFinite(currentValue) && currentValue > 0) return currentValue;
  const price = Number(position.curPrice ?? NaN);
  if (Number.isFinite(price) && price > 0 && position.size > 0) {
    return price * position.size;
  }
  return 0;
}

export type RedeemProceedsResolution = {
  resolvedTxHash: string | null;
  notionalUsd: number;
  proceedsSource: 'chain' | 'estimated' | 'unavailable';
};

async function resolveRedeemTxHash(
  userId: number,
  conditionId: string,
  txHash?: string | null
): Promise<string | null> {
  const direct = txHash?.trim().toLowerCase();
  if (direct && TX_HASH_RE.test(direct)) return direct;

  const log = await prisma.polymarketRedeemLog.findUnique({
    where: {
      userId_conditionId: { userId, conditionId: conditionId.toLowerCase() },
    },
    select: { txHash: true },
  });
  const fromLog = log?.txHash?.trim().toLowerCase();
  return fromLog && TX_HASH_RE.test(fromLog) ? fromLog : null;
}

async function resolveRedeemDepositAddress(
  userId: number,
  depositAddress?: string | null
): Promise<string | null> {
  const direct = depositAddress?.trim();
  if (direct && /^0x[a-fA-F0-9]{40}$/.test(direct)) return direct.toLowerCase();

  try {
    const ctx = await getExecutionWalletForUser(userId);
    const deposit = (ctx.polymarketFunderAddress ?? ctx.address).trim();
    return deposit && /^0x[a-fA-F0-9]{40}$/.test(deposit) ? deposit.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function resolveRedeemProceedsUsd(params: {
  userId: number;
  position: DataApiPosition;
  txHash?: string | null;
  depositAddress?: string | null;
}): Promise<RedeemProceedsResolution> {
  const resolvedTxHash = await resolveRedeemTxHash(
    params.userId,
    params.position.conditionId,
    params.txHash
  );
  if (!resolvedTxHash) {
    return { resolvedTxHash: null, notionalUsd: 0, proceedsSource: 'unavailable' };
  }

  const deposit = await resolveRedeemDepositAddress(params.userId, params.depositAddress);
  if (deposit) {
    try {
      const chain = await resolveRedeemUsdcProceedsFromChain(resolvedTxHash, deposit);
      if (chain.kind === 'confirmed') {
        return {
          resolvedTxHash,
          notionalUsd: chain.usd,
          proceedsSource: 'chain',
        };
      }
    } catch (e) {
      console.warn('[copy-redeem-settlement] failed to parse redeem USDC.e proceeds from chain', {
        userId: params.userId,
        txHash: resolvedTxHash,
        deposit,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const estimated = conservativeRedeemEstimateUsd(params.position);
  if (estimated > 0) {
    return {
      resolvedTxHash,
      notionalUsd: estimated,
      proceedsSource: 'estimated',
    };
  }

  return { resolvedTxHash, notionalUsd: 0, proceedsSource: 'unavailable' };
}

async function getOpenCopyLotSizeForToken(userId: number, tokenID: string): Promise<number> {
  const rows = await prisma.copyPositionLot.findMany({
    where: {
      userId,
      tokenID,
      remainingSize: { gt: new Prisma.Decimal(0) },
    },
    select: { remainingSize: true },
  });
  return rows.reduce((sum, row) => sum + Number(row.remainingSize.toString()), 0);
}

function legacySellKey(executionId: string): string {
  return `legacy:${executionId}`;
}

async function recordExpiredWorthlessSettlementIfMissing(params: {
  userId: number;
  tokenID: string;
  closeSize: number;
}): Promise<void> {
  const closeSize = params.closeSize;
  if (!(closeSize > 0)) return;

  const existing = await prisma.copyExecution.findFirst({
    where: {
      followerUserId: params.userId,
      leaderAddress: 'manual_expired',
      tokenID: params.tokenID,
      side: 'SELL',
      status: 'filled',
    },
    select: { id: true },
  });
  if (existing) return;

  const execution = await prisma.copyExecution.create({
    data: {
      followerUserId: params.userId,
      leaderAddress: 'manual_expired',
      tokenID: params.tokenID,
      side: 'SELL',
      price: new Prisma.Decimal(0),
      size: new Prisma.Decimal(closeSize),
      ratioApplied: null,
      notional: new Prisma.Decimal(0),
      polymarketOrderId: null,
      status: 'filled',
      error: 'auto_settled_expired_worthless',
    },
  });
  await consumeOpenCopyLotsForManualSell({
    prismaClient: prisma as any,
    userId: params.userId,
    legacyExecutionId: execution.id,
    tokenID: params.tokenID,
    exitPrice: 0,
    size: closeSize,
  });
}

async function applyExpiredWorthlessToExecution(executionId: string): Promise<void> {
  const sellKey = legacySellKey(executionId);
  await prisma.$transaction(async (tx) => {
    const execution = await tx.copyExecution.findUnique({
      where: { id: executionId },
      select: { followerUserId: true },
    });
    if (!execution) return;
    const userId = execution.followerUserId;
    const revisedAt = new Date();

    const closes = await tx.$queryRaw<Array<{
      id: string;
      costBasisUsd: Prisma.Decimal;
      realizedPnlUsd: Prisma.Decimal | null;
    }>>`
      SELECT id, "costBasisUsd", "realizedPnlUsd"
      FROM copy_position_lot_closes
      WHERE "sellCopyTradeRowId" = ${sellKey}
      FOR UPDATE
    `;
    for (const close of closes) {
      const costBasis = Number(close.costBasisUsd.toString());
      const previousRealized = Number(close.realizedPnlUsd?.toString() ?? 0);
      const nextRealized = Number.isFinite(costBasis) ? -costBasis : 0;
      await tx.copyPositionLotClose.update({
        where: { id: close.id },
        data: {
          exitPrice: new Prisma.Decimal(0),
          proceedsUsd: new Prisma.Decimal(0),
          realizedPnlUsd: new Prisma.Decimal(nextRealized.toFixed(8)),
        },
      });
      await recordCopyPnlEventInTx(tx, {
        eventKey: buildCopyPnlRevisionEventKey(
          'expired',
          `${executionId}:${close.id}`,
          previousRealized,
          nextRealized
        ),
        userId,
        sourceType: 'EXPIRED_REVISION',
        sourceId: close.id,
        previous: previousRealized.toFixed(8),
        next: nextRealized.toFixed(8),
        attributionAt: revisedAt,
      });
    }
    await tx.copyExecution.update({
      where: { id: executionId },
      data: {
        leaderAddress: 'manual_expired',
        price: new Prisma.Decimal(0),
        notional: new Prisma.Decimal(0),
        polymarketOrderId: null,
        error: 'auto_settled_expired_worthless',
      },
    });
  });
}

async function applyRedeemProceedsToExecution(
  executionId: string,
  closeSize: number,
  notionalUsd: number,
  resolvedTxHash: string,
  fromChain: boolean,
  options?: {
    leaderAddress?: string;
    error?: string | null;
  }
): Promise<void> {
  const price = closeSize > 0 ? notionalUsd / closeSize : 0;
  const sellKey = legacySellKey(executionId);
  await prisma.$transaction(async (tx) => {
    const execution = await tx.copyExecution.findUnique({
      where: { id: executionId },
      select: { followerUserId: true },
    });
    if (!execution) return;
    const userId = execution.followerUserId;
    const revisedAt = new Date();

    const closes = await tx.$queryRaw<Array<{
      id: string;
      closedSize: Prisma.Decimal;
      costBasisUsd: Prisma.Decimal;
      realizedPnlUsd: Prisma.Decimal | null;
    }>>`
      SELECT id, "closedSize", "costBasisUsd", "realizedPnlUsd"
      FROM copy_position_lot_closes
      WHERE "sellCopyTradeRowId" = ${sellKey}
      FOR UPDATE
    `;
    for (const close of closes) {
      const closedSize = Number(close.closedSize.toString());
      const costBasis = Number(close.costBasisUsd.toString());
      const proceeds = closedSize * price;
      const previousRealized = Number(close.realizedPnlUsd?.toString() ?? 0);
      const nextRealized = proceeds - costBasis;
      await tx.copyPositionLotClose.update({
        where: { id: close.id },
        data: {
          exitPrice: new Prisma.Decimal(price.toFixed(8)),
          proceedsUsd: new Prisma.Decimal(proceeds.toFixed(8)),
          realizedPnlUsd: new Prisma.Decimal(nextRealized.toFixed(8)),
        },
      });
      await recordCopyPnlEventInTx(tx, {
        eventKey: buildCopyPnlRevisionEventKey(
          'redeem',
          `${resolvedTxHash}:${close.id}`,
          previousRealized,
          nextRealized
        ),
        userId,
        sourceType: 'REDEEM_REVISION',
        sourceId: close.id,
        previous: previousRealized.toFixed(8),
        next: nextRealized.toFixed(8),
        attributionAt: revisedAt,
      });
    }
    await tx.copyExecution.update({
      where: { id: executionId },
      data: {
        ...(options?.leaderAddress ? { leaderAddress: options.leaderAddress } : {}),
        price: new Prisma.Decimal(price.toFixed(8)),
        notional: new Prisma.Decimal(notionalUsd.toFixed(8)),
        polymarketOrderId: resolvedTxHash,
        error:
          options?.error !== undefined
            ? options.error
            : fromChain
              ? null
              : 'auto_redeemed_estimated',
      },
    });
  });
}

/** 误写 manual_expired 后链上确认赢钱 redeem，升级为 redeem 并修正盈亏。 */
async function upgradeExpiredWorthlessToRedeem(
  executionId: string,
  closeSize: number,
  notionalUsd: number,
  resolvedTxHash: string,
  redeemSource: 'manual' | 'auto'
): Promise<void> {
  const leaderAddress = redeemLeaderAddress(redeemSource);
  const error = redeemSource === 'manual' ? REDEEM_SOURCE_MANUAL_ERROR : null;
  await applyRedeemProceedsToExecution(
    executionId,
    closeSize,
    notionalUsd,
    resolvedTxHash,
    true,
    { leaderAddress, error }
  );
}

function normalizeRedeemTokenId(tokenID: string): string {
  return tokenID.trim().toLowerCase();
}

async function loadManualCloseTokenIdSet(userId: number): Promise<Set<string>> {
  const rows = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: { in: [...MANUAL_CLOSE_LEADER_ADDRESSES] },
      side: 'SELL',
      status: 'filled',
    },
    select: { tokenID: true },
    distinct: ['tokenID'],
  });
  return new Set(rows.map((row) => normalizeRedeemTokenId(row.tokenID)));
}

async function isRedeemTxAttributedToOtherExecution(
  userId: number,
  txHash: string,
  excludeExecutionId?: string
): Promise<boolean> {
  const normalized = normalizeRedeemTxHash(txHash);
  if (!normalized) return false;
  const row = await prisma.copyExecution.findFirst({
    where: {
      followerUserId: userId,
      side: 'SELL',
      status: 'filled',
      polymarketOrderId: normalized,
      ...(excludeExecutionId ? { NOT: { id: excludeExecutionId } } : {}),
    },
    select: { id: true },
  });
  return row != null;
}

export async function recordResolvedRedeemExecutionIfMissing(params: {
  userId: number;
  position: DataApiPosition;
  txHash?: string | null;
  depositAddress?: string | null;
  /** 用户点击赎回 vs 定时/持仓页自动赎回 */
  redeemSource?: 'manual' | 'auto';
  /** reconcile 批处理传入，避免每 token 重复查 manual_close / 已用 tx */
  manualCloseTokenIds?: ReadonlySet<string>;
  /** Mutable when provided by batch reconcile so later tokens see newly attributed txs. */
  usedRedeemTxHashes?: Set<string>;
}): Promise<void> {
  const p = params.position;
  const positionSize = Number(p.size ?? 0);
  const openCopyLotSize = await getOpenCopyLotSizeForToken(params.userId, p.asset);
  const redeemSource = params.redeemSource ?? 'auto';

  const existingRedeem = await prisma.copyExecution.findFirst({
    where: {
      followerUserId: params.userId,
      leaderAddress: { in: [...REDEEM_LEADER_ADDRESSES] },
      tokenID: p.asset,
      side: 'SELL',
      status: 'filled',
    },
    select: { id: true },
  });
  const existingExpired = await prisma.copyExecution.findFirst({
    where: {
      followerUserId: params.userId,
      leaderAddress: 'manual_expired',
      tokenID: p.asset,
      side: 'SELL',
      status: 'filled',
    },
    select: { id: true, size: true },
  });
  if (existingRedeem) return;

  const expiredSize =
    existingExpired != null ? Number(existingExpired.size.toString()) : null;
  const closeSize = resolveProfitRedeemCloseSize({
    openCopyLotSizeShares: openCopyLotSize,
    walletPositionShares: positionSize,
    expiredSizeShares: expiredSize,
  });
  if (!(closeSize > 0)) return;

  const manualCloseTokenIds =
    params.manualCloseTokenIds ?? (await loadManualCloseTokenIdSet(params.userId));
  if (
    shouldSkipAutoRedeemAfterManualClose({
      redeemSource,
      hasManualCloseForToken: manualCloseTokenIds.has(normalizeRedeemTokenId(p.asset)),
      openCopyLotSizeShares: openCopyLotSize,
      upgradingExpired: existingExpired != null,
    })
  ) {
    return;
  }

  const leaderAddress = redeemLeaderAddress(redeemSource);

  const resolution = await resolveRedeemProceedsUsd(params);
  const resolvedTxHash = normalizeRedeemTxHash(resolution.resolvedTxHash);
  if (!resolvedTxHash) return;

  if (resolution.proceedsSource !== 'chain') {
    // 链上无法确认入账时不写入盈利结算，等待下次扫描重试。
    return;
  }

  // Only block when another CopyExecution already owns this tx — RedeemLog presence
  // alone must not prevent booking the matching settlement.
  const usedTxHashes =
    params.usedRedeemTxHashes ?? (await collectAttributedRedeemTxHashes(params.userId));
  if (
    !existingExpired &&
    (isRedeemTxHashInUseSet(resolvedTxHash, usedTxHashes) ||
      (await isRedeemTxAttributedToOtherExecution(params.userId, resolvedTxHash)))
  ) {
    return;
  }

  if (existingExpired) {
    if (resolution.notionalUsd <= 0) return;
    if (await isRedeemTxAttributedToOtherExecution(params.userId, resolvedTxHash, existingExpired.id)) {
      return;
    }
    const expiredCloseSize = Number(existingExpired.size.toString());
    const upgradeSize = expiredCloseSize > 0 ? expiredCloseSize : closeSize;
    const allocatedNotional = planFollowerRedeemProceedsUsd({
      chainProceedsUsd: resolution.notionalUsd,
      executionSizeShares: Math.max(positionSize, upgradeSize),
      followerCloseSizeShares: upgradeSize,
    });
    await upgradeExpiredWorthlessToRedeem(
      existingExpired.id,
      upgradeSize,
      allocatedNotional,
      resolvedTxHash,
      redeemSource
    );
    params.usedRedeemTxHashes?.add(resolvedTxHash);
    return;
  }

  if (resolution.notionalUsd <= 0) {
    await recordExpiredWorthlessSettlementIfMissing({
      userId: params.userId,
      tokenID: p.asset,
      closeSize,
    });
    return;
  }

  // Prefer planFollower over raw Data API size: avoids mid-price under-allocation when
  // API wallet size is inflated but chain already paid ≈ $1 × follower close.
  const allocatedNotional = planFollowerRedeemProceedsUsd({
    chainProceedsUsd: resolution.notionalUsd,
    executionSizeShares: Math.max(positionSize, closeSize),
    followerCloseSizeShares: closeSize,
  });
  const price = closeSize > 0 ? allocatedNotional / closeSize : 0;
  const closeNotionalUsd = allocatedNotional;
  const execution = await prisma.copyExecution.create({
    data: {
      followerUserId: params.userId,
      leaderAddress,
      tokenID: p.asset,
      side: 'SELL',
      price: new Prisma.Decimal(price.toFixed(8)),
      size: new Prisma.Decimal(closeSize),
      ratioApplied: null,
      notional: new Prisma.Decimal(closeNotionalUsd.toFixed(8)),
      polymarketOrderId: resolvedTxHash,
      status: 'filled',
      error: redeemSource === 'manual' ? REDEEM_SOURCE_MANUAL_ERROR : null,
    },
  });
  await consumeOpenCopyLotsForManualSell({
    prismaClient: prisma as any,
    userId: params.userId,
    legacyExecutionId: execution.id,
    tokenID: p.asset,
    exitPrice: price,
    size: closeSize,
  });
  params.usedRedeemTxHashes?.add(resolvedTxHash);
}

type RedeemReconcileRow = {
  id: string;
  tokenID: string;
  size: Prisma.Decimal;
  notional: Prisma.Decimal | null;
  polymarketOrderId: string | null;
  error: string | null;
};

export type ReconcileMisstatedRedeemOptions = {
  /** 单次最多处理条数；GET 路径已移除，cron 用小批量避免长时间占满事件循环 */
  maxRows?: number;
  /** 链上 receipt 查询并发上限 */
  chainConcurrency?: number;
};

/** cron 默认每用户每轮处理条数 */
export const REDEEM_RECONCILE_CRON_MAX_ROWS = 20;
/** cron 默认链上查询并发 */
export const REDEEM_RECONCILE_CRON_CHAIN_CONCURRENCY = 3;

function redeemRowNeedsRepair(row: Pick<RedeemReconcileRow, 'polymarketOrderId' | 'error'>): boolean {
  const txHash = row.polymarketOrderId?.trim().toLowerCase() ?? '';
  return row.error === 'auto_redeemed_estimated' || !TX_HASH_RE.test(txHash);
}

async function resolveMatchingExecutionIdsForRedeemTx(
  userId: number,
  txHash: string,
  rows: RedeemReconcileRow[]
): Promise<Set<string>> {
  const matching = new Set<string>();
  const log = await prisma.polymarketRedeemLog.findFirst({
    where: { userId, txHash },
    select: { conditionId: true },
  });
  const logCondition = log?.conditionId?.trim().toLowerCase() ?? null;
  if (!logCondition) return matching;

  for (const row of rows) {
    const conditionId = await resolveConditionIdForClobToken(row.tokenID);
    if (conditionId?.trim().toLowerCase() === logCondition) {
      matching.add(row.id);
    }
  }
  return matching;
}

async function reconcileRedeemTxGroup(
  rows: RedeemReconcileRow[],
  deposit: string,
  userId: number
): Promise<void> {
  if (!rows.length) return;
  const txHash = rows[0].polymarketOrderId?.trim().toLowerCase() ?? '';
  if (!TX_HASH_RE.test(txHash)) {
    for (const row of rows) {
      await reconcileOneMisstatedRedeemRow(row, deposit);
    }
    return;
  }

  const chain = await resolveRedeemUsdcProceedsFromChain(txHash, deposit);
  if (chain.kind === 'unavailable') return;

  if (chain.kind !== 'confirmed' || chain.usd <= 0) {
    for (const row of rows) {
      await applyExpiredWorthlessToExecution(row.id);
    }
    return;
  }

  const sizedRows = rows.map((row) => ({
    row,
    id: row.id,
    size: Number(row.size.toString()),
  }));
  const matchingIds =
    sizedRows.length > 1
      ? await resolveMatchingExecutionIdsForRedeemTx(userId, txHash, rows)
      : new Set<string>();
  const { keep, drop } = partitionSharedRedeemTxRows({
    rows: sizedRows,
    matchingIds,
    chainProceedsUsd: chain.usd,
  });

  for (const item of drop) {
    await applyExpiredWorthlessToExecution(item.row.id);
  }
  if (!keep.length) return;

  const planned = keep.map((item) =>
    planFollowerRedeemProceedsUsd({
      chainProceedsUsd: chain.usd,
      executionSizeShares: item.size,
      followerCloseSizeShares: item.size,
    })
  );
  const capped = capRedeemGroupProceedsToTxBudget(planned, chain.usd);

  for (let i = 0; i < keep.length; i++) {
    const item = keep[i];
    const closeSize = item.size;
    if (!(closeSize > 0)) continue;
    const allocated = capped[i] ?? 0;
    const stored = Number(item.row.notional?.toString() ?? 0);
    if (redeemRowNeedsRepair(item.row) || Math.abs(allocated - stored) > 0.02) {
      await applyRedeemProceedsToExecution(item.row.id, closeSize, allocated, txHash, true);
    }
  }
}

async function reconcileOneMisstatedRedeemRow(
  row: RedeemReconcileRow,
  deposit: string
): Promise<void> {
  const closeSize = Number(row.size.toString());
  if (!(closeSize > 0)) return;

  const txHash = row.polymarketOrderId?.trim().toLowerCase() ?? '';
  const needsRepair = redeemRowNeedsRepair(row);

  const allocateRepairProceeds = (chainUsd: number): number =>
    planFollowerRedeemProceedsUsd({
      chainProceedsUsd: chainUsd,
      executionSizeShares: closeSize,
      followerCloseSizeShares: closeSize,
    });

  if (!needsRepair && TX_HASH_RE.test(txHash)) {
    const chain = await resolveRedeemUsdcProceedsFromChain(txHash, deposit);
    if (chain.kind === 'confirmed' && chain.usd <= 0) {
      await applyExpiredWorthlessToExecution(row.id);
    } else if (chain.kind === 'confirmed' && chain.usd > 0) {
      const allocated = allocateRepairProceeds(chain.usd);
      if (Math.abs(allocated - Number(row.notional?.toString() ?? 0)) > 0.02) {
        await applyRedeemProceedsToExecution(row.id, closeSize, allocated, txHash, true);
      }
    }
    return;
  }

  if (TX_HASH_RE.test(txHash)) {
    const chain = await resolveRedeemUsdcProceedsFromChain(txHash, deposit);
    if (chain.kind === 'unavailable') return;
    if (chain.usd <= 0) {
      await applyExpiredWorthlessToExecution(row.id);
    } else {
      await applyRedeemProceedsToExecution(
        row.id,
        closeSize,
        allocateRepairProceeds(chain.usd),
        txHash,
        true
      );
    }
    return;
  }

  await applyExpiredWorthlessToExecution(row.id);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (!items.length) return;
  const queue = [...items];
  const poolSize = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(
    Array.from({ length: poolSize }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) return;
        await worker(item);
      }
    })
  );
}

/**
 * 修正「链上已赢钱 redeem，但账本误写 manual_expired」的历史记录。
 */
export async function reconcileMisstatedExpiredExecutionsForUser(
  userId: number,
  positions: DataApiPosition[],
  depositAddress?: string | null,
  options?: ReconcileMisstatedRedeemOptions
): Promise<void> {
  const maxRows = Math.max(1, Math.min(200, options?.maxRows ?? 50));

  const deposit = depositAddress
    ? depositAddress.trim().toLowerCase()
    : await resolveRedeemDepositAddress(userId, null);
  if (!deposit) return;

  const positionByAsset = new Map(positions.map((p) => [p.asset, p]));
  const conditionIdByAsset = new Map(
    positions.map((p) => [p.asset, p.conditionId.trim().toLowerCase()])
  );

  const expiredRows = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: 'manual_expired',
      side: 'SELL',
      status: 'filled',
    },
    select: { id: true, tokenID: true, size: true },
    take: maxRows,
    orderBy: { createdAt: 'desc' },
  });
  if (!expiredRows.length) return;

  const redeemLogs = await prisma.polymarketRedeemLog.findMany({
    where: { userId },
    select: { conditionId: true, txHash: true },
  });

  // Serial upgrades: concurrent attribution of the same redeem tx caused cross-market dilution.
  for (const row of expiredRows) {
    const closeSize = Number(row.size.toString());
    if (!(closeSize > 0)) continue;

    const position = positionByAsset.get(row.tokenID);
    if (position) {
      const resolution = await resolveRedeemProceedsUsd({
        userId,
        position: { ...position, size: closeSize },
        depositAddress: deposit,
      });
      const resolvedTxHash = normalizeRedeemTxHash(resolution.resolvedTxHash);
      if (
        resolution.proceedsSource === 'chain' &&
        resolution.notionalUsd > 0 &&
        resolvedTxHash &&
        !(await isRedeemTxAttributedToOtherExecution(userId, resolvedTxHash, row.id))
      ) {
        const allocatedNotional = planFollowerRedeemProceedsUsd({
          chainProceedsUsd: resolution.notionalUsd,
          executionSizeShares: Math.max(Number(position.size ?? 0), closeSize),
          followerCloseSizeShares: closeSize,
        });
        await upgradeExpiredWorthlessToRedeem(
          row.id,
          closeSize,
          allocatedNotional,
          resolvedTxHash,
          'auto'
        );
      }
      continue;
    }

    let rowConditionId = conditionIdByAsset.get(row.tokenID) ?? null;
    if (!rowConditionId) {
      rowConditionId = await resolveConditionIdForClobToken(row.tokenID);
    }
    // Never fall back to all RedeemLogs — that reuses an unrelated market's tx.
    if (!rowConditionId) continue;

    const candidateLogs = redeemLogs.filter(
      (log) => log.conditionId.trim().toLowerCase() === rowConditionId
    );

    for (const log of candidateLogs) {
      const txHash = log.txHash.trim().toLowerCase();
      if (!TX_HASH_RE.test(txHash)) continue;
      if (await isRedeemTxAttributedToOtherExecution(userId, txHash, row.id)) continue;

      const chain = await resolveRedeemUsdcProceedsFromChain(txHash, deposit);
      if (chain.kind !== 'confirmed' || chain.usd <= 0) continue;

      // 赢面 redeem 入账应接近份额面值（$1/share）；避免把其他市场的赎回错配过来。
      const minWinProceeds = closeSize * 0.5;
      if (chain.usd < minWinProceeds) continue;

      const allocatedNotional = planFollowerRedeemProceedsUsd({
        chainProceedsUsd: chain.usd,
        executionSizeShares: closeSize,
        followerCloseSizeShares: closeSize,
      });
      await upgradeExpiredWorthlessToRedeem(row.id, closeSize, allocatedNotional, txHash, 'auto');
      break;
    }
  }
}

/**
 * 修正历史上「链上无 USDC.e 入账却被估算为赢」的 redeem 记录。
 * 仅供后台 cron / worker 调用，勿在 HTTP GET 请求路径中 await。
 */
export async function reconcileMisstatedRedeemExecutionsForUser(
  userId: number,
  depositAddress?: string | null,
  options?: ReconcileMisstatedRedeemOptions
): Promise<void> {
  const maxRows = Math.max(1, Math.min(200, options?.maxRows ?? 200));
  const chainConcurrency = Math.max(1, Math.min(8, options?.chainConcurrency ?? 1));

  const deposit = depositAddress
    ? depositAddress.trim().toLowerCase()
    : await resolveRedeemDepositAddress(userId, null);
  if (!deposit) return;

  // 上线前未区分来源的 redeem 记录，默认视为自动赎回
  await prisma.copyExecution.updateMany({
    where: {
      followerUserId: userId,
      leaderAddress: REDEEM_LEADER_MANUAL,
      side: 'SELL',
      status: 'filled',
      NOT: { error: REDEEM_SOURCE_MANUAL_ERROR },
    },
    data: { leaderAddress: REDEEM_LEADER_AUTO },
  });

  const rows = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: { in: [...REDEEM_LEADER_ADDRESSES] },
      side: 'SELL',
      status: 'filled',
    },
    select: {
      id: true,
      tokenID: true,
      size: true,
      notional: true,
      polymarketOrderId: true,
      error: true,
    },
    take: maxRows,
    orderBy: { createdAt: 'desc' },
  });

  const sorted = [...rows].sort((a, b) => {
    const aRepair = redeemRowNeedsRepair(a);
    const bRepair = redeemRowNeedsRepair(b);
    if (aRepair !== bRepair) return aRepair ? -1 : 1;
    return 0;
  });

  const byTx = new Map<string, RedeemReconcileRow[]>();
  const noTx: RedeemReconcileRow[] = [];
  for (const row of sorted) {
    const txHash = row.polymarketOrderId?.trim().toLowerCase() ?? '';
    if (TX_HASH_RE.test(txHash)) {
      const list = byTx.get(txHash) ?? [];
      list.push(row);
      byTx.set(txHash, list);
    } else {
      noTx.push(row);
    }
  }

  // Shared-tx groups must run serially so drop/keep decisions see a stable ledger.
  // Reload full sibling set per tx — take:maxRows can otherwise truncate a diluted group.
  for (const txHash of byTx.keys()) {
    const fullGroup = await prisma.copyExecution.findMany({
      where: {
        followerUserId: userId,
        leaderAddress: { in: [...REDEEM_LEADER_ADDRESSES] },
        side: 'SELL',
        status: 'filled',
        polymarketOrderId: txHash,
      },
      select: {
        id: true,
        tokenID: true,
        size: true,
        notional: true,
        polymarketOrderId: true,
        error: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    await reconcileRedeemTxGroup(fullGroup, deposit, userId);
  }
  await runWithConcurrency(noTx, chainConcurrency, (row) =>
    reconcileOneMisstatedRedeemRow(row, deposit)
  );
}

export type RedeemRedeemableOpenLotsResult = {
  /** token assets processed (skipped or redeemed) */
  redeemedAssets: Set<string>;
  /** at least one on-chain redeem tx succeeded this run */
  anyTxRedeemed: boolean;
  /** 仍有可自动重试的 redeemable（未达失败上限） */
  autoRedeemStillPending: boolean;
};

/**
 * 对 Data API 标记 redeemable 且有兑付价值的仓位尝试链上 redeem（幂等）。
 * 可赎回输面（价值≈0）不走链上 redeem，交给 expired-worthless 归零，并清掉失败熔断。
 * 供 redeem cron 使用；勿在 GET /positions 同步调用。
 * 同一持仓连续失败 ≥3 次后跳过自动兑换（手动赎回不受影响）。
 */
export async function redeemRedeemableOpenLotsForUser(params: {
  userId: number;
  redeemAddress: string;
  positions: DataApiPosition[];
  logPrefix?: string;
}): Promise<RedeemRedeemableOpenLotsResult> {
  const redeemed = new Set<string>();
  let anyTxRedeemed = false;
  let autoRedeemStillPending = false;
  const logPrefix = params.logPrefix ?? '[redeem]';

  const candidatePositions = params.positions.filter((p) => p.redeemable === true && p.size > 0);
  const tokenIds = candidatePositions.map((p) => p.asset).filter(Boolean);
  const openLotRows = tokenIds.length
    ? await prisma.copyPositionLot.findMany({
        where: {
          userId: params.userId,
          tokenID: { in: tokenIds },
          remainingSize: { gt: new Prisma.Decimal(0) },
        },
        select: { tokenID: true },
        distinct: ['tokenID'],
      })
    : [];
  const openLotTokenIds = new Set(openLotRows.map((row) => normalizeRedeemTokenId(row.tokenID)));
  const attributedTxHashes = await collectAttributedRedeemTxHashes(params.userId);
  const manualCloseTokenIds = await loadManualCloseTokenIdSet(params.userId);

  // 链上 redeem 不依赖账本 open lot（归零可能已误消费 lot，但链上份额仍在）。
  for (const p of candidatePositions) {
    const outcomeIndex = p.outcomeIndex ?? 0;
    const hasOpenCopyLot = openLotTokenIds.has(normalizeRedeemTokenId(p.asset));

    // 输面可赎回：兑付为 0，链上 redeem 无意义；勿记失败/熔断，交给归零结算。
    if (isWorthlessRedeemablePosition(p)) {
      await clearAutoRedeemFailures({
        userId: params.userId,
        conditionId: p.conditionId,
        outcomeIndex,
      });
      console.info(`${logPrefix} auto-redeem skipped (worthless redeemable)`, {
        userId: params.userId,
        conditionId: p.conditionId,
        outcomeIndex,
        asset: p.asset,
        size: p.size,
        currentValue: p.currentValue ?? null,
        curPrice: p.curPrice ?? null,
        hasOpenCopyLot,
      });
      continue;
    }

    if (
      await shouldSkipAutoRedeemForFailures({
        userId: params.userId,
        conditionId: p.conditionId,
        outcomeIndex,
      })
    ) {
      console.warn(`${logPrefix} auto-redeem skipped (max failures)`, {
        userId: params.userId,
        conditionId: p.conditionId,
        outcomeIndex,
        asset: p.asset,
        hasOpenCopyLot,
      });
      continue;
    }
    autoRedeemStillPending = true;
    try {
      const result = await redeemIfLoggedOrSkip(
        params.userId,
        {
          conditionId: p.conditionId,
          outcomeIndex,
          negativeRisk: p.negativeRisk === true,
          size: p.size,
          assetTokenId: p.asset,
        },
        params.redeemAddress
      );
      const redeemBooked =
        (result.skipped && result.reason === 'already_redeemed') ||
        (!result.skipped && !!result.txHash && result.reason !== 'zero_proceeds');
      if (redeemBooked) {
        await clearAutoRedeemFailures({
          userId: params.userId,
          conditionId: p.conditionId,
          outcomeIndex,
        });
        await recordResolvedRedeemExecutionIfMissing({
          userId: params.userId,
          position: p,
          txHash: result.txHash ?? null,
          depositAddress: params.redeemAddress,
          redeemSource: 'auto',
          manualCloseTokenIds,
          usedRedeemTxHashes: attributedTxHashes,
        });
        redeemed.add(p.asset);
      }
      if (!result.skipped && result.txHash && result.reason !== 'zero_proceeds') {
        anyTxRedeemed = true;
        console.log(`${logPrefix} redeemed`, {
          userId: params.userId,
          conditionId: p.conditionId,
          txHash: result.txHash,
          hasOpenCopyLot,
        });
      } else if (result.skipped && result.reason === 'already_redeemed') {
        console.log(`${logPrefix} redeem skipped (already on chain)`, {
          userId: params.userId,
          conditionId: p.conditionId,
          hasOpenCopyLot,
        });
      } else if (result.reason === 'zero_proceeds') {
        const failure = await recordAutoRedeemFailure({
          userId: params.userId,
          conditionId: p.conditionId,
          outcomeIndex,
          error: 'zero_proceeds',
        });
        console.warn(`${logPrefix} redeem tx had zero USDC.e; not booking success`, {
          userId: params.userId,
          conditionId: p.conditionId,
          txHash: result.txHash,
          failCount: failure.failCount,
          autoRedeemDisabled: failure.disabled,
        });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const failure = await recordAutoRedeemFailure({
        userId: params.userId,
        conditionId: p.conditionId,
        outcomeIndex,
        error,
      });
      console.warn(`${logPrefix} redeem failed`, {
        userId: params.userId,
        conditionId: p.conditionId,
        asset: p.asset,
        hasOpenCopyLot,
        failCount: failure.failCount,
        autoRedeemDisabled: failure.disabled,
        error,
      });
    }
  }

  return { redeemedAssets: redeemed, anyTxRedeemed, autoRedeemStillPending };
}

/** Tx hashes already booked on a filled CopyExecution (true attribution). */
export async function collectAttributedRedeemTxHashes(userId: number): Promise<Set<string>> {
  const used = new Set<string>();
  const executions = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      side: 'SELL',
      status: 'filled',
      polymarketOrderId: { not: null },
    },
    select: { polymarketOrderId: true },
  });
  for (const row of executions) {
    const tx = row.polymarketOrderId?.trim().toLowerCase();
    if (tx && TX_HASH_RE.test(tx)) used.add(tx);
  }
  return used;
}

/**
 * @deprecated Prefer collectAttributedRedeemTxHashes. Kept for discover-exclude callers
 * that also need RedeemLog hashes — use collectDiscoverExcludedRedeemTxHashes instead.
 */
export async function collectUsedRedeemTxHashes(userId: number): Promise<Set<string>> {
  return collectAttributedRedeemTxHashes(userId);
}

/** Exclude txs already attributed or logged under any condition from amount-based discovery. */
async function collectDiscoverExcludedRedeemTxHashes(userId: number): Promise<Set<string>> {
  const used = await collectAttributedRedeemTxHashes(userId);
  const logs = await prisma.polymarketRedeemLog.findMany({
    where: { userId },
    select: { txHash: true },
  });
  for (const row of logs) {
    const tx = row.txHash?.trim().toLowerCase();
    if (tx && TX_HASH_RE.test(tx)) used.add(tx);
  }
  return used;
}

/**
 * 链上已 redeem 但未写入 PolymarketRedeemLog 时，按入账金额匹配最近 pUSD/USDC.e 转入 tx。
 */
async function discoverRedeemTxHashForProceeds(
  depositAddress: string,
  expectedProceedsUsd: number,
  excludeTxHashes: Set<string>
): Promise<string | null> {
  if (!(expectedProceedsUsd > 0)) return null;

  let recipient: `0x${string}`;
  try {
    recipient = getAddress(depositAddress.trim() as `0x${string}`);
  } catch {
    return null;
  }

  const latest = await publicClient.getBlockNumber();
  const fromBlock =
    latest > REDEEM_DISCOVER_BLOCKS_LOOKBACK ? latest - REDEEM_DISCOVER_BLOCKS_LOOKBACK : 0n;
  const tolerance = Math.max(0.03, expectedProceedsUsd * 0.02);
  const candidates: Array<{ txHash: string; usd: number; blockNumber: bigint }> = [];

  for (const token of [PUSD_TOKEN, USDC_E_ADDRESS] as const) {
    let logs;
    try {
      logs = await publicClient.getLogs({
        address: token,
        event: transferInEvent,
        args: { to: recipient },
        fromBlock,
        toBlock: latest,
      });
    } catch (e) {
      console.warn('[copy-redeem-settlement] discover redeem tx getLogs failed', {
        token,
        deposit: recipient,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    const byTx = new Map<string, { raw: bigint; blockNumber: bigint }>();
    for (const log of logs) {
      const tx = log.transactionHash?.toLowerCase();
      if (!tx || !TX_HASH_RE.test(tx) || excludeTxHashes.has(tx)) continue;
      const value = log.args.value as bigint;
      const prev = byTx.get(tx);
      byTx.set(tx, {
        raw: (prev?.raw ?? 0n) + value,
        blockNumber: log.blockNumber ?? prev?.blockNumber ?? 0n,
      });
    }

    for (const [txHash, entry] of byTx) {
      const usd = Number(formatUnits(entry.raw, 6));
      if (!Number.isFinite(usd) || usd <= 0) continue;
      if (Math.abs(usd - expectedProceedsUsd) <= tolerance) {
        candidates.push({ txHash, usd, blockNumber: entry.blockNumber });
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(b.blockNumber - a.blockNumber));
  return candidates[0]?.txHash ?? null;
}

/**
 * open copy lot 仍在但链上已赎回、未写结算时补记 auto_redeem（含 Polymarket 自动 redeem、无 RedeemLog）。
 */
export async function reconcileUnsettledOpenCopyLotsForUser(
  userId: number,
  positions: DataApiPosition[],
  depositAddress?: string | null,
  options?: ReconcileMisstatedRedeemOptions
): Promise<void> {
  const maxTokens = Math.max(1, Math.min(50, options?.maxRows ?? 20));
  const deposit = depositAddress
    ? depositAddress.trim().toLowerCase()
    : await resolveRedeemDepositAddress(userId, null);
  if (!deposit) return;

  const openLotRows = await prisma.copyPositionLot.findMany({
    where: {
      userId,
      remainingSize: { gt: new Prisma.Decimal(0) },
    },
    select: { tokenID: true, remainingSize: true },
    take: maxTokens * 4,
    orderBy: { updatedAt: 'desc' },
  });
  if (!openLotRows.length) return;

  const openSizeByToken = new Map<string, { tokenID: string; size: number }>();
  for (const row of openLotRows) {
    const tokenID = row.tokenID.trim();
    const key = normalizeRedeemTokenId(tokenID);
    const size = Number(row.remainingSize.toString());
    if (!(size > 0)) continue;
    const prev = openSizeByToken.get(key);
    openSizeByToken.set(key, {
      tokenID,
      size: (prev?.size ?? 0) + size,
    });
  }

  const positionByAsset = new Map(
    positions.map((p) => [normalizeRedeemTokenId(p.asset), p])
  );
  const redeemLogs = await prisma.polymarketRedeemLog.findMany({
    where: { userId },
    select: { conditionId: true, txHash: true },
  });
  const [attributedTxHashes, discoverExcludedTxHashes, manualCloseTokenIds] = await Promise.all([
    collectAttributedRedeemTxHashes(userId),
    collectDiscoverExcludedRedeemTxHashes(userId),
    loadManualCloseTokenIdSet(userId),
  ]);
  let processed = 0;

  for (const { tokenID, size: openSize } of openSizeByToken.values()) {
    if (processed >= maxTokens) break;

    if (
      shouldSkipAutoRedeemAfterManualClose({
        redeemSource: 'auto',
        hasManualCloseForToken: manualCloseTokenIds.has(normalizeRedeemTokenId(tokenID)),
        openCopyLotSizeShares: openSize,
        upgradingExpired: false,
      })
    ) {
      continue;
    }

    const existingRedeem = await prisma.copyExecution.findFirst({
      where: {
        followerUserId: userId,
        leaderAddress: { in: [...REDEEM_LEADER_ADDRESSES] },
        tokenID,
        side: 'SELL',
        status: 'filled',
      },
      select: { id: true },
    });
    if (existingRedeem) continue;

    const position = positionByAsset.get(normalizeRedeemTokenId(tokenID));
    let conditionId = position?.conditionId?.trim().toLowerCase() ?? null;
    if (!conditionId) {
      conditionId = await resolveConditionIdForClobToken(tokenID);
    }
    if (!conditionId) continue;

    let txHash =
      redeemLogs.find((log) => log.conditionId.trim().toLowerCase() === conditionId)?.txHash ?? null;

    const logTx = normalizeRedeemTxHash(txHash);
    // Only drop the log tx when another execution already owns it (not merely because the log exists).
    if (logTx && attributedTxHashes.has(logTx)) {
      txHash = null;
    }

    if (!txHash || !TX_HASH_RE.test(txHash.trim().toLowerCase())) {
      const discovered = await discoverRedeemTxHashForProceeds(
        deposit,
        openSize,
        discoverExcludedTxHashes
      );
      if (discovered) {
        txHash = discovered;
        try {
          await recordRedeemLog(userId, conditionId, discovered);
        } catch {
          // 并发或已存在
        }
        discoverExcludedTxHashes.add(discovered);
      }
    }

    const syntheticPosition: DataApiPosition = position ?? {
      asset: tokenID,
      conditionId,
      size: openSize,
      redeemable: true,
      outcomeIndex: 0,
    };

    await recordResolvedRedeemExecutionIfMissing({
      userId,
      position: { ...syntheticPosition, size: openSize },
      txHash,
      depositAddress: deposit,
      redeemSource: 'auto',
      manualCloseTokenIds,
      usedRedeemTxHashes: attributedTxHashes,
    });
    processed += 1;
  }
}
