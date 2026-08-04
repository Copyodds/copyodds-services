/**
 * Polymarket deposit wallet USDC.e withdrawal to a user-specified address (v2):
 * CLOB + Data API + open orders guards, relayer batch, DB request row, ledger.
 */
import { AssetType } from '@polymarket/clob-client-v2';
import { RelayerTransactionState } from '@polymarket/builder-relayer-client';
import { ethers } from 'ethers';
import { encodeFunctionData, formatUnits, getAddress, isAddress, parseUnits } from 'viem';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { createConflictError } from '../../utils/appError';
import { getCustodialWalletForUser } from '../custody/custody';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from '../custody/userWalletLedger';
import { invalidateOnChainUsdcBalanceCacheForCustodialUser } from '../custody/custodyOnChainBalance';
import {
  getPolymarketDepositUsdcBalance,
  invalidatePolymarketDepositUsdcBalanceCache,
} from './polymarketDepositWithdraw';
import { CONFIG } from '../../config/env';
import { syncCustodialPolymarketDepositFunderIfEmpty } from './polymarketAuth';
import { fetchDataApiPositions, type DataApiPosition } from './polymarketData';
import { getOpenOrdersForUser, getClobClientForUser, invalidateUserClobClientCache, parseClobCollateralBalanceToWei6 } from './polymarketClob';
import { publicClient, PUSD_TOKEN, USDC_E_ADDRESS } from './web3';
import {
  assertRelayDerivedDepositMatches,
  buildUnwrapPusdPrefixCallsIfUsdceShort,
  createDepositRelayClientForCustodialUser,
  ensurePolymarketDepositWalletRegisteredWithRelayer,
  executeDepositWalletBatchWithRetry,
  isPolymarketRelayerBuilderConfigured,
  runWithDepositRelayerFailover,
  waitRelayerTxSuccess,
} from './polymarketRelayerDeposit';
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

const POSITION_SIZE_EPS = 1e-9;
const STALE_PENDING_MS = 15 * 60 * 1000;
const RELAYER_OK = new Set<string>([
  RelayerTransactionState.STATE_EXECUTED,
  RelayerTransactionState.STATE_MINED,
  RelayerTransactionState.STATE_CONFIRMED,
]);

function clobAllowanceBalanceToRawString(ba: unknown): string {
  if (!ba || typeof ba !== 'object') return '';
  const b = (ba as { balance?: unknown }).balance;
  if (b == null) return '';
  if (typeof b === 'string') return b;
  if (typeof b === 'number') return Number.isFinite(b) ? String(b) : '';
  return String(b);
}

/**
 * 可提上限：min(链上可转 USDC, CLOB 可用抵押)。
 * CLOB 为 0 且无挂单时，用链上余额减去 Data API 持仓市值估算的占用额（允许有小仓位时提走闲置 USDC）。
 */
function computeMaxWithdrawableWei6(params: {
  chainWei: bigint;
  clobWei: bigint;
  hasOpenOrders: boolean;
  positionCollateralWei: bigint;
}): { maxWei: bigint; clobEffectiveWei: bigint; clobFallbackToChain: boolean } {
  const { chainWei, clobWei, hasOpenOrders, positionCollateralWei } = params;
  let clobEffectiveWei = clobWei;
  let clobFallbackToChain = false;
  if (clobWei === 0n && chainWei > 0n && !hasOpenOrders) {
    const freeChainWei =
      chainWei > positionCollateralWei ? chainWei - positionCollateralWei : 0n;
    if (freeChainWei > 0n) {
      clobEffectiveWei = freeChainWei;
      clobFallbackToChain = true;
    }
  }
  const maxWei = chainWei < clobEffectiveWei ? chainWei : clobEffectiveWei;
  return { maxWei, clobEffectiveWei, clobFallbackToChain };
}

async function readDepositUsdcBalanceWei(deposit: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_E_ADDRESS,
    abi: USDC_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [deposit],
  });
}

async function readDepositPusdBalanceWei(deposit: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: PUSD_TOKEN,
    abi: USDC_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [deposit],
  });
}

/** 提现侧「链上」可变成 USDC.e 转出的上限：已有 USDC.e + 可 unwrap 的 pUSD */
async function readDepositWithdrawableUsdceEquivalentWei(deposit: `0x${string}`): Promise<bigint> {
  const [u, p] = await Promise.all([readDepositUsdcBalanceWei(deposit), readDepositPusdBalanceWei(deposit)]);
  return u + p;
}

async function getClobCollateralBalanceWei6(
  userId: number,
  custodial: string,
  options?: { syncBeforeRead?: boolean },
): Promise<bigint> {
  const clob = await getClobClientForUser(userId, custodial);
  if (options?.syncBeforeRead !== false) {
    await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  }
  const ba = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return parseClobCollateralBalanceToWei6(clobAllowanceBalanceToRawString(ba));
}

function hasNonTrivialPositionInList(positions: DataApiPosition[]): boolean {
  return positions.some((p) => Math.abs(Number(p.size ?? 0)) > POSITION_SIZE_EPS);
}

