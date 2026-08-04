import { Prisma } from '../generated/prisma/client';

export type DecimalValue = ConstructorParameters<typeof Prisma.Decimal>[0];
export const D = (value: DecimalValue): Prisma.Decimal => new Prisma.Decimal(value);
export const ZERO = D(0);

export function hasSufficientVirtualCash(
  cashBalanceUsd: DecimalValue,
  requiredCashUsd: DecimalValue,
): boolean {
  return D(cashBalanceUsd).gte(D(requiredCashUsd));
}

export type FifoLot = {
  id: string;
  remainingSize: DecimalValue;
  entryPrice: DecimalValue;
  entryFeeUsd?: DecimalValue;
};

export function planFifoCloses(
  lots: FifoLot[],
  requestedSize: DecimalValue,
  exitPrice: DecimalValue,
  exitFeeRate: DecimalValue = 0,
) {
  let remaining = D(requestedSize);
  const exit = D(exitPrice);
  const feeRate = D(exitFeeRate);
  const closes: Array<{
    lotId: string;
    closedSize: Prisma.Decimal;
    allocatedEntryFeeUsd: Prisma.Decimal;
    exitFeeUsd: Prisma.Decimal;
    costBasisUsd: Prisma.Decimal;
    proceedsUsd: Prisma.Decimal;
    realizedPnlUsd: Prisma.Decimal;
  }> = [];
  for (const lot of lots) {
    if (remaining.lte(0)) break;
    const available = D(lot.remainingSize);
    if (available.lte(0)) continue;
    const closedSize = Prisma.Decimal.min(available, remaining);
    const entryFee = D(lot.entryFeeUsd ?? 0);
    const allocatedEntryFee = available.gt(0) ? entryFee.mul(closedSize).div(available) : ZERO;
    const costBasisUsd = D(lot.entryPrice).mul(closedSize).add(allocatedEntryFee);
    const grossProceedsUsd = exit.mul(closedSize);
    const exitFeeUsd = grossProceedsUsd.mul(feeRate);
    const proceedsUsd = grossProceedsUsd.sub(exitFeeUsd);
    closes.push({
      lotId: lot.id,
      closedSize,
      allocatedEntryFeeUsd: allocatedEntryFee,
      exitFeeUsd,
      costBasisUsd,
      proceedsUsd,
      realizedPnlUsd: proceedsUsd.sub(costBasisUsd),
    });
    remaining = remaining.sub(closedSize);
  }
  return {
    closes,
    filledSize: D(requestedSize).sub(remaining),
    unfilledSize: remaining,
  };
}
