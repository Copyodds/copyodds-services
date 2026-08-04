import { AssetType } from '@polymarket/clob-client-v2';
import { ethers } from 'ethers';
import { encodeFunctionData, formatUnits, getAddress, parseUnits, type Address } from 'viem';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { createConflictError } from '../../utils/appError';
import { getCustodialWalletForUser } from '../custody/custody';
import { upsertUserDepositBalanceCache, persistDepositBalanceCache } from '../custody/userBalanceCache';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from '../custody/userWalletLedger';
import { invalidateOnChainUsdcBalanceCacheForCustodialUser } from '../custody/custodyOnChainBalance';
import { syncCustodialPolymarketDepositFunderIfEmpty } from './polymarketAuth';
import { publicClient, USDC_E_ADDRESS, getNativeUsdcBalance, getPusdBalance, getUsdcBalance } from './web3';
import {
  assertRelayDerivedDepositMatches,
  buildUnwrapPusdPrefixCallsIfUsdceShort,
  ensurePolymarketDepositWalletRegisteredWithRelayer,
  executeDepositWalletBatchWithRetry,
  isPolymarketRelayerBuilderConfigured,
  runWithDepositRelayerFailover,
  waitRelayerTxSuccess,
} from './polymarketRelayerDeposit';
import { CONFIG } from '../../config/env';
import { tryAutoWrapPolymarketDepositUsdce } from './polymarketDepositAutoWrap';
import { trySyncPolymarketFunderDepositsForUser } from './polymarketFunderLedgerSync';

export type PolymarketDepositBalanceOptions = {
  /** 只读状态查询：跳过账本同步与 auto-wrap，并启用短 TTL 缓存 */
  readOnly?: boolean;
};

export type PolymarketDepositUsdcBalance = {
  depositAddress: string;
  raw: string;
  formatted: string;
  usdcE: { raw: string; formatted: string };
  nativeUsdc?: { raw: string; formatted: string };
  pUsd: { raw: string; formatted: string };
  autoWrap?: {
    attempted: boolean;
    skippedReason?: string;
    transactionHash?: string;
  };
};

type CachedDepositBalanceEntry = {
  expiresAt: number;
  value: PolymarketDepositUsdcBalance | null;
};

const readOnlyDepositBalanceCache = new Map<number, CachedDepositBalanceEntry>();
const readOnlyDepositBalanceInflight = new Map<
  number,
  Promise<PolymarketDepositUsdcBalance | null>
>();

export function invalidatePolymarketDepositUsdcBalanceCache(userId: number): void {
  readOnlyDepositBalanceCache.delete(userId);
  readOnlyDepositBalanceInflight.delete(userId);
}

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const USDC_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** @deprecated use isPolymarketRelayerBuilderConfigured */
export function isPolymarketDepositWithdrawConfigured(): boolean {
  return isPolymarketRelayerBuilderConfigured();
}

