/**
 * 修复跟单结算盈亏：重算 copy_position_lot_closes 的 proceeds / realized，并重建 UserSettings 累计收益。
 *
 * 针对问题：
 * - 赎回把整笔链上 USDC 记到 follower 小仓位（exitPrice > $1）
 * - 跟卖 CLOB notional 未按 follower 份额封顶
 * - 过期归零 proceeds 应为 0
 *
 * Usage (local dev):
 *   npm run repair:copy-settlement-pnl:dev -- <userId> [--dry-run]
 * Usage (production deploy bundle):
 *   npm run repair:copy-settlement-pnl -- <userId> [--dry-run]
 *   npm run repair:copy-settlement-pnl -- <userId> --skip-reconcile
 *   REPAIR_DEPOSIT_USD=18 REPAIR_CURRENT_BALANCE_USD=0.78 npm run repair:copy-settlement-pnl -- 2 --anchor-cash --dry-run
 */
import '../src/loadEnv';
import { Prisma } from '../src/generated/prisma/client';
import { prisma } from '../src/db';
import { getExecutionWalletForUser } from '../src/services/polymarket/automationSession';
import { fetchDataApiPositionsForWalletPair } from '../src/services/polymarket/polymarketData';
import { resolveRedeemUsdcProceedsFromChain } from '../src/services/polymarket/redeemProceedsFromChain';
import {
  reconcileMisstatedExpiredExecutionsForUser,
  reconcileMisstatedRedeemExecutionsForUser,
  reconcileUnsettledOpenCopyLotsForUser,
} from '../src/copyTrading/services/copyRedeemSettlement';
import {
  allocateFollowerMarketSellProceedsUsd,
  capCloseSizeToBuyBudget,
  capRedeemGroupProceedsToTxBudget,
  MAX_BINARY_SHARE_PAYOUT_USD,
  planFollowerRedeemProceedsUsd,
  scaleFillNotionalToFollowerClose,
} from '../src/copyTrading/services/copySettlementProceeds';
import { rebuildCopyPnlSummaryFromAggregatesForUser } from '../src/copyTrading/services/copyPnlSummaryLedger';
import { reconcileCopyPnlDailyTotalForUser } from '../src/copyTrading/services/copyPnlDailyLedger';
import { WALLET_LEDGER_CATEGORY } from '../src/services/custody/userWalletLedger';
import { getClobClientForUser } from '../src/services/polymarket/polymarketClob';
import { formatUnits } from 'viem';

const TX_HASH_RE = /^0x[a-f0-9]{64}$/i;
const EPS = 1e-8;
const REDEEM_LEADERS = new Set(['auto_redeem', 'manual_redeem']);

type LotCloseRow = {
  id: string;
  sellCopyTradeRowId: string;
  buyCopyTradeRowId: string;
  tokenID: string;
  closedSize: Prisma.Decimal;
  entryPrice: Prisma.Decimal;
  exitPrice: Prisma.Decimal;
  costBasisUsd: Prisma.Decimal;
  proceedsUsd: Prisma.Decimal;
  realizedPnlUsd: Prisma.Decimal;
  createdAt: Date;
};

type SellGroupPlan = {
  sellCopyTradeRowId: string;
  closes: LotCloseRow[];
  totalProceedsUsd: number;
  settlementType: string;
  txHash?: string;
  skipped?: string;
};

type CashAnchor = {
  depositUsd: number;
  balanceUsd: number;
  source: string;
};

type AnchorPassResult = {
  applied: boolean;
  oldProceeds: number;
  newProceeds: number;
  oldPnl: number;
  newPnl: number;
  targetProceeds: number;
  scale: number;
  anchor: CashAnchor;
};

type RepairGroupResult = {
  sellCopyTradeRowId: string;
  settlementType: string;
  totalClosed: number;
  oldProceeds: number;
  newProceeds: number;
  oldPnl: number;
  newPnl: number;
  skipped?: string;
};

function toNum(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value == null) return 0;
  const n = Number(value instanceof Prisma.Decimal ? value.toString() : value);
  return Number.isFinite(n) ? n : 0;
}

function dec(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(8));
}

function parseSellKey(sellCopyTradeRowId: string): { kind: 'legacy' | 'copy'; id: string } {
  if (sellCopyTradeRowId.startsWith('legacy:')) {
    return { kind: 'legacy', id: sellCopyTradeRowId.slice('legacy:'.length) };
  }
  return { kind: 'copy', id: sellCopyTradeRowId };
}

function groupLotCloses(rows: LotCloseRow[]): Map<string, LotCloseRow[]> {
  const grouped = new Map<string, LotCloseRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.sellCopyTradeRowId) ?? [];
    list.push(row);
    grouped.set(row.sellCopyTradeRowId, list);
  }
  return grouped;
}

