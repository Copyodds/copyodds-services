/**
 * 批量撤销「链上仍有价值」的误触发 manual_expired。
 * Usage: npx tsx scripts/revert-all-false-manual-expired.ts <userId> [--dry-run]
 */
import '../src/loadEnv';
import { Prisma } from '../src/generated/prisma/client';
import { prisma } from '../src/db';
import { getExecutionWalletForUser } from '../src/services/polymarket/automationSession';
import { fetchDataApiPositionsForWalletPair } from '../src/services/polymarket/polymarketData';
import {
  isActiveValuedApiPosition,
  WORTHLESS_POSITION_VALUE_MAX_USD,
} from '../src/services/polymarket/positionVisibility';

const EPS = 1e-9;
const userId = Number(process.argv[2] || 0);
const dryRun = process.argv.includes('--dry-run');

function normalizeTokenId(tokenID: string): string {
  return tokenID.trim().toLowerCase();
}

async function revertOne(params: {
  userId: number;
  manualId: string;
  tokenID: string;
  apiAsset: string;
}): Promise<boolean> {
  const sellKey = `legacy:${params.manualId}`;
  const closes = await prisma.copyPositionLotClose.findMany({
    where: { userId: params.userId, sellCopyTradeRowId: sellKey },
    select: { id: true, lotId: true, closedSize: true, realizedPnlUsd: true },
  });
  if (!closes.length) {
    console.warn('[skip] no lot closes', { manualId: params.manualId, token: params.tokenID });
    return false;
  }

  if (dryRun) {
    console.info('[dry-run] would revert', {
      manualId: params.manualId,
      token: params.apiAsset,
      closes: closes.length,
    });
    return true;
  }

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
          where: { userId: params.userId },
          select: { copyPnlTotalUsd: true, copyPnlTodayUsd: true },
        });
        if (summary?.copyPnlTotalUsd != null) {
          await tx.userSettings.update({
            where: { userId: params.userId },
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
    await tx.copyExecution.delete({ where: { id: params.manualId } });
  });

  console.info('[reverted]', { manualId: params.manualId, token: params.apiAsset });
  return true;
}

async function main() {
  if (!userId) {
    throw new Error('usage: npx tsx scripts/revert-all-false-manual-expired.ts <userId> [--dry-run]');
  }

  const ctx = await getExecutionWalletForUser(userId);
  if (!ctx?.address) throw new Error('no wallet for user');

  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  const positions = await fetchDataApiPositionsForWalletPair(
    { custodial: ctx.address, deposit },
    { sizeThreshold: 0, limit: 200 }
  );

  const manualRows = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: 'manual_expired',
      side: 'SELL',
      status: 'filled',
    },
    orderBy: { createdAt: 'desc' },
  });

  console.info('[scan]', {
    userId,
    wallet: ctx.address,
    deposit: deposit || ctx.address,
    chainPositions: positions.filter((p) => Number(p.size) > EPS).length,
    manualExpiredRows: manualRows.length,
    dryRun,
  });

  let reverted = 0;
  let skipped = 0;

  for (const manual of manualRows) {
    const tokenKey = normalizeTokenId(manual.tokenID);
    const apiPos =
      positions.find((p) => normalizeTokenId(p.asset) === tokenKey) ??
      positions.find((p) => normalizeTokenId(p.asset).includes(tokenKey.slice(0, 12))) ??
      null;

    const walletValue = Number(
      apiPos?.currentValue ?? Number(apiPos?.curPrice ?? 0) * Number(apiPos?.size ?? 0)
    );
    const shouldRevert =
      apiPos &&
      Number(apiPos.size) > EPS &&
      Number.isFinite(walletValue) &&
      walletValue > WORTHLESS_POSITION_VALUE_MAX_USD &&
      isActiveValuedApiPosition(apiPos);

    if (!shouldRevert) {
      skipped += 1;
      console.info('[keep]', {
        manualId: manual.id,
        token: manual.tokenID,
        reason: apiPos ? 'worthless_or_flat' : 'no_chain_position',
        walletValue: Number.isFinite(walletValue) ? walletValue : null,
      });
      continue;
    }

    const ok = await revertOne({
      userId,
      manualId: manual.id,
      tokenID: manual.tokenID,
      apiAsset: apiPos.asset,
    });
    if (ok) reverted += 1;
  }

  console.info('[done]', { reverted, skipped, dryRun });
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