async function fetchPolymarketDepositUsdcBalance(
  userId: number,
  options?: PolymarketDepositBalanceOptions
): Promise<PolymarketDepositUsdcBalance | null> {
  const readOnly = options?.readOnly === true;
  const bundle = await getCustodialWalletForUser(userId).catch(() => null);
  if (!bundle?.walletId) return null;
  let deposit = (bundle.polymarketFunderAddress ?? '').trim();
  if (!deposit) {
    await syncCustodialPolymarketDepositFunderIfEmpty({
      userId,
      walletId: bundle.walletId,
      ownerAddress: bundle.address,
    });
    const w = await prisma.wallet.findUnique({
      where: { id: bundle.walletId },
      select: { polymarketFunderAddress: true },
    });
    deposit = (w?.polymarketFunderAddress ?? '').trim();
  }
  if (!deposit || deposit.toLowerCase() === bundle.address.toLowerCase()) {
    return null;
  }
  const depAddr = ethers.utils.getAddress(deposit) as `0x${string}`;
  let autoWrap: PolymarketDepositUsdcBalance['autoWrap'];
  if (!readOnly) {
    try {
      await trySyncPolymarketFunderDepositsForUser(userId);
    } catch (e) {
      console.warn('[polymarket-deposit-balance] funder ledger sync before wrap failed', {
        userId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    autoWrap = await tryAutoWrapPolymarketDepositUsdce(userId);
  }
  const [usdcE, nativeUsdc, pUsd] = await Promise.all([
    getUsdcBalance(depAddr),
    getNativeUsdcBalance(depAddr),
    getPusdBalance(depAddr),
  ]);
  const totalRawWei = usdcE.raw + pUsd.raw;
  const depositUsdcCached = new Prisma.Decimal(usdcE.formatted).plus(nativeUsdc.formatted);
  try {
    await upsertUserDepositBalanceCache(userId, {
      depositUsdc: depositUsdcCached,
      depositPusd: pUsd.formatted,
    });
  } catch (err) {
    console.error('[user-balance-cache] failed to persist deposit balance', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const result = {
    depositAddress: depAddr,
    raw: totalRawWei.toString(),
    formatted: formatUnits(totalRawWei, 6),
    usdcE: { raw: usdcE.raw.toString(), formatted: usdcE.formatted },
    nativeUsdc: { raw: nativeUsdc.raw.toString(), formatted: nativeUsdc.formatted },
    pUsd: { raw: pUsd.raw.toString(), formatted: pUsd.formatted },
    autoWrap,
  };
  return result;
}

export async function getPolymarketDepositUsdcBalance(
  userId: number,
  options?: PolymarketDepositBalanceOptions
): Promise<PolymarketDepositUsdcBalance | null> {
  const readOnly = options?.readOnly === true;
  const cacheTtlMs = readOnly ? CONFIG.custodyOnChainBalanceCacheTtlMs : 0;
  if (readOnly && cacheTtlMs > 0) {
    const cached = readOnlyDepositBalanceCache.get(userId);
    if (cached && cached.expiresAt > Date.now() && cached.value) {
      const v = cached.value;
      try {
        await persistDepositBalanceCache(userId, {
          usdcEFormatted: v.usdcE.formatted,
          nativeUsdcFormatted: v.nativeUsdc?.formatted,
          pUsdFormatted: v.pUsd.formatted,
        });
      } catch (err) {
        console.error('[user-balance-cache] failed to persist cached deposit balance', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return v;
    }
    const inflight = readOnlyDepositBalanceInflight.get(userId);
    if (inflight) {
      return inflight;
    }
  }

  const task = fetchPolymarketDepositUsdcBalance(userId, options);
  if (readOnly && cacheTtlMs > 0) {
    readOnlyDepositBalanceInflight.set(userId, task);
  }

  try {
    const value = await task;
    if (readOnly && cacheTtlMs > 0) {
      readOnlyDepositBalanceCache.set(userId, {
        expiresAt: Date.now() + cacheTtlMs,
        value,
      });
    }
    return value;
  } finally {
    if (readOnly && cacheTtlMs > 0) {
      readOnlyDepositBalanceInflight.delete(userId);
    }
  }
}

/**
 * 通过 Polymarket relayer 执行 deposit wallet 内 USDC.e → 托管地址（owner）链上转账。
 * 需配置 POLYMARKET_BUILDER_*（与 Polymarket Builder / relayer 文档一致）。
 */
export async function withdrawPolymarketDepositToCustody(params: {
  userId: number;
  /** 人类可读 USDC（6 decimals）；省略则划回 deposit 上全部 USDC.e */
  amount?: string;
  idempotencyKey?: string;
}): Promise<{
  transactionHash: string;
  amount: string;
  deposit: string;
  to: string;
  replayed?: boolean;
}> {
  if (!isPolymarketRelayerBuilderConfigured()) {
    throw createConflictError(
      'Polymarket deposit 划回托管未配置：请设置 POLYMARKET_BUILDER_API_KEY、POLYMARKET_BUILDER_SECRET、POLYMARKET_BUILDER_PASSPHRASE（可选 POLYMARKET_RELAYER_URL，默认 https://relayer-v2.polymarket.com）。',
      {
        reasonCode: 'POLYMARKET_RELAYER_NOT_CONFIGURED',
        doc: 'https://docs.polymarket.com/trading/deposit-wallets',
      }
    );
  }

  const idem = (params.idempotencyKey ?? '').trim();
  if (idem) {
    const existing = await prisma.userWalletLedger.findUnique({
      where: { idempotencyKey: idem },
      select: { metadata: true, userId: true },
    });
    if (existing && existing.userId === params.userId && existing.metadata && typeof existing.metadata === 'object') {
      const meta = existing.metadata as { txHash?: string; replay?: boolean };
      if (typeof meta.txHash === 'string' && meta.txHash.startsWith('0x')) {
        return {
          transactionHash: meta.txHash,
          amount: typeof (existing.metadata as any).amount === 'string' ? (existing.metadata as any).amount : '',
          deposit: String((existing.metadata as any).deposit ?? ''),
          to: String((existing.metadata as any).to ?? ''),
          replayed: true,
        };
      }
    }
  }

  const bundle = await getCustodialWalletForUser(params.userId);
  const wid = bundle.walletId;
  if (wid == null) {
    throw createConflictError('Custodial wallet id missing');
  }

  let depositRaw = (bundle.polymarketFunderAddress ?? '').trim();
  if (!depositRaw) {
    await syncCustodialPolymarketDepositFunderIfEmpty({
      userId: params.userId,
      walletId: wid,
      ownerAddress: bundle.address,
    });
    const w = await prisma.wallet.findUnique({
      where: { id: wid },
      select: { polymarketFunderAddress: true },
    });
    depositRaw = (w?.polymarketFunderAddress ?? '').trim();
  }
  if (!depositRaw) {
    throw createConflictError('未配置 Polymarket deposit 地址，请先完成托管开通与 Polymarket 授权', {
      hint: 'POST /api/custody/open 或 /api/custody/authorize-polymarket',
    });
  }

  const custodial = ethers.utils.getAddress(bundle.address);
  const deposit = ethers.utils.getAddress(depositRaw);
  if (deposit.toLowerCase() === custodial.toLowerCase()) {
    throw createConflictError('当前未使用独立 Polymarket deposit 钱包，无需划回');
  }

  const depositAddr = deposit as `0x${string}`;
  const usdceBal = await publicClient.readContract({
    address: USDC_E_ADDRESS,
    abi: USDC_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [depositAddr],
  });
  const pusdBal = (await getPusdBalance(depositAddr)).raw;
  const maxLiquidUsdce = usdceBal + pusdBal;

  let amountWei: bigint;
  const amountTrim = params.amount?.trim();
  if (amountTrim) {
    try {
      amountWei = parseUnits(amountTrim, 6);
    } catch {
      throw createConflictError('Invalid amount');
    }
    if (amountWei <= 0n) {
      throw createConflictError('amount must be > 0');
    }
    if (amountWei > maxLiquidUsdce) {
      throw createConflictError('Polymarket deposit 上可划转 USDC 不足', {
        requested: amountWei.toString(),
        availableUsdcE: usdceBal.toString(),
        availablePusd: pusdBal.toString(),
        maxLiquidUsdce: maxLiquidUsdce.toString(),
      });
    }
  } else {
    if (maxLiquidUsdce <= 0n) {
      throw createConflictError('Polymarket deposit 上 USDC 余额为 0', { deposit });
    }
    amountWei = maxLiquidUsdce;
  }

  const unwrapPrefix = await buildUnwrapPusdPrefixCallsIfUsdceShort(getAddress(depositAddr) as Address, amountWei);

  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [custodial as `0x${string}`, amountWei],
  });

  const calls = [
    ...unwrapPrefix,
    {
      target: USDC_E_ADDRESS,
      value: '0',
      data,
    },
  ];

  const { transactionHash } = await runWithDepositRelayerFailover(
    params.userId,
    custodial,
    async ({ relayClient, slotId }) => {
    await assertRelayDerivedDepositMatches(relayClient, deposit, custodial);
    await ensurePolymarketDepositWalletRegisteredWithRelayer(relayClient, deposit, { slotId });

    const txResp = await executeDepositWalletBatchWithRetry(
      relayClient,
      deposit,
      calls,
      'POLYMARKET_RELAYER_SUBMIT_FAILED',
      { slotId },
    );

    const result = await waitRelayerTxSuccess(relayClient, txResp.transactionID, {
      reasonCode: 'POLYMARKET_RELAYER_BATCH_TIMEOUT',
      message: 'Polymarket relayer 划转确认超时',
    });

    const hash = result.transactionHash || txResp.transactionHash || '';
    if (!hash.startsWith('0x')) {
      throw createConflictError('Relayer 未返回有效 transactionHash', { result });
    }
    return { transactionHash: hash };
  },
    { slotPreference: 'backup_first', op: 'withdraw' }
  );

  const amountStr = formatUnits(amountWei, 6);

  await appendUserWalletLedger({
    userId: params.userId,
    rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
    direction: WALLET_LEDGER_DIRECTION.CREDIT,
    amount: new Prisma.Decimal(amountWei.toString()).div(1_000_000),
    symbol: 'USDC',
    category: WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT_RETURN,
    refType: 'RELAYER_TX',
    refId: transactionHash,
    idempotencyKey: idem || undefined,
    metadata: {
      txHash: transactionHash,
      deposit,
      to: custodial,
      amount: amountStr,
      amountRaw: amountWei.toString(),
    },
  });

  invalidateOnChainUsdcBalanceCacheForCustodialUser(params.userId);
  invalidatePolymarketDepositUsdcBalanceCache(params.userId);
  const { invalidatePolymarketDepositWithdrawPreviewCache } = await import('./polymarketDepositWithdrawV2.js');
  invalidatePolymarketDepositWithdrawPreviewCache(params.userId);

  try {
    const { invalidateUserClobClientCache, getClobClientForUser } = await import('./polymarketClob.js');
    invalidateUserClobClientCache(params.userId, custodial);
    const clob = await getClobClientForUser(params.userId, custodial);
    await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } catch (e) {
    console.warn('[polymarket-deposit-withdraw] CLOB balance refresh skipped', e);
  }

  return {
    transactionHash,
    amount: amountStr,
    deposit,
    to: custodial,
  };
}