type BuyLotBudget = {
  entrySize: number;
  entryPrice: number;
};

type CapCloseSizeResult = {
  cappedRows: number;
  oldClosed: number;
  newClosed: number;
};

async function loadBuyLotBudgets(userId: number): Promise<Map<string, BuyLotBudget>> {
  const lots = await prisma.copyPositionLot.findMany({
    where: { userId },
    select: { buyCopyTradeRowId: true, entrySize: true, entryPrice: true },
  });
  const budgets = new Map<string, BuyLotBudget>();
  for (const lot of lots) {
    budgets.set(lot.buyCopyTradeRowId, {
      entrySize: toNum(lot.entrySize),
      entryPrice: toNum(lot.entryPrice),
    });
  }
  return budgets;
}

/** Phase 2: never close more shares than the buy lot originally recorded. */
async function capLotCloseRowsToBuyEntrySizes(
  userId: number,
  closes: LotCloseRow[],
  dryRun: boolean
): Promise<CapCloseSizeResult> {
  const budgets = await loadBuyLotBudgets(userId);
  const closedSoFar = new Map<string, number>();
  let oldClosed = 0;
  let newClosed = 0;
  let cappedRows = 0;

  for (const row of closes) {
    const requested = toNum(row.closedSize);
    oldClosed += requested;
    const budget = budgets.get(row.buyCopyTradeRowId);
    if (!budget || !(budget.entrySize > EPS)) {
      newClosed += requested;
      continue;
    }

    const already = closedSoFar.get(row.buyCopyTradeRowId) ?? 0;
    const capped = capCloseSizeToBuyBudget({
      requestedCloseSize: requested,
      entryPrice: budget.entryPrice,
      entrySizeBudget: budget.entrySize,
      alreadyClosedFromBuy: already,
    });
    closedSoFar.set(row.buyCopyTradeRowId, already + capped.closeSize);
    newClosed += capped.closeSize;

    if (Math.abs(capped.closeSize - requested) > EPS) {
      cappedRows += 1;
      if (!dryRun) {
        const proceeds = requested > EPS ? toNum(row.proceedsUsd) * (capped.closeSize / requested) : 0;
        const realized = proceeds - capped.costBasisUsd;
        await prisma.copyPositionLotClose.update({
          where: { id: row.id },
          data: {
            closedSize: dec(capped.closeSize),
            costBasisUsd: dec(capped.costBasisUsd),
            exitPrice: dec(capped.closeSize > EPS ? proceeds / capped.closeSize : 0),
            proceedsUsd: dec(proceeds),
            realizedPnlUsd: dec(realized),
          },
        });
        row.closedSize = dec(capped.closeSize);
        row.costBasisUsd = dec(capped.costBasisUsd);
        row.proceedsUsd = dec(proceeds);
        row.realizedPnlUsd = dec(realized);
        row.exitPrice = dec(capped.closeSize > EPS ? proceeds / capped.closeSize : 0);
      } else {
        row.closedSize = dec(capped.closeSize);
        row.costBasisUsd = dec(capped.costBasisUsd);
      }
    }
  }

  return { cappedRows, oldClosed, newClosed };
}

