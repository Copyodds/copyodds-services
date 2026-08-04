import { getAddress, parseAbiItem } from 'viem';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { publicClient, USDC_E_ADDRESS, USDC_NATIVE_ADDRESS, USDT_POLYGON_ADDRESS, USDT0_POLYGON_ADDRESS } from '../polymarket/web3';
import { ingestCustodyTransferLog } from './custodyDepositIngest';

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/** 每用户上次按需同步时间（进程内；多实例需 Redis 才严格） */
const lastSyncAtMs = new Map<number, number>();

/**
 * GET /wallet-ledger 首页拉取时：用 RPC 在有限区块窗口内同步当前用户托管地址的 USDC 转入，再读库。
 * 限频、不推进 CustodyDepositScanCursor（可选 Node 扫块任务负责全网约推进）。
 */
export async function trySyncCustodyDepositsForUser(userId: number): Promise<{
  inserted: number;
  skipped: boolean;
  reason?: 'rate_limited' | 'no_custodial_wallet' | 'rpc_error';
  message?: string;
}> {
  const now = Date.now();
  const minMs = CONFIG.custodyWalletLedgerSyncMinIntervalMs;
  const last = lastSyncAtMs.get(userId) ?? 0;
  if (now - last < minMs) {
    return { inserted: 0, skipped: true, reason: 'rate_limited' };
  }

  const w = await prisma.wallet.findFirst({
    where: { userId, type: 'CUSTODIAL' } as any,
    orderBy: { createdAt: 'asc' },
    select: { id: true, address: true },
  });
  if (!w) {
    return { inserted: 0, skipped: true, reason: 'no_custodial_wallet' };
  }

  const lookback = BigInt(CONFIG.custodyWalletLedgerSyncLookbackBlocks);

  try {
    const latest = await publicClient.getBlockNumber();
    const fromBlock = latest > lookback ? latest - lookback : 0n;
    const toBlock = latest;

    if (fromBlock > toBlock) {
      lastSyncAtMs.set(userId, Date.now());
      return { inserted: 0, skipped: false };
    }

    const toAddr = getAddress(w.address as `0x${string}`);
    let inserted = 0;

    for (const token of [USDC_E_ADDRESS, USDC_NATIVE_ADDRESS, USDT_POLYGON_ADDRESS, USDT0_POLYGON_ADDRESS] as const) {
      const logs = await publicClient.getLogs({
        address: token,
        event: transferEvent,
        args: { to: toAddr },
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        const r = await ingestCustodyTransferLog({
          userId,
          walletId: w.id,
          walletAddress: w.address,
          log,
        });
        if (r === 'inserted') inserted += 1;
      }
    }

    lastSyncAtMs.set(userId, Date.now());

    return { inserted, skipped: false };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { inserted: 0, skipped: true, reason: 'rpc_error', message };
  }
}