/** 用 Data API currentValue（向上取整）估算持仓占用的 USDC，避免把闲置链上余额算进可提上限 */
function estimatePositionsCollateralWei6(positions: DataApiPosition[]): bigint {
  let wei = 0n;
  for (const p of positions) {
    const size = Math.abs(Number(p.size ?? 0));
    if (size <= POSITION_SIZE_EPS) continue;
    let usd = 0;
    if (typeof p.currentValue === 'number' && Number.isFinite(p.currentValue)) {
      usd = Math.max(0, p.currentValue);
    } else {
      const px = Number(p.curPrice ?? p.avgPrice ?? 0);
      usd = size * (Number.isFinite(px) ? px : 0);
    }
    if (usd > 0) {
      wei += BigInt(Math.ceil(usd * 1_000_000));
    }
  }
  return wei;
}

async function hasOpenOrders(userId: number, custodial: string): Promise<boolean> {
  const orders = await getOpenOrdersForUser(userId, undefined, custodial).catch(() => []);
  return Array.isArray(orders) && orders.length > 0;
}

type CachedWithdrawPreviewEntry = {
  expiresAt: number;
  value: PolymarketWithdrawPreview | null;
};

const withdrawPreviewCache = new Map<number, CachedWithdrawPreviewEntry>();
const withdrawPreviewInflight = new Map<number, Promise<PolymarketWithdrawPreview | null>>();

export function invalidatePolymarketDepositWithdrawPreviewCache(userId: number): void {
  withdrawPreviewCache.delete(userId);
  withdrawPreviewInflight.delete(userId);
}

export type PolymarketWithdrawPreview = {
  depositAddress: string;
  custodialAddress: string;
  /** 参与 max=min(链上可转 USDC, CLOB) 的「链上」一侧：服务端可将多种形态统一为可转 USDC */
  chainBalanceRaw: string;
  chainBalanceFormatted: string;
  /** deposit 上「原始」桥前 USDC（调试/对账） */
  usdcEChainBalanceRaw: string;
  usdcEChainBalanceFormatted: string;
  /** deposit 上桥后抵押余额（调试/对账；对用户界面应合并展示为 USDC） */
  pUsdChainBalanceRaw: string;
  pUsdChainBalanceFormatted: string;
  /** CLOB getBalanceAllowance(COLLATERAL) 原始口径 */
  clobBalanceRaw: string;
  clobBalanceFormatted: string;
  /** 参与 max=min(链上,·) 计算时使用的 CLOB 侧 wei（可能与上报一致，或在回退时等于链上） */
  clobEffectiveBalanceRaw: string;
  clobEffectiveBalanceFormatted: string;
  maxWithdrawableRaw: string;
  maxWithdrawableFormatted: string;
  blockers: string[];
  checks: {
    hasOpenOrders: boolean;
    hasPositionsCustodial: boolean;
    hasPositionsDeposit: boolean;
    relayerConfigured: boolean;
    /** CLOB 抵押读数为 0 但链上有余额时，用链上闲置额作为 min 的一侧（无挂单；有持仓时扣减估算占用） */
    clobCollateralFallbackToChain?: boolean;
    /** Data API 持仓市值估算（6 位小数 raw wei 字符串） */
    positionCollateralRaw?: string;
  };
};

async function resolveDepositContext(userId: number): Promise<{
  custodial: string;
  deposit: `0x${string}`;
  walletId: number;
} | null> {
  const bundle = await getCustodialWalletForUser(userId).catch(() => null);
  if (!bundle?.walletId) return null;
  const wid = bundle.walletId;
  let depositRaw = (bundle.polymarketFunderAddress ?? '').trim();
  if (!depositRaw) {
    await syncCustodialPolymarketDepositFunderIfEmpty({
      userId,
      walletId: wid,
      ownerAddress: bundle.address,
    });
    const w = await prisma.wallet.findUnique({
      where: { id: wid },
      select: { polymarketFunderAddress: true },
    });
    depositRaw = (w?.polymarketFunderAddress ?? '').trim();
  }
  if (!depositRaw) return null;
  const custodial = ethers.utils.getAddress(bundle.address);
  const deposit = getAddress(depositRaw) as `0x${string}`;
  if (deposit.toLowerCase() === custodial.toLowerCase()) return null;
  return { custodial, deposit, walletId: wid };
}

/**
 * 尝试将卡住的 RELAYER_SUBMITTED / 过期 PENDING 推进到终态。
 */
