/**
 * 核对用户赎回 tx 是否真的有 USDC.e 入账，以及当前可赎回持仓。
 *
 * Usage:
 *   npx tsx scripts/verify-user-redeem-proceeds.ts <userId>
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { getExecutionWalletForUser } from '../src/services/polymarket/automationSession';
import { fetchDataApiPositionsForWalletPair } from '../src/services/polymarket/polymarketData';
import { resolveRedeemUsdcProceedsFromChain } from '../src/services/polymarket/redeemProceedsFromChain';
import { redeemProceedsUsdFromLog } from '../src/services/polymarket/polymarketRedeem';

async function main(): Promise<void> {
  const userId = Number(process.argv[2]);
  if (!Number.isInteger(userId) || userId <= 0) {
    console.error('Usage: npx tsx scripts/verify-user-redeem-proceeds.ts <userId>');
    process.exit(1);
  }

  const ctx = await getExecutionWalletForUser(userId);
  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  const redeemAddress =
    deposit && deposit.toLowerCase() !== ctx.address.trim().toLowerCase() ? deposit : ctx.address;

  console.log('wallets', {
    userId,
    custodial: ctx.address,
    polymarketDeposit: deposit || null,
    redeemAddress,
  });

  const logs = await prisma.polymarketRedeemLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });

  for (const log of logs) {
    const chain = await resolveRedeemUsdcProceedsFromChain(log.txHash, redeemAddress);
    const fromHelper = await redeemProceedsUsdFromLog(userId, log.conditionId, redeemAddress);
    console.log('redeem_log', {
      conditionId: log.conditionId,
      txHash: log.txHash,
      createdAt: log.createdAt.toISOString(),
      chainProceedsUsd: chain.kind === 'confirmed' ? chain.usd : chain.kind,
      helperProceedsUsd: fromHelper,
      polygonscan: `https://polygonscan.com/tx/${log.txHash}`,
    });
  }

  const positions = await fetchDataApiPositionsForWalletPair(
    { custodial: ctx.address, deposit },
    { sizeThreshold: 0, limit: 200, skipCache: true }
  );

  const redeemable = positions.filter((p) => p.redeemable === true && p.size > 0);
  console.log(
    'redeemable_positions',
    redeemable.map((p) => ({
      title: p.title,
      outcome: p.outcome,
      outcomeIndex: p.outcomeIndex,
      size: p.size,
      currentValue: p.currentValue,
      conditionId: p.conditionId,
      asset: p.asset,
    }))
  );

  const openLots = await prisma.copyPositionLot.findMany({
    where: { userId, remainingSize: { gt: 0 } },
    select: { tokenID: true, remainingSize: true, entryPrice: true },
  });
  console.log(
    'open_copy_lots',
    openLots.map((row) => ({
      tokenID: row.tokenID,
      remainingSize: row.remainingSize.toString(),
      entryPrice: row.entryPrice.toString(),
    }))
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
