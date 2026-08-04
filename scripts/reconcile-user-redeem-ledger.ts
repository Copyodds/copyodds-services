/**
 * 将误写的 manual_expired 升级为 auto_redeem（需 PolymarketRedeemLog + 链上 USDC 入账）。
 *
 * Usage:
 *   npx tsx scripts/reconcile-user-redeem-ledger.ts <userId>
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { fetchDataApiPositionsForWalletPair } from '../src/services/polymarket/polymarketData';
import { getExecutionWalletForUser } from '../src/services/polymarket/automationSession';
import {
  reconcileMisstatedExpiredExecutionsForUser,
  reconcileMisstatedRedeemExecutionsForUser,
  reconcileUnsettledOpenCopyLotsForUser,
} from '../src/copyTrading/services/copyRedeemSettlement';

async function main(): Promise<void> {
  const userId = Number(process.argv[2]);
  if (!Number.isInteger(userId) || userId <= 0) {
    console.error('Usage: npx tsx scripts/reconcile-user-redeem-ledger.ts <userId>');
    process.exit(1);
  }

  const before = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: { in: ['manual_expired', 'auto_redeem', 'manual_redeem'] },
      side: 'SELL',
      status: 'filled',
    },
    select: {
      id: true,
      leaderAddress: true,
      tokenID: true,
      price: true,
      notional: true,
      polymarketOrderId: true,
      error: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log('[before]', JSON.stringify(before, null, 2));

  const ctx = await getExecutionWalletForUser(userId);
  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  const redeemAddress =
    deposit && deposit.toLowerCase() !== ctx.address.trim().toLowerCase() ? deposit : ctx.address;
  const positions = await fetchDataApiPositionsForWalletPair(
    { custodial: ctx.address, deposit },
    { sizeThreshold: 0, limit: 500 }
  );

  await reconcileUnsettledOpenCopyLotsForUser(userId, positions, redeemAddress, {
    maxRows: 200,
  });
  await reconcileMisstatedExpiredExecutionsForUser(userId, positions, redeemAddress, {
    maxRows: 200,
    chainConcurrency: 3,
  });
  await reconcileMisstatedRedeemExecutionsForUser(userId, redeemAddress, {
    maxRows: 200,
    chainConcurrency: 3,
  });

  const closes = await prisma.copyPositionLotClose.findMany({
    where: {
      userId,
      sellCopyTradeRowId: { in: before.map((row) => `legacy:${row.id}`) },
    },
    select: {
      sellCopyTradeRowId: true,
      exitPrice: true,
      proceedsUsd: true,
      realizedPnlUsd: true,
      costBasisUsd: true,
    },
  });

  const after = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: { in: ['manual_expired', 'auto_redeem', 'manual_redeem'] },
      side: 'SELL',
      status: 'filled',
    },
    select: {
      id: true,
      leaderAddress: true,
      tokenID: true,
      price: true,
      notional: true,
      polymarketOrderId: true,
      error: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log('[after]', JSON.stringify(after, null, 2));
  console.log('[lot_closes]', JSON.stringify(closes, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