export async function recoverPolymarketDepositWithdrawalsForUser(userId: number): Promise<void> {
  const stalePending = await prisma.polymarketDepositWithdrawRequest.findMany({
    where: {
      userId,
      status: 'PENDING',
      relayerTransactionId: null,
      createdAt: { lt: new Date(Date.now() - STALE_PENDING_MS) },
    },
  });
  for (const row of stalePending) {
    await prisma.polymarketDepositWithdrawRequest.update({
      where: { id: row.id },
      data: { status: 'FAILED', error: 'PENDING request expired without relayer submit (abandoned)' },
    });
  }

  if (!isPolymarketRelayerBuilderConfigured()) return;

  const inFlight = await prisma.polymarketDepositWithdrawRequest.findMany({
    where: { userId, status: 'RELAYER_SUBMITTED' },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });
  if (!inFlight.length) return;

  const ctx = await resolveDepositContext(userId);
  if (!ctx) return;

  const { relayClient } = await createDepositRelayClientForCustodialUser(userId, ctx.custodial, {
    slotPreference: 'backup_first',
    op: 'withdraw_v2_recover',
  });

  for (const row of inFlight) {
    const tid = (row.relayerTransactionId ?? '').trim();
    if (!tid) {
      await prisma.polymarketDepositWithdrawRequest.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: 'Missing relayerTransactionId' },
      });
      continue;
    }
    try {
      const txs = await relayClient.getTransaction(tid);
      const txn = txs[0];
      if (!txn) continue;
      if (RELAYER_OK.has(txn.state)) {
        const hash = (txn.transactionHash || '').trim();
        await prisma.polymarketDepositWithdrawRequest.update({
          where: { id: row.id },
          data: {
            status: 'CONFIRMED',
            chainTxHash: hash.startsWith('0x') ? hash : row.chainTxHash,
          },
        });
      } else if (txn.state === RelayerTransactionState.STATE_FAILED || txn.state === RelayerTransactionState.STATE_INVALID) {
        await prisma.polymarketDepositWithdrawRequest.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: `Relayer ${txn.state}` },
        });
      }
    } catch (e) {
      console.warn('[polymarket-withdraw-v2] recover relayer poll failed', { userId, id: row.id, e });
    }
  }
}

async function buildPolymarketDepositWithdrawPreview(userId: number): Promise<PolymarketWithdrawPreview | null> {
  const relayerInFlight = await prisma.polymarketDepositWithdrawRequest.count({
    where: { userId, status: 'RELAYER_SUBMITTED' },
  });
  if (relayerInFlight > 0) {
    await recoverPolymarketDepositWithdrawalsForUser(userId);
  } else {
    const stalePending = await prisma.polymarketDepositWithdrawRequest.count({
      where: {
        userId,
        status: 'PENDING',
        relayerTransactionId: null,
        createdAt: { lt: new Date(Date.now() - STALE_PENDING_MS) },
      },
    });
    if (stalePending > 0) {
      await recoverPolymarketDepositWithdrawalsForUser(userId);
    }
  }

  const ctx = await resolveDepositContext(userId);
  if (!ctx) return null;

  const blockers: string[] = [];
  const checks: PolymarketWithdrawPreview['checks'] = {
    hasOpenOrders: false,
    hasPositionsCustodial: false,
    hasPositionsDeposit: false,
    relayerConfigured: isPolymarketRelayerBuilderConfigured(),
  };

  if (!checks.relayerConfigured) {
    blockers.push('RELAYER_NOT_CONFIGURED');
  }

  const sameWallet = ctx.deposit.toLowerCase() === ctx.custodial.toLowerCase();
  const [depositBalance, clobWei, openOrders, depositPositions, custodialPositions] = await Promise.all([
    getPolymarketDepositUsdcBalance(userId, { readOnly: true }),
    getClobCollateralBalanceWei6(userId, ctx.custodial, { syncBeforeRead: false }).catch(() => 0n),
    hasOpenOrders(userId, ctx.custodial),
    fetchDataApiPositions(ctx.deposit, { limit: 500, sizeThreshold: 0 }).catch(() => []),
    sameWallet
      ? Promise.resolve([] as DataApiPosition[])
      : fetchDataApiPositions(ctx.custodial, { limit: 500, sizeThreshold: 0 }).catch(() => []),
  ]);

  const usdceOnly = depositBalance ? BigInt(depositBalance.usdcE.raw) : 0n;
  const pusdOnly = depositBalance ? BigInt(depositBalance.pUsd.raw) : 0n;
  const chainLiquidityWei = usdceOnly + pusdOnly;

  const posDeposit = hasNonTrivialPositionInList(depositPositions);
  const posCustodial = hasNonTrivialPositionInList(custodialPositions);
  const positionCollateralWei = estimatePositionsCollateralWei6([
    ...depositPositions,
    ...custodialPositions,
  ]);

  checks.hasOpenOrders = openOrders;
  checks.hasPositionsCustodial = posCustodial;
  checks.hasPositionsDeposit = posDeposit;
  checks.positionCollateralRaw = positionCollateralWei.toString();

  if (openOrders) blockers.push('OPEN_ORDERS');

  const inProgress = await prisma.polymarketDepositWithdrawRequest.findFirst({
    where: {
      userId,
      status: { in: ['PENDING', 'RELAYER_SUBMITTED'] },
    },
  });
  if (inProgress) {
    blockers.push('WITHDRAW_IN_PROGRESS');
  }

  const { maxWei, clobEffectiveWei, clobFallbackToChain } = computeMaxWithdrawableWei6({
    chainWei: chainLiquidityWei,
    clobWei,
    hasOpenOrders: openOrders,
    positionCollateralWei,
  });
  if (clobFallbackToChain) {
    checks.clobCollateralFallbackToChain = true;
  }

  return {
    depositAddress: ctx.deposit,
    custodialAddress: ctx.custodial,
    chainBalanceRaw: chainLiquidityWei.toString(),
    chainBalanceFormatted: formatUnits(chainLiquidityWei, 6),
    usdcEChainBalanceRaw: usdceOnly.toString(),
    usdcEChainBalanceFormatted: formatUnits(usdceOnly, 6),
    pUsdChainBalanceRaw: pusdOnly.toString(),
    pUsdChainBalanceFormatted: formatUnits(pusdOnly, 6),
    clobBalanceRaw: clobWei.toString(),
    clobBalanceFormatted: formatUnits(clobWei, 6),
    clobEffectiveBalanceRaw: clobEffectiveWei.toString(),
    clobEffectiveBalanceFormatted: formatUnits(clobEffectiveWei, 6),
    maxWithdrawableRaw: maxWei.toString(),
    maxWithdrawableFormatted: formatUnits(maxWei, 6),
    blockers,
    checks,
  };
}