async function repairSellGroup(params: {
  userId: number;
  sellCopyTradeRowId: string;
  closes: LotCloseRow[];
  redeemAddress: string;
}): Promise<SellGroupPlan> {
  const { sellCopyTradeRowId, closes, redeemAddress } = params;
  const totalClosed = closes.reduce((sum, row) => sum + toNum(row.closedSize), 0);
  if (!(totalClosed > EPS)) {
    return {
      sellCopyTradeRowId,
      closes,
      totalProceedsUsd: 0,
      settlementType: 'empty',
      skipped: 'zero_closed_size',
    };
  }

  const { kind, id } = parseSellKey(sellCopyTradeRowId);

  if (kind === 'legacy') {
    const execution = await prisma.copyExecution.findUnique({
      where: { id },
      select: {
        leaderAddress: true,
        polymarketOrderId: true,
        size: true,
        error: true,
      },
    });
    if (!execution) {
      return {
        sellCopyTradeRowId,
        closes,
        totalProceedsUsd: 0,
        settlementType: 'legacy_missing',
        skipped: 'execution_not_found',
      };
    }

    if (execution.leaderAddress === 'manual_expired') {
      return {
        sellCopyTradeRowId,
        closes,
        totalProceedsUsd: 0,
        settlementType: 'expired_worthless',
      };
    }

    if (REDEEM_LEADERS.has(execution.leaderAddress)) {
      const txHash = (execution.polymarketOrderId ?? '').trim().toLowerCase();
      if (!TX_HASH_RE.test(txHash)) {
        return {
          sellCopyTradeRowId,
          closes,
          totalProceedsUsd: 0,
          settlementType: 'redeem',
          skipped: 'missing_tx_hash',
        };
      }
      const chain = await resolveRedeemUsdcProceedsFromChain(txHash, redeemAddress);
      if (chain.kind !== 'confirmed') {
        return {
          sellCopyTradeRowId,
          closes,
          totalProceedsUsd: 0,
          settlementType: 'redeem',
          skipped: `chain_${chain.kind}`,
        };
      }
      const costBasisUsd = closes.reduce((sum, row) => sum + toNum(row.costBasisUsd), 0);
      const oldProceeds = closes.reduce((sum, row) => sum + toNum(row.proceedsUsd), 0);
      const oldPnl = closes.reduce((sum, row) => sum + toNum(row.realizedPnlUsd), 0);
      let totalProceedsUsd = planFollowerRedeemProceedsUsd({
        chainProceedsUsd: chain.usd,
        executionSizeShares: toNum(execution.size),
        followerCloseSizeShares: totalClosed,
      });
      // 链上 tx 可能是整钱包入账；勿把小额亏损 redeem 误修成大额盈利。
      // 但若链上已是 ≈ $1/share 全额赢面赎回，必须覆盖历史中间价低估（如 0.45×shares）。
      const newPnl = totalProceedsUsd - costBasisUsd;
      const chainExit =
        totalClosed > EPS ? chain.usd / totalClosed : 0;
      const looksLikeFullWinPayout =
        chainExit >= 0.9 && chainExit <= 1.05 + EPS;
      if (!looksLikeFullWinPayout && oldPnl < 0.2 && newPnl - oldPnl > 0.5) {
        totalProceedsUsd =
          oldProceeds > EPS ? oldProceeds : Math.min(chain.usd, totalClosed * MAX_BINARY_SHARE_PAYOUT_USD);
      }
      totalProceedsUsd = Math.min(totalProceedsUsd, chain.usd, totalClosed * MAX_BINARY_SHARE_PAYOUT_USD);
      return {
        sellCopyTradeRowId,
        closes,
        totalProceedsUsd,
        settlementType: 'redeem',
        txHash,
      };
    }

    return {
      sellCopyTradeRowId,
      closes,
      totalProceedsUsd: 0,
      settlementType: 'legacy_other',
      skipped: `leader_${execution.leaderAddress}`,
    };
  }

  const tradeRow = await prisma.copyTradeRow.findUnique({
    where: { id },
    include: { leaderTrade: { select: { side: true } } },
  });
  if (!tradeRow) {
    return {
      sellCopyTradeRowId,
      closes,
      totalProceedsUsd: 0,
      settlementType: 'copy_missing',
      skipped: 'copy_trade_row_not_found',
    };
  }
  if (tradeRow.leaderTrade.side !== 'SELL') {
    return {
      sellCopyTradeRowId,
      closes,
      totalProceedsUsd: 0,
      settlementType: 'copy_not_sell',
      skipped: 'not_a_sell_row',
    };
  }

  const oldProceeds = closes.reduce((sum, row) => sum + toNum(row.proceedsUsd), 0);
  const costBasisUsd = closes.reduce((sum, row) => sum + toNum(row.costBasisUsd), 0);
  const entryAvgPrice = totalClosed > EPS ? costBasisUsd / totalClosed : 0;
  const impliedExit = totalClosed > EPS ? oldProceeds / totalClosed : 0;

  // Healthy CLOB sells already have exit ∈ (0, $1]; leave them alone.
  // Re-scaling filledAmount×avgPrice when filledAmount > closedSize incorrectly halves
  // legitimate proceeds (e.g. 2.07 → 1.04) and flips user cumulative PnL negative.
  const looksLikeHealthyClobSell =
    impliedExit > EPS &&
    impliedExit <= 1.01 + EPS &&
    !(entryAvgPrice > EPS && entryAvgPrice < 0.1 && impliedExit > 0.9);
  if (looksLikeHealthyClobSell) {
    return {
      sellCopyTradeRowId,
      closes,
      totalProceedsUsd: oldProceeds,
      settlementType: 'market_sell',
      skipped: 'market_sell_ok',
    };
  }

  const filled = toNum(tradeRow.filledAmount ?? tradeRow.intendedSize);
  const avgPrice = toNum(tradeRow.avgPrice ?? tradeRow.intendedPrice);
  let fillNotionalUsd = filled > EPS && avgPrice > EPS ? filled * avgPrice : 0;
  if (!(fillNotionalUsd > EPS)) {
    fillNotionalUsd = Math.min(oldProceeds, totalClosed);
  } else if (filled > totalClosed * 1.05) {
    fillNotionalUsd = scaleFillNotionalToFollowerClose({
      fillNotionalUsd,
      fillSizeShares: filled,
      followerClosedSizeShares: totalClosed,
    });
  }

  const { proceedsUsd } = allocateFollowerMarketSellProceedsUsd({
    fillNotionalUsd,
    closedSizeShares: totalClosed,
    costBasisUsd,
    entryAvgPrice,
  });
  return {
    sellCopyTradeRowId,
    closes,
    totalProceedsUsd: proceedsUsd,
    settlementType: 'market_sell',
  };
}

