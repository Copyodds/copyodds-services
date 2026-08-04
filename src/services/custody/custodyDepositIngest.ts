import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { isInternalPolymarketCollateralUsdcSender } from '../polymarket/web3';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from './userWalletLedger';

/**
 * 将单条 USDC Transfer 日志写入 CustodyChainDeposit + UserWalletLedger（幂等：txHash+logIndex）。
 * 供定时扫块与「查询时按需同步」共用。
 */
export async function ingestCustodyTransferLog(input: {
  userId: number;
  walletId: number;
  walletAddress: string;
  log: {
    transactionHash?: `0x${string}` | null;
    logIndex?: number | null;
    blockNumber?: bigint | null;
    args?: { from?: string; to?: string; value?: bigint };
  };
}): Promise<'inserted' | 'duplicate'> {
  const txHash = input.log.transactionHash;
  const logIndex = input.log.logIndex;
  const blockNumber = input.log.blockNumber;
  if (txHash == null || logIndex == null || blockNumber == null) {
    return 'duplicate';
  }

  const args = input.log.args;
  const fromAddr = args?.from ?? '';
  const value = args?.value ?? 0n;

  const fromLower = fromAddr.trim().toLowerCase();
  if (isInternalPolymarketCollateralUsdcSender(fromAddr)) {
    return 'duplicate';
  }

  const walletMeta = await prisma.wallet.findUnique({
    where: { id: input.walletId },
    select: { polymarketFunderAddress: true },
  });
  const funderLower = (walletMeta?.polymarketFunderAddress ?? '').trim().toLowerCase();
  if (funderLower && fromLower === funderLower) {
    return 'duplicate';
  }

  const idempotencyKey = `chain-dep-${txHash}-${Number(logIndex)}`;
  try {
    await prisma.$transaction(async (tx) => {
      const dep = await tx.custodyChainDeposit.create({
        data: {
          userId: input.userId,
          walletId: input.walletId,
          txHash,
          logIndex: Number(logIndex),
          fromAddress: fromAddr,
          toAddress: input.walletAddress,
          amountRaw: value.toString(),
          blockNumber,
        },
      });
      const amountHuman = new Prisma.Decimal(value.toString()).div(1_000_000);

      // If this on-chain transfer is a known commission payout (we write a separate COMMISSION_* ledger row),
      // do not also emit a generic CHAIN_DEPOSIT row to avoid duplicate UI entries.
      // Commission ledger rows carry the same txHash in metadata.
      const suppressChainDeposit = await tx.userWalletLedger.findFirst({
        where: {
          userId: input.userId,
          rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
          OR: [
            {
              category: WALLET_LEDGER_CATEGORY.COMMISSION_ONCHAIN_USDC,
              direction: WALLET_LEDGER_DIRECTION.CREDIT,
              amount: amountHuman,
              metadata: { path: ['txHash'], equals: txHash } as any,
            },
            {
              category: WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT_RETURN,
              metadata: { path: ['txHash'], equals: txHash } as any,
            },
            {
              category: WALLET_LEDGER_CATEGORY.PACKAGE_PURCHASE,
              metadata: { path: ['txHash'], equals: txHash } as any,
            },
          ],
        } as any,
        select: { id: true },
      });

      if (!suppressChainDeposit) {
        await appendUserWalletLedger(
          {
            userId: input.userId,
            rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
            direction: WALLET_LEDGER_DIRECTION.CREDIT,
            amount: amountHuman,
            symbol: 'USDC',
            category: WALLET_LEDGER_CATEGORY.CHAIN_DEPOSIT,
            refType: 'CustodyChainDeposit',
            refId: dep.id,
            idempotencyKey,
            metadata: {
              txHash,
              logIndex: Number(logIndex),
              fromAddress: fromAddr,
              toAddress: input.walletAddress,
              amountRaw: value.toString(),
              blockNumber: blockNumber.toString(),
            },
          },
          tx,
        );
      }
    });
    return 'inserted';
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === 'P2002') return 'duplicate';
    throw e;
  }
}