export async function getPolymarketDepositWithdrawPreview(userId: number): Promise<PolymarketWithdrawPreview | null> {
  const cacheTtlMs = Math.max(0, CONFIG.custodyOnChainBalanceCacheTtlMs);
  if (cacheTtlMs > 0) {
    const cached = withdrawPreviewCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const inflight = withdrawPreviewInflight.get(userId);
    if (inflight) {
      return inflight;
    }
  }

  const task = buildPolymarketDepositWithdrawPreview(userId);
  if (cacheTtlMs > 0) {
    withdrawPreviewInflight.set(userId, task);
  }

  try {
    const value = await task;
    if (cacheTtlMs > 0) {
      withdrawPreviewCache.set(userId, {
        expiresAt: Date.now() + cacheTtlMs,
        value,
      });
    }
    return value;
  } finally {
    if (cacheTtlMs > 0) {
      withdrawPreviewInflight.delete(userId);
    }
  }
}

function assertValidWithdrawTo(params: { to: string; deposit: string }): `0x${string}` {
  const raw = params.to.trim();
  if (!isAddress(raw)) {
    throw createConflictError('Invalid withdrawal address', { reasonCode: 'INVALID_WITHDRAW_TO' });
  }
  const to = getAddress(raw) as `0x${string}`;
  if (to.toLowerCase() === params.deposit.toLowerCase()) {
    throw createConflictError('Withdrawal address cannot be the deposit wallet itself', {
      reasonCode: 'WITHDRAW_TO_EQUALS_DEPOSIT',
    });
  }
  if (to === '0x0000000000000000000000000000000000000000') {
    throw createConflictError('Invalid withdrawal address', { reasonCode: 'INVALID_WITHDRAW_TO' });
  }
  return to;
}

export type DepositWalletUsdcRelayerAmountSpec =
  | { kind: 'wei'; amountWei: bigint }
  | { kind: 'human'; amount: string }
  | { kind: 'max' };

type PolymarketDepositWithdrawRelayerReplay = {
  transactionHash: string;
  amountStr: string;
  deposit: string;
  to: `0x${string}`;
  requestId: string;
};

/** 同一 userId + idempotencyKey 的提现请求去重（避免 P2002 变成 500）。 */
async function resolvePolymarketDepositWithdrawIdempotency(params: {
  userId: number;
  idempotencyKey: string;
}): Promise<PolymarketDepositWithdrawRelayerReplay | null> {
  const existing = await prisma.polymarketDepositWithdrawRequest.findUnique({
    where: {
      userId_idempotencyKey: { userId: params.userId, idempotencyKey: params.idempotencyKey },
    },
  });
  if (!existing) return null;

  if (existing.status === 'CONFIRMED') {
    const hash = (existing.chainTxHash ?? '').trim();
    if (!hash.startsWith('0x')) {
      throw createConflictError('上一笔 Polymarket 提现已确认但缺少 chainTxHash', {
        reasonCode: 'POLYMARKET_WITHDRAW_REPLAY_INCOMPLETE',
        requestId: existing.id,
      });
    }
    return {
      transactionHash: hash,
      amountStr: formatUnits(BigInt(existing.amountRaw), 6),
      deposit: existing.depositAddress,
      to: getAddress(existing.toAddress) as `0x${string}`,
      requestId: existing.id,
    };
  }

  if (existing.status === 'PENDING' || existing.status === 'RELAYER_SUBMITTED') {
    throw createConflictError(
      existing.status === 'RELAYER_SUBMITTED'
        ? '上一笔 Polymarket 提现仍在 relayer 处理中，请稍后再试。'
        : '上一笔 Polymarket 提现尚未完成，请稍后再试。',
      {
        reasonCode: 'POLYMARKET_WITHDRAW_IN_PROGRESS',
        requestId: existing.id,
        relayerTransactionId: existing.relayerTransactionId,
      }
    );
  }

  throw createConflictError('上一笔 Polymarket 提现已失败，请使用新的 idempotencyKey 重试', {
    reasonCode: 'POLYMARKET_WITHDRAW_PREVIOUSLY_FAILED',
    requestId: existing.id,
    error: existing.error ?? null,
  });
}