async function capRedeemPlansByTxBudget(
  plans: SellGroupPlan[],
  redeemAddress: string
): Promise<number> {
  const byTx = new Map<string, SellGroupPlan[]>();
  for (const plan of plans) {
    if (!plan.txHash || plan.skipped) continue;
    const list = byTx.get(plan.txHash) ?? [];
    list.push(plan);
    byTx.set(plan.txHash, list);
  }

  let adjustedGroups = 0;
  for (const [txHash, groups] of byTx) {
    if (groups.length < 1) continue;
    const chain = await resolveRedeemUsdcProceedsFromChain(txHash, redeemAddress);
    if (chain.kind !== 'confirmed' || !(chain.usd > EPS)) continue;

    const planned = groups.map((group) => group.totalProceedsUsd);
    const plannedSum = planned.reduce((sum, value) => sum + value, 0);
    if (plannedSum <= chain.usd + 0.02) continue;

    const capped = capRedeemGroupProceedsToTxBudget(planned, chain.usd);
    for (let i = 0; i < groups.length; i++) {
      groups[i].totalProceedsUsd = capped[i] ?? groups[i].totalProceedsUsd;
    }
    adjustedGroups += groups.length;
  }
  return adjustedGroups;
}

/** 同一 redeem tx 全局只保留最早一组 proceeds，其余归零（避免链上一笔钱被多组分摊）。 */
async function zeroDuplicateRedeemTxPlans(
  plans: SellGroupPlan[],
  redeemAddress: string
): Promise<number> {
  const byTx = new Map<string, SellGroupPlan[]>();
  for (const plan of plans) {
    if (!plan.txHash || plan.skipped || plan.settlementType !== 'redeem') continue;
    const list = byTx.get(plan.txHash) ?? [];
    list.push(plan);
    byTx.set(plan.txHash, list);
  }

  let adjusted = 0;
  for (const groups of byTx.values()) {
    if (groups.length < 2) continue;

    groups.sort((a, b) => {
      const atA = Math.min(...a.closes.map((row) => row.createdAt.getTime()));
      const atB = Math.min(...b.closes.map((row) => row.createdAt.getTime()));
      return atA - atB;
    });

    const txHash = groups[0].txHash!;
    const chain = await resolveRedeemUsdcProceedsFromChain(txHash, redeemAddress);
    const budget = chain.kind === 'confirmed' && chain.usd > EPS ? chain.usd : 0;

    // One redeem tx → at most one settlement group. Diluting across markets creates
    // fake mid-price losses; keep only a unique full-win-sized group when possible.
    const fullWinIndexes: number[] = [];
    if (budget > EPS) {
      for (let i = 0; i < groups.length; i++) {
        const closed = groups[i].closes.reduce((s, row) => s + toNum(row.closedSize), 0);
        if (closed > EPS && budget + EPS >= closed * 0.9 && budget <= closed * 1.05 + EPS) {
          fullWinIndexes.push(i);
        }
      }
    }
    const keepIdx = fullWinIndexes.length === 1 ? fullWinIndexes[0] : -1;

    for (let i = 0; i < groups.length; i++) {
      if (i === keepIdx) {
        groups[i].totalProceedsUsd = Math.min(
          budget,
          groups[i].closes.reduce((s, row) => s + toNum(row.closedSize), 0)
        );
        continue;
      }
      if (groups[i].totalProceedsUsd > EPS || groups[i].settlementType === 'redeem') {
        adjusted += 1;
      }
      groups[i].totalProceedsUsd = 0;
      groups[i].settlementType = 'expired_worthless';
    }
  }

  return adjusted;
}

