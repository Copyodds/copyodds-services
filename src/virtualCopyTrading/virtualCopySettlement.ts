import { Prisma } from '../generated/prisma/client';
import { prisma } from '../db';
import { virtualCopyMetrics } from '../observability/virtualCopyMetrics';
import { snapshotAccount } from './virtualAccountService';
import {
  getVirtualCopySettlementAdapter,
  type AuthoritativeVirtualSettlement,
} from './virtualCopySettlementAdapter';
import { ZERO } from './virtualCopyMath';

const SETTLEABLE_ACCOUNT_STATUSES = ['ACTIVE', 'PAUSED', 'EXPIRED_CLOSING'] as const;
const MIN_TARGET_NOTIONAL = new Prisma.Decimal('0.000000000000000001');

function settlementIdempotencyKey(params: {
  accountId: string;
  subscriptionId: string;
  tokenId: string;
  conditionId: string;
}): string {
  return [
    'virtual-market-settlement',
    params.accountId,
    params.subscriptionId,
    params.tokenId,
    params.conditionId.toLowerCase(),
  ].join(':');
}

async function settleAccountSubscriptionToken(
  accountId: string,
  subscriptionId: string,
  settlement: AuthoritativeVirtualSettlement,
): Promise<boolean> {
  const idempotencyKey = settlementIdempotencyKey({
    accountId,
    subscriptionId,
    tokenId: settlement.tokenId,
    conditionId: settlement.evidence.conditionId,
  });
  const payoutPrice = new Prisma.Decimal(settlement.payoutNumerator.toString())
    .div(settlement.payoutDenominator.toString());
  const observedAt = new Date(settlement.evidence.observedAt);

  return prisma.$transaction(async (tx) => {
    const accountLockStartedAt = performance.now();
    await tx.$queryRaw`SELECT 1 FROM "VirtualCopyAccount" WHERE "id" = ${accountId} FOR UPDATE`;
    virtualCopyMetrics.lockWaitSeconds
      .labels('settlement_account')
      .observe((performance.now() - accountLockStartedAt) / 1_000);
    const account = await tx.virtualCopyAccount.findUnique({ where: { id: accountId } });
    if (!account || !SETTLEABLE_ACCOUNT_STATUSES.includes(
      account.status as (typeof SETTLEABLE_ACCOUNT_STATUSES)[number],
    )) {
      return false;
    }
    const existing = await tx.virtualCopyExecution.findUnique({ where: { idempotencyKey } });
    if (existing) return false;

    const lotLockStartedAt = performance.now();
    await tx.$queryRaw`SELECT 1 FROM "VirtualPositionLot"
      WHERE "accountId" = ${accountId}
        AND "subscriptionId" = ${subscriptionId}
        AND "tokenId" = ${settlement.tokenId}
        AND "remainingSize" > 0
      ORDER BY "openedAt", "id" FOR UPDATE`;
    virtualCopyMetrics.lockWaitSeconds
      .labels('settlement_lots')
      .observe((performance.now() - lotLockStartedAt) / 1_000);
    const lots = await tx.virtualPositionLot.findMany({
      where: {
        accountId,
        subscriptionId,
        tokenId: settlement.tokenId,
        remainingSize: { gt: 0 },
      },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    });
    if (lots.length === 0) return false;

    const first = lots[0]!;
    const targetSize = lots.reduce((sum, lot) => sum.add(lot.remainingSize), ZERO);
    const costBasisUsd = lots.reduce(
      (sum, lot) => sum.add(lot.remainingSize.mul(lot.entryPrice)),
      ZERO,
    );
    const allocatedEntryFeeUsd = lots.reduce(
      (sum, lot) => sum.add(lot.entryFeeUsd),
      ZERO,
    );
    const proceedsUsd = targetSize.mul(payoutPrice);
    const realizedPnlUsd = proceedsUsd.sub(costBasisUsd).sub(allocatedEntryFeeUsd);
    const execution = await tx.virtualCopyExecution.create({
      data: {
        userId: first.userId,
        accountId,
        subscriptionId,
        leaderTradeId: null,
        leaderId: first.leaderId,
        leaderAddress: first.leaderAddress,
        marketId: first.marketId,
        marketTitle: null,
        tokenId: settlement.tokenId,
        outcome: null,
        side: 'SELL',
        status: 'SETTLED',
        leaderPrice: payoutPrice,
        targetSize,
        // Production integrity migration requires this field to be positive. The actual
        // payout remains represented by simulatedNotionalUsd and may legitimately be zero.
        targetNotionalUsd: Prisma.Decimal.max(costBasisUsd, MIN_TARGET_NOTIONAL),
        simulatedFillSize: targetSize,
        simulatedAvgPrice: payoutPrice,
        simulatedNotionalUsd: proceedsUsd,
        simulatedFeeUsd: ZERO,
        feeRate: ZERO,
        feeModelVersion: 'MARKET_RESOLUTION_NO_EXIT_FEE_V1',
        slippageAmountUsd: ZERO,
        slippageBps: 0,
        limitPrice: payoutPrice,
        unfilledSize: ZERO,
        fillModel: 'CTF_RESOLUTION_PAYOUT_V1',
        priceSource: 'POLYGON_CTF',
        executionSource: 'MARKET_SETTLEMENT',
        priceObservedAt: observedAt,
        priceStalenessMs: 0,
        settlementEvidence: settlement.evidence,
        idempotencyKey,
        configSnapshot: {
          settlement: true,
          conditionId: settlement.evidence.conditionId,
          outcomeIndex: settlement.evidence.outcomeIndex,
        },
        scheduledAt: observedAt,
        claimedAt: observedAt,
        filledAt: observedAt,
        settledAt: observedAt,
      },
    });

    for (const lot of lots) {
      const lotCostBasis = lot.remainingSize.mul(lot.entryPrice);
      const lotProceeds = lot.remainingSize.mul(payoutPrice);
      const lotRealizedPnl = lotProceeds.sub(lotCostBasis).sub(lot.entryFeeUsd);
      await tx.virtualPositionLot.update({
        where: { id: lot.id },
        data: {
          remainingSize: ZERO,
          entryFeeUsd: ZERO,
          status: 'CLOSED',
          closedAt: observedAt,
        },
      });
      await tx.virtualPositionLotClose.create({
        data: {
          userId: lot.userId,
          accountId,
          subscriptionId,
          lotId: lot.id,
          buyExecutionId: lot.buyExecutionId,
          sellExecutionId: execution.id,
          tokenId: settlement.tokenId,
          closedSize: lot.remainingSize,
          entryPrice: lot.entryPrice,
          exitPrice: payoutPrice,
          costBasisUsd: lotCostBasis,
          proceedsUsd: lotProceeds,
          allocatedEntryFeeUsd: lot.entryFeeUsd,
          exitFeeUsd: ZERO,
          allocatedFeeUsd: lot.entryFeeUsd,
          realizedPnlUsd: lotRealizedPnl,
          closeReason: 'MARKET_RESOLUTION',
          settlementEvidence: settlement.evidence,
        },
      });
    }

    const balanceAfterUsd = account.cashBalanceUsd.add(proceedsUsd);
    await tx.virtualCopyAccount.update({
      where: { id: accountId },
      data: {
        cashBalanceUsd: balanceAfterUsd,
        realizedPnlUsd: { increment: realizedPnlUsd },
        version: { increment: 1 },
      },
    });
    await tx.virtualAccountLedger.create({
      data: {
        userId: account.userId,
        accountId,
        direction: 'CREDIT',
        category: 'MARKET_SETTLEMENT',
        amountUsd: proceedsUsd,
        balanceAfterUsd,
        refType: 'VirtualCopyExecution',
        refId: execution.id,
        idempotencyKey: `virtual-market-settlement-ledger:${execution.id}`,
        metadata: {
          ...settlement.evidence,
          payoutPrice: payoutPrice.toString(),
          realizedPnlUsd: realizedPnlUsd.toString(),
        },
        occurredAt: observedAt,
      },
    });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function processVirtualMarketSettlements(limit = 100): Promise<{
  candidates: number;
  settled: number;
}> {
  const groups = await prisma.virtualPositionLot.findMany({
    where: {
      remainingSize: { gt: 0 },
      account: { status: { in: [...SETTLEABLE_ACCOUNT_STATUSES] } },
    },
    select: { accountId: true, subscriptionId: true, tokenId: true },
    distinct: ['accountId', 'subscriptionId', 'tokenId'],
    orderBy: [{ accountId: 'asc' }, { subscriptionId: 'asc' }, { tokenId: 'asc' }],
    take: Math.max(1, Math.min(limit, 1_000)),
  });
  const adapter = getVirtualCopySettlementAdapter();
  const resolutions = new Map<string, AuthoritativeVirtualSettlement | null>();
  let settled = 0;
  let resolvedOpenLots = 0;
  const changedAccounts = new Set<string>();
  for (const group of groups) {
    let resolution = resolutions.get(group.tokenId);
    if (resolution === undefined) {
      try {
        resolution = await adapter.resolve(group.tokenId);
      } catch {
        resolution = null;
      }
      resolutions.set(group.tokenId, resolution);
    }
    if (!resolution) continue;
    resolvedOpenLots += 1;
    if (await settleAccountSubscriptionToken(group.accountId, group.subscriptionId, resolution)) {
      settled += 1;
      virtualCopyMetrics.executions.labels('settled', 'none', 'sell', 'settlement').inc();
      changedAccounts.add(group.accountId);
    }
  }
  virtualCopyMetrics.resolvedOpenLots.set(resolvedOpenLots);
  for (const accountId of changedAccounts) {
    await snapshotAccount(accountId).catch((error) => {
      console.error('[virtual-copy-settlement] snapshot failed', {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return { candidates: groups.length, settled };
}