async function acquirePolymarketDepositWithdrawRequestRow(params: {
  userId: number;
  idempotencyKey: string;
  deposit: string;
  toAddress: string;
  amountWei: bigint;
  amountDecimal: Prisma.Decimal;
}): Promise<
  | { mode: 'created'; row: { id: string } }
  | { mode: 'replay'; replay: PolymarketDepositWithdrawRelayerReplay }
> {
  const existingReplay = await resolvePolymarketDepositWithdrawIdempotency({
    userId: params.userId,
    idempotencyKey: params.idempotencyKey,
  });
  if (existingReplay) {
    return { mode: 'replay', replay: existingReplay };
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      const n = await tx.polymarketDepositWithdrawRequest.count({
        where: {
          userId: params.userId,
          status: { in: ['PENDING', 'RELAYER_SUBMITTED'] },
        },
      });
      if (n > 0) {
        const row = await tx.polymarketDepositWithdrawRequest.findFirst({
          where: { userId: params.userId, status: { in: ['PENDING', 'RELAYER_SUBMITTED'] } },
          orderBy: { createdAt: 'desc' },
        });
        throw createConflictError(
          row?.status === 'RELAYER_SUBMITTED'
            ? '上一笔 Polymarket 提现仍在 relayer 处理中，请稍后再试。'
            : '上一笔 Polymarket 提现尚未完成，请稍后再试。',
          {
            reasonCode: 'POLYMARKET_WITHDRAW_IN_PROGRESS',
            requestId: row?.id,
            relayerTransactionId: row?.relayerTransactionId,
          }
        );
      }
      return tx.polymarketDepositWithdrawRequest.create({
        data: {
          userId: params.userId,
          idempotencyKey: params.idempotencyKey,
          depositAddress: params.deposit,
          toAddress: params.toAddress,
          amountRaw: params.amountWei.toString(),
          amount: params.amountDecimal,
          status: 'PENDING',
        },
        select: { id: true },
      });
    });
    return { mode: 'created', row };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const raceReplay = await resolvePolymarketDepositWithdrawIdempotency({
        userId: params.userId,
        idempotencyKey: params.idempotencyKey,
      });
      if (raceReplay) {
        return { mode: 'replay', replay: raceReplay };
      }
    }
    throw e;
  }
}

/**
 * 将 Polymarket deposit 钱包内 USDC.e 经 Builder relayer 批次转至任意有效 `to`（非 deposit 自身）。
 * 不包含 UserWalletLedger 写入；提现与 Gas 商店付款等共用。
 */
