/**
 * 对比跟单账本 vs Polymarket 链上持仓（Data API）。
 * Usage: npx tsx scripts/reconcile-user-copy-vs-chain.ts <userId>
 */
import '../src/loadEnv';
import { Prisma } from '../src/generated/prisma/client';
import { prisma } from '../src/db';
import { getExecutionWalletForUser } from '../src/services/polymarket/automationSession';
import { fetchDataApiPositionsForWalletPair } from '../src/services/polymarket/polymarketData';
import { isActiveValuedApiPosition } from '../src/services/polymarket/positionVisibility';

const EPS = 1e-9;
const userId = Number(process.argv[2] || 0);

function norm(tokenID: string): string {
  return tokenID.trim().toLowerCase();
}

async function main() {
  if (!userId) throw new Error('usage: npx tsx scripts/reconcile-user-copy-vs-chain.ts <userId>');

  const ctx = await getExecutionWalletForUser(userId);
  if (!ctx?.address) throw new Error('no wallet');

  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  const positions = await fetchDataApiPositionsForWalletPair(
    { custodial: ctx.address, deposit },
    { sizeThreshold: 0, limit: 200 }
  );

  const lots = await prisma.copyPositionLot.findMany({
    where: { userId },
    select: {
      tokenID: true,
      remainingSize: true,
      entrySize: true,
      entryPrice: true,
      leaderAddress: true,
    },
  });

  const filledBuys = await prisma.copyTradeRow.findMany({
    where: { userId, status: 'filled', leaderTrade: { side: 'BUY' } },
    select: {
      id: true,
      polymarketOrderId: true,
      filledAmount: true,
      avgPrice: true,
      createdAt: true,
      leaderTrade: { select: { tokenId: true, marketTitle: true, leaderAddress: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const legacySettlements = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: {
        in: ['manual_expired', 'manual_close', 'manual_redeem', 'auto_redeem'],
      },
      status: 'filled',
    },
    select: {
      id: true,
      leaderAddress: true,
      tokenID: true,
      size: true,
      notional: true,
      error: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const chainByToken = new Map<string, (typeof positions)[number]>();
  for (const p of positions) {
    if (Number(p.size) > EPS) chainByToken.set(norm(p.asset), p);
  }

  const openLotByToken = new Map<string, number>();
  for (const lot of lots) {
    const k = norm(lot.tokenID);
    openLotByToken.set(k, (openLotByToken.get(k) ?? 0) + Number(lot.remainingSize));
  }

  console.log('\n=== wallet ===');
  console.log(JSON.stringify({ custodial: ctx.address, deposit: deposit || ctx.address }, null, 2));

  console.log('\n=== chain positions (Data API) ===');
  for (const p of positions.filter((x) => Number(x.size) > EPS)) {
    console.log({
      token: p.asset.slice(0, 20) + '...',
      title: p.title?.slice(0, 60),
      size: p.size,
      curPrice: p.curPrice,
      value: p.currentValue,
      redeemable: p.redeemable,
      valued: isActiveValuedApiPosition(p),
    });
  }

  console.log('\n=== mismatches (chain has position, ledger drift) ===');
  for (const [tokenKey, p] of chainByToken) {
    const openLot = openLotByToken.get(tokenKey) ?? 0;
    const falseExpired = legacySettlements.filter(
      (r) => r.leaderAddress === 'manual_expired' && norm(r.tokenID) === tokenKey
    );
    if (isActiveValuedApiPosition(p) && openLot < Number(p.size) - 0.01) {
      console.log({
        issue: 'chain_open_but_lot_closed_or_partial',
        token: tokenKey.slice(0, 24) + '...',
        chainSize: p.size,
        openLotRemaining: openLot,
        falseManualExpired: falseExpired.length,
        title: p.title?.slice(0, 50),
      });
    }
  }

  console.log('\n=== phantom settlements (manual_expired on valued chain) ===');
  for (const row of legacySettlements.filter((r) => r.leaderAddress === 'manual_expired')) {
    const apiPos = chainByToken.get(norm(row.tokenID));
    if (apiPos && isActiveValuedApiPosition(apiPos)) {
      console.log({
        id: row.id,
        token: row.tokenID.slice(0, 24) + '...',
        error: row.error,
        createdAt: row.createdAt,
        chainSize: apiPos.size,
        chainValue: apiPos.currentValue,
      });
    }
  }

  console.log('\n=== recent filled BUY (has polymarket order = on-chain match) ===');
  for (const buy of filledBuys.slice(0, 15)) {
    console.log({
      id: buy.id,
      orderId: buy.polymarketOrderId,
      token: buy.leaderTrade.tokenId.slice(0, 20) + '...',
      title: buy.leaderTrade.marketTitle?.slice(0, 50),
      size: buy.filledAmount?.toString(),
      price: buy.avgPrice?.toString(),
      at: buy.createdAt,
    });
  }

  console.log('\n=== internal settlements (may not be 1:1 polygonscan lines) ===');
  for (const row of legacySettlements.slice(0, 20)) {
    console.log({
      type: row.leaderAddress,
      token: row.tokenID.slice(0, 20) + '...',
      notional: row.notional?.toString(),
      error: row.error,
      at: row.createdAt,
    });
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