async function zeroAutoRedeemPlansAfterManualClose(
  userId: number,
  plans: SellGroupPlan[]
): Promise<number> {
  const manualRows = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: 'manual_close',
      side: 'SELL',
      status: 'filled',
    },
    select: { id: true, tokenID: true, createdAt: true },
  });
  const latestManualCloseAtByToken = new Map<string, Date>();
  for (const row of manualRows) {
    const key = row.tokenID.trim().toLowerCase();
    const prev = latestManualCloseAtByToken.get(key);
    if (!prev || row.createdAt > prev) {
      latestManualCloseAtByToken.set(key, row.createdAt);
    }
  }
  if (!latestManualCloseAtByToken.size) return 0;

  let adjusted = 0;
  for (const plan of plans) {
    if (plan.skipped || plan.settlementType !== 'redeem') continue;
    const { kind, id } = parseSellKey(plan.sellCopyTradeRowId);
    if (kind !== 'legacy') continue;

    const execution = await prisma.copyExecution.findUnique({
      where: { id },
      select: { tokenID: true, leaderAddress: true, createdAt: true },
    });
    if (!execution || !REDEEM_LEADERS.has(execution.leaderAddress)) continue;

    const manualAt = latestManualCloseAtByToken.get(execution.tokenID.trim().toLowerCase());
    if (!manualAt || execution.createdAt <= manualAt) continue;

    const oldProceeds = plan.closes.reduce((sum, row) => sum + toNum(row.proceedsUsd), 0);
    if (!(oldProceeds > 0.01)) continue;

    plan.totalProceedsUsd = 0;
    plan.settlementType = 'expired_worthless';
    adjusted += 1;
  }
  return adjusted;
}

async function syncLegacySettlementExecutionsFromLotCloses(
  userId: number,
  dryRun: boolean
): Promise<number> {
  const closes = await prisma.copyPositionLotClose.findMany({
    where: { userId, sellCopyTradeRowId: { startsWith: 'legacy:' } },
    select: {
      sellCopyTradeRowId: true,
      closedSize: true,
      proceedsUsd: true,
      realizedPnlUsd: true,
    },
  });
  const grouped = new Map<string, { closed: number; proceeds: number; pnl: number }>();
  for (const row of closes) {
    const key = row.sellCopyTradeRowId;
    const prev = grouped.get(key) ?? { closed: 0, proceeds: 0, pnl: 0 };
    prev.closed += toNum(row.closedSize);
    prev.proceeds += toNum(row.proceedsUsd);
    prev.pnl += toNum(row.realizedPnlUsd);
    grouped.set(key, prev);
  }

  let synced = 0;
  for (const [sellKey, totals] of grouped) {
    if (!(totals.closed > EPS)) continue;
    const executionId = sellKey.slice('legacy:'.length);
    const execution = await prisma.copyExecution.findUnique({
      where: { id: executionId },
      select: { notional: true },
    });
    if (!execution) continue;
    const stored = toNum(execution.notional);
    if (Math.abs(stored - totals.proceeds) <= 0.02) continue;
    synced += 1;
    if (dryRun) continue;
    await prisma.copyExecution.update({
      where: { id: executionId },
      data: {
        notional: dec(totals.proceeds),
        price: dec(totals.proceeds / totals.closed),
      },
    });
  }
  return synced;
}

async function resolveCashAnchor(userId: number): Promise<CashAnchor | null> {
  const envDeposit = Number(process.env.REPAIR_DEPOSIT_USD ?? '');
  const envBalance = Number(process.env.REPAIR_CURRENT_BALANCE_USD ?? '');

  let depositUsd = Number.isFinite(envDeposit) && envDeposit > 0 ? envDeposit : 0;
  let balanceUsd = Number.isFinite(envBalance) && envBalance >= 0 ? envBalance : NaN;
  const sources: string[] = [];

  if (!(depositUsd > 0)) {
    const ledger = await prisma.userWalletLedger.aggregate({
      where: {
        userId,
        direction: 'CREDIT',
        category: {
          in: [
            WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT,
            WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT_EXTERNAL,
            WALLET_LEDGER_CATEGORY.CHAIN_DEPOSIT,
            WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT_RETURN,
            WALLET_LEDGER_CATEGORY.POLYMARKET_FUNDER_CHAIN_DEPOSIT,
          ],
        },
      },
      _sum: { amount: true },
    });
    depositUsd = toNum(ledger._sum.amount);
    if (depositUsd > 0) sources.push('ledger_deposits');
  } else {
    sources.push('env_deposit');
  }

  if (!Number.isFinite(balanceUsd)) {
    try {
      const client = await getClobClientForUser(userId);
      const ba = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' as never });
      const raw =
        ba && typeof ba === 'object' && 'balance' in ba
          ? String((ba as { balance?: string }).balance ?? '0')
          : '0';
      balanceUsd = Number(formatUnits(BigInt(raw || '0'), 6));
      if (Number.isFinite(balanceUsd)) sources.push('clob_balance');
    } catch {
      balanceUsd = NaN;
    }
  } else {
    sources.push('env_balance');
  }

  if (!(depositUsd > 0) || !Number.isFinite(balanceUsd)) return null;
  return { depositUsd, balanceUsd, source: sources.join('+') };
}

