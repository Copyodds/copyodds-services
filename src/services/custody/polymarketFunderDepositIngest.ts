import { getAddress } from 'viem';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import {
  isInternalPolymarketCollateralUsdcSender,
  isPolymarketCtfRedeemSender,
} from '../polymarket/web3';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from './userWalletLedger';
import { Code } from '../../utils/response';
import { clearCopyFundingWarning } from '../../copyTrading/services/copyFundingMonitor';
import { invalidateCopyFundingPrecheckCache } from '../../copyTrading/services/copyOrderFundingPrecheck';
import { resolveUsdcVariant } from './usdcTokenVariant';

export { resolveUsdcVariant } from './usdcTokenVariant';

export type PolymarketFunderDepositSource = 'go_chain_monitor' | 'node_funder_scan';

export type PolymarketFunderWatchWallet = {
  userId: number;
  funderAddress: string;
  custodialAddress: string;
  walletIndex: number | null;
};

export type PolymarketFunderDepositIngestInput = {
  userId: number;
  custodialAddress: string;
  funderAddress: string;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  fromAddress: string;
  amountRaw: bigint;
  tokenAddress: string;
  source: PolymarketFunderDepositSource;
};

export type PolymarketFunderDepositIngestResult =
  | { status: 'inserted'; ledgerId: string }
  | { status: 'duplicate'; ledgerId: string }
  | {
      status: 'skipped';
      reason:
        | 'zero_amount'
        | 'from_custodial'
        | 'internal_polymarket_sender'
        | 'invalid_funder'
        | 'unsupported_token';
    };

function buildFunderDepositIdempotencyKey(txHash: string, logIndex: number, isNativeUsdc: boolean): string {
  return `chain-pm-funder-${isNativeUsdc ? 'native-' : ''}${txHash}-${logIndex}`;
}

/**
 * 将 funder 地址上的 USDC.e / 原生 USDC Transfer 写入 UserWalletLedger（幂等）。
 * 新建流水时 appendUserWalletLedger 会自动 debounce 调度 wrap。
 */
export async function ingestPolymarketFunderChainDeposit(
  input: PolymarketFunderDepositIngestInput,
): Promise<PolymarketFunderDepositIngestResult> {
  if (input.amountRaw <= 0n) {
    return { status: 'skipped', reason: 'zero_amount' };
  }

  const custodialLower = input.custodialAddress.trim().toLowerCase();
  const fromLower = input.fromAddress.trim().toLowerCase();
  if (fromLower && fromLower === custodialLower) {
    return { status: 'skipped', reason: 'from_custodial' };
  }
  if (isInternalPolymarketCollateralUsdcSender(input.fromAddress)) {
    return { status: 'skipped', reason: 'internal_polymarket_sender' };
  }

  let funderAddr: `0x${string}`;
  try {
    funderAddr = getAddress(input.funderAddress.trim() as `0x${string}`);
  } catch {
    return { status: 'skipped', reason: 'invalid_funder' };
  }

  const variant = resolveUsdcVariant(input.tokenAddress);
  if (!variant || variant === 'usdt' || variant === 'usdt0') {
    // USDT / USDT0 仅支持 EOA→Bridge；funder/deposit 不能 Onramp wrap
    return { status: 'skipped', reason: 'unsupported_token' };
  }
  const isNativeUsdc = variant === 'native';
  const idempotencyKey = buildFunderDepositIdempotencyKey(input.txHash, input.logIndex, isNativeUsdc);
  const amountHuman = new Prisma.Decimal(input.amountRaw.toString()).div(1_000_000);

  const isRedeem = isPolymarketCtfRedeemSender(input.fromAddress);
  const { created, id } = await appendUserWalletLedger({
    userId: input.userId,
    rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
    direction: WALLET_LEDGER_DIRECTION.CREDIT,
    amount: amountHuman,
    symbol: 'USDC',
    category: isRedeem
      ? WALLET_LEDGER_CATEGORY.POLYMARKET_REDEEM
      : WALLET_LEDGER_CATEGORY.POLYMARKET_FUNDER_CHAIN_DEPOSIT,
    refType: 'ONCHAIN_TRANSFER',
    refId: `${input.txHash}:${input.logIndex}`,
    idempotencyKey,
    metadata: {
      txHash: input.txHash,
      logIndex: input.logIndex,
      fromAddress: input.fromAddress,
      toAddress: funderAddr,
      amountRaw: input.amountRaw.toString(),
      blockNumber: input.blockNumber.toString(),
      polymarketFunder: funderAddr,
      tokenAddress: getAddress(input.tokenAddress.trim() as `0x${string}`),
      usdcVariant: variant,
      source: input.source,
    },
  });

  invalidateCopyFundingPrecheckCache(input.userId);
  if (created) {
    await clearCopyFundingWarning({ userId: input.userId });
  }

  return created ? { status: 'inserted', ledgerId: id } : { status: 'duplicate', ledgerId: id };
}

