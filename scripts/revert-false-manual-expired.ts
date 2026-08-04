/**
 * 撤销误触发的 manual_expired（链上仍有价值持仓时）。
 * Usage: npx tsx scripts/revert-false-manual-expired.ts <userId> <tokenIdPrefix>
 */
import '../src/loadEnv';
import { Prisma } from '../src/generated/prisma/client';
import { prisma } from '../src/db';
import { getExecutionWalletForUser } from '../src/services/polymarket/automationSession';
import { fetchDataApiPositionsForWalletPair } from '../src/services/polymarket/polymarketData';
import { WORTHLESS_POSITION_VALUE_MAX_USD } from '../src/services/polymarket/positionVisibility';

const EPS = 1e-9;
const userId = Number(process.argv[2] || 0);
const tokenPrefix = (process.argv[3] || '').trim().toLowerCase();

function normalizeTokenId(tokenID: string): string {
  return tokenID.trim().toLowerCase();
}

async function main() {
  if (!userId || !tokenPrefix) {
    throw new Error('usage: npx tsx scripts/revert-false-manual-expired.ts <userId> <tokenIdPrefix>');
  }

  const ctx = await getExecutionWalletForUser(userId);
  if (!ctx?.address) throw new Error('no wallet for user');

  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  const positions = await fetchDataApiPositionsForWalletPair(
    { custodial: ctx.address, deposit },
    { sizeThreshold: 0, limit: 200 }
  );
  const apiPos =
    positions.find((p) => normalizeTokenId(p.asset).includes(tokenPrefix)) ?? null;
  const walletValue = Number(apiPos?.currentValue ?? Number(apiPos?.curPrice ?? 0) * Number(apiPos?.size ?? 0));
  if (!(apiPos && apiPos.size > EPS && Number.isFinite(walletValue) && walletValue > WORTHLESS_POSITION_VALUE_MAX_USD)) {
    throw new Error('chain position missing or still worthless; refuse revert');
  }

  const manualRows = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: 'manual_expired',
      side: 'SELL',
      status: 'filled',
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const manual = manualRows.find((row) => normalizeTokenId(row.tokenID).includes(tokenPrefix));
  if (!manual) throw new Error('no manual_expired row for token');

  const sellKey = `legacy:${manual.id}`;
  const closes = await prisma.copyPositionLotClose.findMany({
    where: { userId, sellCopyTradeRowId: sellKey },
    select: { id: true, lotId: true, closedSize: true, realizedPnlUsd: true },
  });
  if (!closes.length) throw new Error('manual_expired has no lot closes');

  await prisma.$transaction(async (tx) => {
    for (const close of closes) {
      const lot = await tx.copyPositionLot.findUnique({
        where: { id: close.lotId },
        select: { id: true, remainingSize: true },
      });
      if (!lot) continue;
      const next = Number(lot.remainingSize) + Number(close.closedSize);
      await tx.copyPositionLot.update({
        where: { id: lot.id },
        data: { remainingSize: new Prisma.Decimal(next.toFixed(8)) },
      });
      const pnl = Number(close.realizedPnlUsd);
      if (Number.isFinite(pnl) && Math.abs(pnl) > EPS) {
        const summary = await tx.userSettings.findUnique({
          where: { userId },
          select: { copyPnlTotalUsd: true, copyPnlTodayUsd: true },
        });
        if (summary?.copyPnlTotalUsd != null) {
          await tx.userSettings.update({
            where: { userId },
            data: {
              copyPnlTotalUsd: new Prisma.Decimal(
                (Number(summary.copyPnlTotalUsd) - pnl).toFixed(8)
              ),
              ...(summary.copyPnlTodayUsd != null
                ? {
                    copyPnlTodayUsd: new Prisma.Decimal(
                      (Number(summary.copyPnlTodayUsd) - pnl).toFixed(8)
                    ),
                  }
                : {}),
            },
          });
        }
      }
      await tx.copyPositionLotClose.delete({ where: { id: close.id } });
    }
    await tx.copyExecution.delete({ where: { id: manual.id } });
  });

  console.info('[revert-false-manual-expired] ok', {
    userId,
    token: apiPos.asset,
    manualExpiredId: manual.id,
    closesReverted: closes.length,
    walletValue,
  });

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