export async function submitDepositWalletUsdcTransferViaRelayer(params: {
  userId: number;
  to: string;
  idempotencyKey: string;
  amount: DepositWalletUsdcRelayerAmountSpec;
  /** Opaque Go authorization scoped to this withdrawal intent and signer instance. */
  authorization?: string;
}): Promise<{
  transactionHash: string;
  amountStr: string;
  deposit: string;
  to: `0x${string}`;
  requestId: string;
}> {
  if (!isPolymarketRelayerBuilderConfigured()) {
    throw createConflictError(
      'Polymarket relayer 未配置：请设置 POLYMARKET_BUILDER_API_KEY、POLYMARKET_BUILDER_SECRET、POLYMARKET_BUILDER_PASSPHRASE。',
      { reasonCode: 'POLYMARKET_RELAYER_NOT_CONFIGURED' }
    );
  }

  await recoverPolymarketDepositWithdrawalsForUser(params.userId);

  const ctx = await resolveDepositContext(params.userId);
  if (!ctx) {
    throw createConflictError('未配置 Polymarket deposit 地址，请先完成托管开通与 Polymarket 授权', {
      hint: 'POST /api/custody/open 或 /api/custody/authorize-polymarket',
    });
  }

  const to = assertValidWithdrawTo({ to: params.to, deposit: ctx.deposit });

  const preview = await getPolymarketDepositWithdrawPreview(params.userId);
  const blockersNoQueue = (preview?.blockers ?? []).filter((b) => b !== 'WITHDRAW_IN_PROGRESS');
  if (!preview || blockersNoQueue.length > 0) {
    throw createConflictError('当前不满足提现条件', {
      reasonCode: 'POLYMARKET_WITHDRAW_PREVIEW_BLOCKED',
      blockers: preview?.blockers ?? ['UNKNOWN'],
      checks: preview?.checks,
    });
  }

  const maxWei = BigInt(preview.maxWithdrawableRaw);
  let amountWei: bigint;
  if (params.amount.kind === 'wei') {
    amountWei = params.amount.amountWei;
    if (amountWei <= 0n) {
      throw createConflictError('amount must be > 0');
    }
    if (amountWei > maxWei) {
      throw createConflictError('提现金额超过可提上限', {
        reasonCode: 'WITHDRAW_EXCEEDS_MAX',
        maxWithdrawableRaw: maxWei.toString(),
        maxWithdrawableFormatted: formatUnits(maxWei, 6),
      });
    }
  } else if (params.amount.kind === 'human') {
    const amountTrim = params.amount.amount.trim();
    try {
      amountWei = parseUnits(amountTrim, 6);
    } catch {
      throw createConflictError('Invalid amount');
    }
    if (amountWei <= 0n) {
      throw createConflictError('amount must be > 0');
    }
    if (amountWei > maxWei) {
      throw createConflictError('提现金额超过可提上限', {
        reasonCode: 'WITHDRAW_EXCEEDS_MAX',
        maxWithdrawableRaw: maxWei.toString(),
        maxWithdrawableFormatted: formatUnits(maxWei, 6),
      });
    }
  } else {
    if (maxWei <= 0n) {
      throw createConflictError('可提余额为 0', { reasonCode: 'ZERO_MAX_WITHDRAWABLE' });
    }
    amountWei = maxWei;
  }

  const amountDecimal = new Prisma.Decimal(amountWei.toString()).div(1_000_000);

  const acquired = await acquirePolymarketDepositWithdrawRequestRow({
    userId: params.userId,
    idempotencyKey: params.idempotencyKey,
    deposit: ctx.deposit,
    toAddress: to,
    amountWei,
    amountDecimal,
  });
  if (acquired.mode === 'replay') {
    return acquired.replay;
  }
  const requestRow = acquired.row;

  const custodial = ctx.custodial;
  const deposit = ctx.deposit;

  try {
    const relayerResult = await runWithDepositRelayerFailover(params.userId, custodial, async ({ relayClient, slotId }) => {
      await assertRelayDerivedDepositMatches(relayClient, deposit, custodial);
      await ensurePolymarketDepositWalletRegisteredWithRelayer(relayClient, deposit, { slotId });

      const unwrapPrefix = await buildUnwrapPusdPrefixCallsIfUsdceShort(getAddress(deposit), amountWei);
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [to, amountWei],
      });

      const calls = [
        ...unwrapPrefix,
        { target: USDC_E_ADDRESS, value: '0', data },
      ];

      const txResp = await executeDepositWalletBatchWithRetry(
        relayClient,
        deposit,
        calls,
        'POLYMARKET_RELAYER_SUBMIT_FAILED',
        { slotId },
      );

      await prisma.polymarketDepositWithdrawRequest.update({
        where: { id: requestRow.id },
        data: { status: 'RELAYER_SUBMITTED', relayerTransactionId: txResp.transactionID },
      });

      const result = await waitRelayerTxSuccess(relayClient, txResp.transactionID, {
        reasonCode: 'POLYMARKET_RELAYER_BATCH_TIMEOUT',
        message: 'Polymarket relayer 提现确认超时',
      });

      const transactionHash = (result.transactionHash || txResp.transactionHash || '').trim();
      if (!transactionHash.startsWith('0x')) {
        throw createConflictError('Relayer 未返回有效 transactionHash', { result });
      }

      const amountStr = formatUnits(amountWei, 6);

      await prisma.polymarketDepositWithdrawRequest.update({
        where: { id: requestRow.id },
        data: { status: 'CONFIRMED', chainTxHash: transactionHash },
      });

      return {
        transactionHash,
        amountStr,
        deposit,
        to,
        requestId: requestRow.id,
      };
    }, {
      ...(params.authorization
        ? {
            withdrawalAuthorization: {
              token: params.authorization,
              idempotencyKey: params.idempotencyKey,
            },
          }
        : {}),
      slotPreference: 'backup_first' as const,
      op: 'withdraw_v2',
    });

    return relayerResult;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.polymarketDepositWithdrawRequest.update({
      where: { id: requestRow.id },
      data: { status: 'FAILED', error: msg.slice(0, 2000) },
    });
    throw e;
  }
}

export type DepositWalletUsdcRelayerTransferLeg = {
  to: string;
  amountWei: bigint;
};

/**
 * 同一 relayer 批次内多笔 USDC.e `transfer`（Gas/档位购买：全额打国库）。划出总额须等于各腿之和。
 * 无 withdrawalAuthorization 时由 Go wallet 白名单校验收款地址（security.platform_usdce_transfer_recipients）。
 */
