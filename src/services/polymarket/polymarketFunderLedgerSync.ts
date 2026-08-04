import { getAddress, parseAbiItem } from 'viem';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  isInternalPolymarketCollateralUsdcSender,
  isPolymarketCtfRedeemSender,
  publicClient,
  USDC_E_ADDRESS,
} from './web3';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from '../custody/userWalletLedger';

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

const lastFunderSyncAtMs = new Map<number, number>();

/**
 * GET /wallet-ledger 首页：在有限区块窗口内同步 USDC.e 转入用户 Polymarket 保证金地址的 Transfer，写入 UserWalletLedger。
 * 不写入 CustodyChainDeposit；与定时全网约扫块游标无关。
 *
 * 跳过 from=托管地址 → 保证金的转账：该笔已由 POLYMARKET_DEPOSIT 记录，避免重复。
 */
export async function trySyncPolymarketFunderDepositsForUser(userId: number): Promise<{
  inserted: number;
  skipped: boolean;
  reason?: 'rate_limited' | 'no_funder' | 'rpc_error';
  message?: string;
}> {
  const now = Date.now();
  const minMs = CONFIG.custodyWalletLedgerSyncMinIntervalMs;
  const last = lastFunderSyncAtMs.get(userId) ?? 0;
  if (now - last < minMs) {
    return { inserted: 0, skipped: true, reason: 'rate_limited' };
  }

  const w = await prisma.wallet.findFirst({
    where: { userId, type: 'CUSTODIAL' } as any,
    orderBy: { createdAt: 'asc' },
    select: { address: true, polymarketFunderAddress: true },
  });
  const custodial = (w?.address ?? '').trim();
  const funderRaw = (w?.polymarketFunderAddress ?? '').trim();
  if (!w || !custodial || !funderRaw || funderRaw.toLowerCase() === custodial.toLowerCase()) {
    return { inserted: 0, skipped: true, reason: 'no_funder' };
  }

  const lookback = BigInt(CONFIG.custodyWalletLedgerSyncLookbackBlocks);
  const custodialLower = custodial.toLowerCase();

  try {
    const latest = await publicClient.getBlockNumber();
    const fromBlock = latest > lookback ? latest - lookback : 0n;
    const toBlock = latest;

    if (fromBlock > toBlock) {
      lastFunderSyncAtMs.set(userId, Date.now());
      return { inserted: 0, skipped: false };
    }

    const funderAddr = getAddress(funderRaw as `0x${string}`);
    const logs = await publicClient.getLogs({
      address: USDC_E_ADDRESS,
      event: transferEvent,
      args: { to: funderAddr },
      fromBlock,
      toBlock,
    });

    lastFunderSyncAtMs.set(userId, Date.now());

    let inserted = 0;
    for (const log of logs) {
      const txHash = log.transactionHash;
      const logIndex = log.logIndex;
      const blockNumber = log.blockNumber;
      if (txHash == null || logIndex == null || blockNumber == null) continue;

      const args = log.args as { from?: `0x${string}`; to?: `0x${string}`; value?: bigint } | undefined;
      const fromAddr = args?.from ?? '';
      const value = args?.value ?? 0n;
      if (value === 0n) continue;
      if (fromAddr && fromAddr.toLowerCase() === custodialLower) {
        continue;
      }
      if (isInternalPolymarketCollateralUsdcSender(fromAddr)) {
        continue;
      }

      const idempotencyKey = `chain-pm-funder-${txHash}-${Number(logIndex)}`;
      const amountHuman = new Prisma.Decimal(value.toString()).div(1_000_000);
      const isRedeem = isPolymarketCtfRedeemSender(fromAddr);
      const { created } = await appendUserWalletLedger({
        userId,
        rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
        direction: WALLET_LEDGER_DIRECTION.CREDIT,
        amount: amountHuman,
        symbol: 'USDC',
        category: isRedeem
          ? WALLET_LEDGER_CATEGORY.POLYMARKET_REDEEM
          : WALLET_LEDGER_CATEGORY.POLYMARKET_FUNDER_CHAIN_DEPOSIT,
        refType: 'ONCHAIN_TRANSFER',
        refId: `${txHash}:${Number(logIndex)}`,
        idempotencyKey,
        metadata: {
          txHash,
          logIndex: Number(logIndex),
          fromAddress: fromAddr,
          toAddress: funderAddr,
          amountRaw: value.toString(),
          blockNumber: blockNumber.toString(),
          polymarketFunder: funderAddr,
        },
      });
      if (created) inserted += 1;
    }

    return { inserted, skipped: false };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { inserted: 0, skipped: true, reason: 'rpc_error', message };
  }
}