/** Go chain monitor 拉取：需监测的 Polymarket funder（deposit）地址列表。 */
export async function listPolymarketFunderWatchWallets(): Promise<PolymarketFunderWatchWallet[]> {
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

  const items: PolymarketFunderWatchWallet[] = [];
  for (const w of wallets) {
    if (w.userId == null) continue;
    const custodial = (w.address ?? '').trim();
    const funderRaw = (w.polymarketFunderAddress ?? '').trim();
    if (!custodial || !funderRaw || funderRaw.toLowerCase() === custodial.toLowerCase()) {
      continue;
    }
    try {
      items.push({
        userId: w.userId,
        custodialAddress: getAddress(custodial as `0x${string}`),
        funderAddress: getAddress(funderRaw as `0x${string}`),
        walletIndex: w.walletIndex ?? null,
      });
    } catch {
      console.warn('[polymarket-funder-watch-list] skipped wallet with invalid address', {
        userId: w.userId,
        custodial,
        funderRaw,
      });
    }
  }
  return items;
}

export type HandleGoFunderDepositCallbackResult =
  | { ok: true; status: 'inserted' | 'duplicate' | 'skipped'; ledgerId?: string; skipReason?: string }
  | { ok: false; httpStatus: number; code: number; message: string };

/**
 * Go chain monitor 回调：校验 funder 绑定后入账并确保 wrap 被调度（含 duplicate 重试）。
 */
export async function handleGoFunderDepositCallback(input: {
  userId: number;
  funderAddress: string;
  custodialAddress: string;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  fromAddress: string;
  amountRaw: bigint;
  tokenAddress: string;
}): Promise<HandleGoFunderDepositCallbackResult> {
  type WalletRow = { address: string; polymarketFunderAddress: string | null };
  const wallet = (await prisma.wallet.findFirst({
    where: {
      userId: input.userId,
      type: 'CUSTODIAL',
      polymarketFunderAddress: { not: null },
    } as any,
    select: { address: true, polymarketFunderAddress: true } as any,
  })) as WalletRow | null;
  if (!wallet?.polymarketFunderAddress || !wallet.address) {
    return {
      ok: false,
      httpStatus: 404,
      code: Code.NOT_FOUND,
      message: 'Custodial wallet or Polymarket funder not configured for user',
    };
  }

  let expectedFunder: string;
  let expectedCustodial: string;
  try {
    expectedFunder = getAddress(wallet.polymarketFunderAddress.trim() as `0x${string}`);
    expectedCustodial = getAddress(wallet.address.trim() as `0x${string}`);
  } catch {
    return {
      ok: false,
      httpStatus: 500,
      code: Code.INTERNAL_ERROR,
      message: 'Invalid funder or custodial address in database',
    };
  }

  let reqFunder: string;
  let reqCustodial: string;
  try {
    reqFunder = getAddress(input.funderAddress.trim() as `0x${string}`);
    reqCustodial = getAddress(input.custodialAddress.trim() as `0x${string}`);
  } catch {
    return {
      ok: false,
      httpStatus: 400,
      code: Code.VALIDATION_FAILED,
      message: 'Invalid funderAddress or custodialAddress in request',
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
  if (reqCustodial.toLowerCase() !== expectedCustodial.toLowerCase()) {
    return {
      ok: false,
      httpStatus: 403,
      code: Code.FORBIDDEN,
      message: 'custodialAddress does not match user custodial wallet',
    };
  }

  const ingest = await ingestPolymarketFunderChainDeposit({
    userId: input.userId,
    custodialAddress: expectedCustodial,
    funderAddress: expectedFunder,
    txHash: input.txHash,
    logIndex: input.logIndex,
    blockNumber: input.blockNumber,
    fromAddress: input.fromAddress,
    amountRaw: input.amountRaw,
    tokenAddress: input.tokenAddress,
    source: 'go_chain_monitor',
  });

  if (ingest.status === 'skipped') {
    console.info('[go-funder-deposit-callback] skipped', {
      userId: input.userId,
      txHash: input.txHash,
      logIndex: input.logIndex,
      reason: ingest.reason,
    });
    return { ok: true, status: 'skipped', skipReason: ingest.reason };
  }

  if (ingest.status === 'duplicate') {
    console.info('[go-funder-deposit-callback] duplicate', {
      userId: input.userId,
      txHash: input.txHash,
      logIndex: input.logIndex,
      ledgerId: ingest.ledgerId,
    });
    return {
      ok: true,
      status: 'duplicate',
      ledgerId: ingest.ledgerId,
    };
  }

  console.info('[go-funder-deposit-callback] ok', {
    userId: input.userId,
    txHash: input.txHash,
    logIndex: input.logIndex,
    ledgerStatus: ingest.status,
    ledgerId: ingest.ledgerId,
  });

  return {
    ok: true,
    status: ingest.status,
    ledgerId: ingest.ledgerId,
  };
}