export async function submitDepositWalletUsdcRelayerTransfers(params: {
  userId: number;
  idempotencyKey: string;
  /** 必须与 transfers 各 amountWei 之和相等 */
  totalAmountWei: bigint;
  transfers: DepositWalletUsdcRelayerTransferLeg[];
}): Promise<{
  transactionHash: string;
  deposit: string;
  requestId: string;
  totalAmountStr: string;
  legs: Array<{ to: `0x${string}`; amountWei: bigint; amountStr: string }>;
}> {
  if (!isPolymarketRelayerBuilderConfigured()) {
    throw createConflictError(
      'Polymarket relayer 未配置：请设置 POLYMARKET_BUILDER_API_KEY、POLYMARKET_BUILDER_SECRET、POLYMARKET_BUILDER_PASSPHRASE。',
      { reasonCode: 'POLYMARKET_RELAYER_NOT_CONFIGURED' }
    );
  }

  const legsIn = params.transfers ?? [];
  if (legsIn.length === 0) {
    throw createConflictError('transfers must be non-empty', { reasonCode: 'INVALID_RELAYER_BATCH' });
  }
  if (params.totalAmountWei <= 0n) {
    throw createConflictError('totalAmountWei must be > 0', { reasonCode: 'INVALID_RELAYER_BATCH' });
  }

  let sumWei = 0n;
  for (const leg of legsIn) {
    if (leg.amountWei <= 0n) {
      throw createConflictError('each transfer amountWei must be > 0', { reasonCode: 'INVALID_RELAYER_BATCH' });
    }
    sumWei += leg.amountWei;
  }
  if (sumWei !== params.totalAmountWei) {
    throw createConflictError('transfers amountWei sum must equal totalAmountWei', {
      reasonCode: 'RELAYER_BATCH_SUM_MISMATCH',
      totalAmountWei: params.totalAmountWei.toString(),
      sumWei: sumWei.toString(),
    });
  }

  await recoverPolymarketDepositWithdrawalsForUser(params.userId);

  const ctx = await resolveDepositContext(params.userId);
  if (!ctx) {
    throw createConflictError('未配置 Polymarket deposit 地址，请先完成托管开通与 Polymarket 授权', {
      hint: 'POST /api/custody/open 或 /api/custody/authorize-polymarket',
    });
  }

  const normalizedLegs: Array<{ to: `0x${string}`; amountWei: bigint }> = [];
  for (const leg of legsIn) {
    normalizedLegs.push({
      to: assertValidWithdrawTo({ to: leg.to, deposit: ctx.deposit }),
      amountWei: leg.amountWei,
    });
  }

  const preview = await getPolymarketDepositWithdrawPreview(params.userId);
  const blockersNoQueue = (preview?.blockers ?? []).filter((b) => b !== 'WITHDRAW_IN_PROGRESS');
  if (!preview || blockersNoQueue.length > 0) {
    throw createConflictError('当前不满足提现条件', {
      reasonCode: 'POLYMARKET_WITHDRAW_PREVIEW_BLOCKED',
      blockers: preview?.blockers ?? ['UNKNOWN'],
      checks: preview?.checks,
    });
  }

  const maxWei = BigInt(preview.maxWithdrawableRaw);
  if (params.totalAmountWei > maxWei) {
    throw createConflictError('提现金额超过可提上限', {
      reasonCode: 'WITHDRAW_EXCEEDS_MAX',
      maxWithdrawableRaw: maxWei.toString(),
      maxWithdrawableFormatted: formatUnits(maxWei, 6),
    });
  }

  const amountDecimal = new Prisma.Decimal(params.totalAmountWei.toString()).div(1_000_000);
  const primaryTo = normalizedLegs[normalizedLegs.length - 1]!.to;

  const acquired = await acquirePolymarketDepositWithdrawRequestRow({
    userId: params.userId,
    idempotencyKey: params.idempotencyKey,
    deposit: ctx.deposit,
    toAddress: primaryTo,
    amountWei: params.totalAmountWei,
    amountDecimal,
  });
  if (acquired.mode === 'replay') {
    const replay = acquired.replay;
    return {
      transactionHash: replay.transactionHash,
      deposit: replay.deposit,
      requestId: replay.requestId,
      totalAmountStr: replay.amountStr,
      legs: normalizedLegs.map((leg) => ({
        ...leg,
        amountStr: formatUnits(leg.amountWei, 6),
      })),
    };
  }
  const requestRow = acquired.row;

  const custodial = ctx.custodial;
  const deposit = ctx.deposit;

  try {
    return await runWithDepositRelayerFailover(params.userId, custodial, async ({ relayClient, slotId }) => {
      await assertRelayDerivedDepositMatches(relayClient, deposit, custodial);
      await ensurePolymarketDepositWalletRegisteredWithRelayer(relayClient, deposit, { slotId });

      const unwrapPrefix = await buildUnwrapPusdPrefixCallsIfUsdceShort(getAddress(deposit), params.totalAmountWei);
      const transferCalls = normalizedLegs.map(({ to, amountWei }) => ({
        target: USDC_E_ADDRESS,
        value: '0',
        data: encodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          functionName: 'transfer',
          args: [to, amountWei],
        }),
      }));

      const calls = [...unwrapPrefix, ...transferCalls];

      const txResp = await executeDepositWalletBatchWithRetry(
        relayClient,
        deposit,
        calls,
        'POLYMARKET_RELAYER_SUBMIT_FAILED',
        { slotId },
      );

      await prisma.polymarketDepositWithdrawRequest.update({
        where: { id: requestRow.id },
        data: { status: 'RELAYER_SUBMITTED', relayerTransactionId: txResp.transactionID },
      });

      const result = await waitRelayerTxSuccess(relayClient, txResp.transactionID, {
        reasonCode: 'POLYMARKET_RELAYER_BATCH_TIMEOUT',
        message: 'Polymarket relayer 提现确认超时',
      });

      const transactionHash = (result.transactionHash || txResp.transactionHash || '').trim();
      if (!transactionHash.startsWith('0x')) {
        throw createConflictError('Relayer 未返回有效 transactionHash', { result });
      }

      const totalAmountStr = formatUnits(params.totalAmountWei, 6);
      const legs = normalizedLegs.map((leg) => ({
        ...leg,
        amountStr: formatUnits(leg.amountWei, 6),
      }));

      await prisma.polymarketDepositWithdrawRequest.update({
        where: { id: requestRow.id },
        data: { status: 'CONFIRMED', chainTxHash: transactionHash },
      });

      return {
        transactionHash,
        deposit,
        requestId: requestRow.id,
        totalAmountStr,
        legs,
      };
    }, {
      slotPreference: 'backup_first',
      op: 'platform_settlement',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.polymarketDepositWithdrawRequest.update({
      where: { id: requestRow.id },
      data: { status: 'FAILED', error: msg.slice(0, 2000) },
    });
    throw e;
  }
}