async function applyEconomicAnchorPass(
  closes: LotCloseRow[],
  anchor: CashAnchor,
  dryRun: boolean
): Promise<AnchorPassResult> {
  const oldProceeds = closes.reduce((sum, row) => sum + toNum(row.proceedsUsd), 0);
  const oldPnl = closes.reduce((sum, row) => sum + toNum(row.realizedPnlUsd), 0);
  const totalCost = closes.reduce((sum, row) => sum + toNum(row.costBasisUsd), 0);
  const targetProceeds = totalCost + anchor.balanceUsd - anchor.depositUsd;

  if (!(oldProceeds > EPS) || Math.abs(oldProceeds - targetProceeds) <= 0.05) {
    return {
      applied: false,
      oldProceeds,
      newProceeds: oldProceeds,
      oldPnl,
      newPnl: oldPnl,
      targetProceeds,
      scale: 1,
      anchor,
    };
  }

  const scale = Math.max(0, targetProceeds / oldProceeds);
  let newProceeds = 0;
  let newPnl = 0;

  for (const row of closes) {
    const closedSize = toNum(row.closedSize);
    const costBasis = toNum(row.costBasisUsd);
    const proceeds = toNum(row.proceedsUsd) * scale;
    const exitPrice = closedSize > EPS ? proceeds / closedSize : 0;
    const realized = proceeds - costBasis;
    newProceeds += proceeds;
    newPnl += realized;

    row.exitPrice = dec(exitPrice);
    row.proceedsUsd = dec(proceeds);
    row.realizedPnlUsd = dec(realized);

    if (dryRun) continue;

    await prisma.copyPositionLotClose.update({
      where: { id: row.id },
      data: {
        exitPrice: dec(exitPrice),
        proceedsUsd: dec(proceeds),
        realizedPnlUsd: dec(realized),
      },
    });
  }

  return {
    applied: true,
    oldProceeds,
    newProceeds,
    oldPnl,
    newPnl,
    targetProceeds,
    scale,
    anchor,
  };
}

async function applyGroupRepairs(params: {
  userId: number;
  sellCopyTradeRowId: string;
  closes: LotCloseRow[];
  totalProceedsUsd: number;
  settlementType: string;
  dryRun: boolean;
}): Promise<RepairGroupResult> {
  const { sellCopyTradeRowId, closes, totalProceedsUsd, settlementType, dryRun } = params;
  const totalClosed = closes.reduce((sum, row) => sum + toNum(row.closedSize), 0);
  const oldProceeds = closes.reduce((sum, row) => sum + toNum(row.proceedsUsd), 0);
  const oldPnl = closes.reduce((sum, row) => sum + toNum(row.realizedPnlUsd), 0);

  let newProceeds = 0;
  let newPnl = 0;

  for (const row of closes) {
    const closedSize = toNum(row.closedSize);
    const costBasis = toNum(row.costBasisUsd);
    const share = totalClosed > EPS ? closedSize / totalClosed : 0;
    const proceeds = totalProceedsUsd * share;
    const exitPrice = closedSize > EPS ? proceeds / closedSize : 0;
    const realized = proceeds - costBasis;
    newProceeds += proceeds;
    newPnl += realized;

    row.exitPrice = dec(exitPrice);
    row.proceedsUsd = dec(proceeds);
    row.realizedPnlUsd = dec(realized);

    if (dryRun) continue;

    await prisma.copyPositionLotClose.update({
      where: { id: row.id },
      data: {
        exitPrice: dec(exitPrice),
        proceedsUsd: dec(proceeds),
        realizedPnlUsd: dec(realized),
      },
    });
  }

  if (!dryRun) {
    const { kind, id } = parseSellKey(sellCopyTradeRowId);
    if (kind === 'legacy') {
      const legacyData: {
        price: Prisma.Decimal;
        notional: Prisma.Decimal;
        leaderAddress?: string;
        error?: string;
      } = {
        price: dec(totalClosed > EPS ? totalProceedsUsd / totalClosed : 0),
        notional: dec(totalProceedsUsd),
      };
      if (settlementType === 'expired_worthless' && totalProceedsUsd <= EPS) {
        legacyData.leaderAddress = 'manual_expired';
        legacyData.error = 'auto_settled_expired_worthless';
      }
      await prisma.copyExecution.update({
        where: { id },
        data: legacyData,
      });
    } else {
      await prisma.copyTradeRow.update({
        where: { id },
        data: {
          realizedPnlUsd: dec(newPnl),
          realizedPnlAt: new Date(),
        },
      });
    }
  }

  return {
    sellCopyTradeRowId,
    settlementType,
    totalClosed,
    oldProceeds,
    newProceeds,
    oldPnl,
    newPnl,
  };
}

