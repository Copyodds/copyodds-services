import { getAddress } from 'viem';
import { prisma } from '../../db';
import { Code } from '../../utils/response';
import { resolveUsdcVariant } from './usdcTokenVariant';
import { ingestCustodyTransferLog } from './custodyDepositIngest';
import { triggerCustodialEoaDepositPipeline } from './custodialEoaDepositForward';

export type CustodialEoaWatchWallet = {
  userId: number;
  custodialAddress: string;
  funderAddress: string;
  walletIndex: number | null;
};

export type CustodialEoaDepositSource = 'go_chain_monitor' | 'node_custody_scan';

/** Go chain_monitor 拉取：需监测的 custodial EOA 地址列表。 */
export async function listCustodialEoaWatchWallets(): Promise<CustodialEoaWatchWallet[]> {
  type WalletRow = {
    userId: number | null;
    address: string;
    polymarketFunderAddress: string | null;
    walletIndex: number | null;
  };

  const wallets = (await prisma.wallet.findMany({
    where: {
      type: 'CUSTODIAL',
      userId: { not: null },
      polymarketFunderAddress: { not: null },
    } as any,
    select: {
      userId: true,
      address: true,
      polymarketFunderAddress: true,
      walletIndex: true,
    } as any,
    orderBy: { userId: 'asc' },
  })) as unknown as WalletRow[];

  const items: CustodialEoaWatchWallet[] = [];
  for (const w of wallets) {
    if (w.userId == null) continue;
    const custodial = (w.address ?? '').trim();
    const funderRaw = (w.polymarketFunderAddress ?? '').trim();
    if (!custodial || !funderRaw) continue;
    try {
      items.push({
        userId: w.userId,
        custodialAddress: getAddress(custodial as `0x${string}`),
        funderAddress: getAddress(funderRaw as `0x${string}`),
        walletIndex: w.walletIndex ?? null,
      });
    } catch {
      console.warn('[custodial-eoa-watch-list] skipped wallet with invalid address', {
        userId: w.userId,
        custodial,
        funderRaw,
      });
    }
  }
  return items;
}

export type HandleGoEoaDepositCallbackResult =
  | { ok: true; status: 'inserted' | 'duplicate' | 'skipped'; skipReason?: string }
  | { ok: false; httpStatus: number; code: number; message: string };

/**
 * Go chain_monitor 回调：校验 custodial 绑定后写 CHAIN_DEPOSIT 流水，并立即触发 EOA→funder→wrap。
 */
export async function handleGoEoaDepositCallback(input: {
  userId: number;
  custodialAddress: string;
  funderAddress: string;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  fromAddress: string;
  amountRaw: bigint;
  tokenAddress: string;
}): Promise<HandleGoEoaDepositCallbackResult> {
  const variant = resolveUsdcVariant(input.tokenAddress);
  if (!variant) {
    return {
      ok: false,
      httpStatus: 400,
      code: Code.VALIDATION_FAILED,
      message: 'Unsupported tokenAddress (expected USDC.e, native USDC, USDT, or USDT0)',
    };
  }

  type WalletRow = {
    id: number;
    address: string;
    polymarketFunderAddress: string | null;
  };

  const wallet = (await prisma.wallet.findFirst({
    where: {
      userId: input.userId,
      type: 'CUSTODIAL',
      polymarketFunderAddress: { not: null },
    } as any,
    select: { id: true, address: true, polymarketFunderAddress: true } as any,
  })) as WalletRow | null;

  if (!wallet?.polymarketFunderAddress || !wallet.address) {
    return {
      ok: false,
      httpStatus: 404,
      code: Code.NOT_FOUND,
      message: 'Custodial wallet or Polymarket funder not configured for user',
    };
  }

  let expectedCustodial: string;
  let expectedFunder: string;
  try {
    expectedCustodial = getAddress(wallet.address.trim() as `0x${string}`);
    expectedFunder = getAddress(wallet.polymarketFunderAddress.trim() as `0x${string}`);
  } catch {
    return {
      ok: false,
      httpStatus: 500,
      code: Code.INTERNAL_ERROR,
      message: 'Invalid custodial or funder address in database',
    };
  }

  let reqCustodial: string;
  let reqFunder: string;
  try {
    reqCustodial = getAddress(input.custodialAddress.trim() as `0x${string}`);
    reqFunder = getAddress(input.funderAddress.trim() as `0x${string}`);
  } catch {
    return {
      ok: false,
      httpStatus: 400,
      code: Code.VALIDATION_FAILED,
      message: 'Invalid custodialAddress or funderAddress in request',
    };
  }

  if (reqCustodial.toLowerCase() !== expectedCustodial.toLowerCase()) {
    return {
      ok: false,
      httpStatus: 403,
      code: Code.FORBIDDEN,
      message: 'custodialAddress does not match user custodial wallet',
    };
  }
  if (reqFunder.toLowerCase() !== expectedFunder.toLowerCase()) {
    return {
      ok: false,
      httpStatus: 403,
      code: Code.FORBIDDEN,
      message: 'funderAddress does not match user Polymarket deposit wallet',
    };
  }

  if (input.amountRaw <= 0n) {
    return { ok: true, status: 'skipped', skipReason: 'zero_amount' };
  }

  const ingest = await ingestCustodyTransferLog({
    userId: input.userId,
    walletId: wallet.id,
    walletAddress: expectedCustodial,
    log: {
      transactionHash: input.txHash,
      logIndex: input.logIndex,
      blockNumber: input.blockNumber,
      args: {
        from: input.fromAddress,
        to: expectedCustodial,
        value: input.amountRaw,
      },
    },
  });

  triggerCustodialEoaDepositPipeline(input.userId, 'go_chain_monitor', {
    triggerTxHash: input.txHash,
    triggerLogIndex: input.logIndex,
  });

  console.info('[go-eoa-deposit-callback] ok', {
    userId: input.userId,
    txHash: input.txHash,
    logIndex: input.logIndex,
    ingestStatus: ingest,
    usdcVariant: variant,
  });

  return { ok: true, status: ingest };
}