export async function withdrawPolymarketDepositToAddressV2(params: {
  userId: number;
  to: string;
  /** Human-readable USDC (6 decimals); required because Go authorization binds the exact amount. */
  amount: string;
  idempotencyKey: string;
  authorization: string;
}): Promise<{
  transactionHash: string;
  amount: string;
  deposit: string;
  to: string;
  requestId: string;
  replayed?: boolean;
}> {
  await recoverPolymarketDepositWithdrawalsForUser(params.userId);

  const idem = params.idempotencyKey.trim();
  if (!idem) {
    throw createConflictError('idempotencyKey is required', { reasonCode: 'WITHDRAW_INTENT_INCOMPLETE' });
  }
  if (!params.authorization.trim()) {
    throw createConflictError('Go withdrawal authorization is required', {
      reasonCode: 'WITHDRAW_AUTHORIZATION_REQUIRED',
    });
  }

  const existingLedger = await prisma.userWalletLedger.findUnique({
    where: { idempotencyKey: idem },
    select: { metadata: true, userId: true },
  });
  if (
    existingLedger &&
    existingLedger.userId === params.userId &&
    existingLedger.metadata &&
    typeof existingLedger.metadata === 'object'
  ) {
    const meta = existingLedger.metadata as { txHash?: string; requestId?: string };
    if (typeof meta.txHash === 'string' && meta.txHash.startsWith('0x')) {
      return {
        transactionHash: meta.txHash,
        amount: String((existingLedger.metadata as any).amount ?? ''),
        deposit: String((existingLedger.metadata as any).deposit ?? ''),
        to: String((existingLedger.metadata as any).to ?? ''),
        requestId: String(meta.requestId ?? ''),
        replayed: true,
      };
    }
  }

  const amountTrim = params.amount.trim();
  const amountSpec: DepositWalletUsdcRelayerAmountSpec = { kind: 'human', amount: amountTrim };

  const { transactionHash, amountStr, deposit, to, requestId } =
    await submitDepositWalletUsdcTransferViaRelayer({
      userId: params.userId,
      to: params.to,
      idempotencyKey: idem,
      amount: amountSpec,
      authorization: params.authorization,
    });

  const amountWei = parseUnits(amountStr, 6);
  const amountDecimal = new Prisma.Decimal(amountWei.toString()).div(1_000_000);
  const postCtx = await resolveDepositContext(params.userId);

  await appendUserWalletLedger({
    userId: params.userId,
    rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
    direction: WALLET_LEDGER_DIRECTION.CREDIT,
    amount: amountDecimal,
    symbol: 'USDC',
    category: WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT_EXTERNAL,
    refType: 'RELAYER_TX',
    refId: transactionHash,
    idempotencyKey: idem,
    metadata: {
      txHash: transactionHash,
      deposit,
      to,
      amount: amountStr,
      amountRaw: amountWei.toString(),
      requestId,
    },
  });

  invalidateOnChainUsdcBalanceCacheForCustodialUser(params.userId);
  invalidatePolymarketDepositUsdcBalanceCache(params.userId);
  invalidatePolymarketDepositWithdrawPreviewCache(params.userId);

  if (postCtx) {
    try {
      invalidateUserClobClientCache(params.userId, postCtx.custodial);
      const clob = await getClobClientForUser(params.userId, postCtx.custodial);
      await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    } catch (e) {
      console.warn('[polymarket-withdraw-v2] CLOB collateral refresh skipped', e);
    }
  }

  return {
    transactionHash,
    amount: amountStr,
    deposit,
    to,
    requestId,
  };
}