async function runReconcilePass(userId: number): Promise<void> {
  const ctx = await getExecutionWalletForUser(userId);
  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  const redeemAddress =
    deposit && deposit.toLowerCase() !== ctx.address.trim().toLowerCase() ? deposit : ctx.address;
  const positions = await fetchDataApiPositionsForWalletPair(
    { custodial: ctx.address, deposit },
    { sizeThreshold: 0, limit: 500, skipCache: true }
  );

  await reconcileUnsettledOpenCopyLotsForUser(userId, positions, redeemAddress, { maxRows: 500 });
  await reconcileMisstatedExpiredExecutionsForUser(userId, positions, redeemAddress, {
    maxRows: 500,
    chainConcurrency: 3,
  });
  await reconcileMisstatedRedeemExecutionsForUser(userId, redeemAddress, {
    maxRows: 500,
    chainConcurrency: 3,
  });
}

async function repairUserSettlementPnl(
  userId: number,
  options: { dryRun: boolean; skipReconcile: boolean; anchorCash: boolean }
) {
  const ctx = await getExecutionWalletForUser(userId);
  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  const redeemAddress =
    deposit && deposit.toLowerCase() !== ctx.address.trim().toLowerCase() ? deposit : ctx.address;

  const summaryBefore = await prisma.userSettings.findUnique({
    where: { userId },
    select: { copyPnlTotalUsd: true, copyPnlTodayUsd: true },
  });

  if (!options.skipReconcile && !options.dryRun) {
    console.log(`[repair] user=${userId} running reconcile pass...`);
    await runReconcilePass(userId);
  }

  const closes = await prisma.copyPositionLotClose.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });

  const capResult = await capLotCloseRowsToBuyEntrySizes(userId, closes, options.dryRun);
  if (capResult.cappedRows > 0) {
    console.log(
      `[repair] user=${userId} capped ${capResult.cappedRows} over-close row(s): closed ${capResult.oldClosed.toFixed(4)} -> ${capResult.newClosed.toFixed(4)} shares`
    );
  }

  const grouped = groupLotCloses(closes);
  const plans: SellGroupPlan[] = [];

  for (const [sellKey, group] of grouped) {
    const plan = await repairSellGroup({
      userId,
      sellCopyTradeRowId: sellKey,
      closes: group,
      redeemAddress,
    });
    plans.push(plan);
  }

  const redeemTxAdjustedGroups = await capRedeemPlansByTxBudget(plans, redeemAddress);
  if (redeemTxAdjustedGroups > 0) {
    console.log(`[repair] user=${userId} scaled ${redeemTxAdjustedGroups} redeem group(s) to chain tx budget`);
  }

  const manualCloseRedeemZeroed = await zeroAutoRedeemPlansAfterManualClose(userId, plans);
  if (manualCloseRedeemZeroed > 0) {
    console.log(
      `[repair] user=${userId} zeroed ${manualCloseRedeemZeroed} auto_redeem group(s) after manual_close`
    );
  }

  const duplicateTxZeroed = await zeroDuplicateRedeemTxPlans(plans, redeemAddress);
  if (duplicateTxZeroed > 0) {
    console.log(
      `[repair] user=${userId} zeroed ${duplicateTxZeroed} duplicate redeem tx group(s)`
    );
  }

  const results: RepairGroupResult[] = [];
  for (const plan of plans) {
    if (plan.skipped) {
      results.push({
        sellCopyTradeRowId: plan.sellCopyTradeRowId,
        settlementType: plan.settlementType,
        totalClosed: plan.closes.reduce((s, r) => s + toNum(r.closedSize), 0),
        oldProceeds: plan.closes.reduce((s, r) => s + toNum(r.proceedsUsd), 0),
        newProceeds: plan.closes.reduce((s, r) => s + toNum(r.proceedsUsd), 0),
        oldPnl: plan.closes.reduce((s, r) => s + toNum(r.realizedPnlUsd), 0),
        newPnl: plan.closes.reduce((s, r) => s + toNum(r.realizedPnlUsd), 0),
        skipped: plan.skipped,
      });
      continue;
    }

    const applied = await applyGroupRepairs({
      userId,
      sellCopyTradeRowId: plan.sellCopyTradeRowId,
      closes: plan.closes,
      totalProceedsUsd: plan.totalProceedsUsd,
      settlementType: plan.settlementType,
      dryRun: options.dryRun,
    });
    results.push(applied);
  }

  let anchorResult: AnchorPassResult | null = null;
  if (options.anchorCash) {
    const anchor = await resolveCashAnchor(userId);
    if (!anchor) {
      throw new Error(
        'anchor-cash requires REPAIR_DEPOSIT_USD and REPAIR_CURRENT_BALANCE_USD, or ledger deposits + live CLOB balance'
      );
    }
    anchorResult = await applyEconomicAnchorPass(closes, anchor, options.dryRun);
    if (anchorResult.applied) {
      console.log(
        `[repair] user=${userId} anchor-cash scale=${anchorResult.scale.toFixed(4)} proceeds ${anchorResult.oldProceeds.toFixed(2)} -> ${anchorResult.newProceeds.toFixed(2)} pnl ${anchorResult.oldPnl.toFixed(2)} -> ${anchorResult.newPnl.toFixed(2)}`
      );
    }
  }

  const syncedExecutions = await syncLegacySettlementExecutionsFromLotCloses(userId, options.dryRun);
  if (syncedExecutions > 0) {
    console.log(`[repair] user=${userId} synced ${syncedExecutions} legacy execution notionals from lot closes`);
  }

  let summaryAfter: { total: string; today: string } | null = null;
  if (!options.dryRun) {
    await rebuildCopyPnlSummaryFromAggregatesForUser(userId);
    await reconcileCopyPnlDailyTotalForUser(
      userId,
      `repair-copy-settlement-pnl:${Date.now()}`
    );
    const row = await prisma.userSettings.findUnique({
      where: { userId },
      select: { copyPnlTotalUsd: true, copyPnlTodayUsd: true },
    });
    summaryAfter = {
      total: (row?.copyPnlTotalUsd ?? new Prisma.Decimal(0)).toString(),
      today: (row?.copyPnlTodayUsd ?? new Prisma.Decimal(0)).toString(),
    };
  } else {
    let projectedPnl = results.reduce((sum, row) => sum + row.newPnl, 0);
    if (anchorResult?.applied) {
      projectedPnl = anchorResult.newPnl;
    }
    summaryAfter = { total: `(dry-run lot sum ${projectedPnl.toFixed(4)})`, today: 'n/a' };
  }

  const changed = results.filter(
    (row) => Math.abs(row.newProceeds - row.oldProceeds) > 0.01 || Math.abs(row.newPnl - row.oldPnl) > 0.01
  );

  console.log(
    JSON.stringify(
      {
        userId,
        dryRun: options.dryRun,
        redeemAddress,
        lotCloseGroups: results.length,
        cappedCloseRows: capResult.cappedRows,
        cappedCloseShares: `${capResult.oldClosed.toFixed(4)} -> ${capResult.newClosed.toFixed(4)}`,
        redeemTxAdjustedGroups,
        manualCloseRedeemZeroed,
        duplicateTxZeroed,
        syncedLegacyExecutions: syncedExecutions,
        anchorCash: anchorResult,
        changedGroups: changed.length,
        pnlSummaryBefore: {
          total: (summaryBefore?.copyPnlTotalUsd ?? new Prisma.Decimal(0)).toString(),
          today: (summaryBefore?.copyPnlTodayUsd ?? new Prisma.Decimal(0)).toString(),
        },
        pnlSummaryAfter: summaryAfter,
        changed: changed.map((row) => ({
          sell: row.sellCopyTradeRowId,
          type: row.settlementType,
          closed: row.totalClosed.toFixed(6),
          proceeds: `${row.oldProceeds.toFixed(4)} -> ${row.newProceeds.toFixed(4)}`,
          pnl: `${row.oldPnl.toFixed(4)} -> ${row.newPnl.toFixed(4)}`,
          skipped: row.skipped ?? null,
        })),
        skipped: results
          .filter((row) => row.skipped)
          .map((row) => ({ sell: row.sellCopyTradeRowId, reason: row.skipped })),
      },
      null,
      2
    )
  );
}

function parseUserIds(argv: string[]): number[] {
  if (argv.includes('--all')) {
    const raw = (process.env.REPAIR_USER_IDS ?? '').trim();
    if (!raw) {
      throw new Error('--all requires REPAIR_USER_IDS=1,2,3');
    }
    return raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  const userId = Number(argv[2]);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(
      'Usage: npx tsx scripts/repair-copy-settlement-pnl.ts <userId> [--dry-run] [--skip-reconcile] [--anchor-cash]'
    );
  }
  return [userId];
}

async function main(): Promise<void> {
  const argv = process.argv;
  const dryRun = argv.includes('--dry-run');
  const skipReconcile = argv.includes('--skip-reconcile');
  const anchorCash = argv.includes('--anchor-cash');
  const userIds = parseUserIds(argv);

  for (const userId of userIds) {
    await repairUserSettlementPnl(userId, { dryRun, skipReconcile, anchorCash });
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
