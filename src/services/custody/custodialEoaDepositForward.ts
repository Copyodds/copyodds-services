/**
 * EOA 充值入账后自动归集：
 * - USDC.e → Polymarket deposit wallet → wrap pUSD
 * - 原生 USDC / USDT → Polymarket Bridge evm 地址（官方桥接 → pUSD 进 deposit）
 */
import { getAddress, type Address } from 'viem';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { isAppError } from '../../utils/appError';
import { getCustodialWalletForUser } from './custody';
import {
  fundPolymarketDepositFromCustody,
  type UsdcTokenVariant,
} from './fundPolymarketDepositService';
import { isEoaForwardGasRelayerConfigured } from './gasRelayerWallet';
import {
  publicClient,
  USDC_E_ADDRESS,
  USDC_NATIVE_ADDRESS,
  USDT_POLYGON_ADDRESS,
  USDT0_POLYGON_ADDRESS,
} from '../polymarket/web3';
import {
  scheduleAutoWrapAfterEoaForward,
  tryAutoWrapPolymarketDepositUsdce,
  type AutoWrapPolymarketDepositResult,
} from '../polymarket/polymarketDepositAutoWrap';
import {
  resolveEoaUsdcForwardRoute,
  shouldRouteNativeUsdcEoaToBridge,
  type EoaUsdcForwardDestination,
} from './eoaUsdcForwardRouting';

/** ERC20 transfer 预估 gas limit（含 buffer；Polygon 上 USDC transfer 通常 ~65k–90k） */
const ERC20_TRANSFER_GAS_LIMIT = 100_000n;
const DEBOUNCE_MS = 800;

const scheduleTimers = new Map<number, ReturnType<typeof setTimeout>>();
const forwardInFlight = new Map<number, Promise<CustodialEoaDepositPipelineResult>>();

export type CustodialEoaDepositPipelineResult = {
  forward: CustodialEoaForwardResult;
  wrap: AutoWrapPolymarketDepositResult | null;
};

export type CustodialEoaForwardResult = {
  attempted: boolean;
  completed: boolean;
  pendingGas: boolean;
  skippedReason?:
    | 'disabled'
    | 'no_balance'
    | 'already_in_flight'
    | 'no_funder';
  transfers?: Array<{
    token: UsdcTokenVariant;
    txHash: string | null;
    amount: string;
    destination: EoaUsdcForwardDestination;
  }>;
  error?: string;
};

export type ScheduleCustodialEoaDepositForwardOptions = {
  triggerTxHash?: string;
  triggerLogIndex?: number;
};

/** 每笔链上入账用 deposit tx 做幂等；relayer 路径 EOA 不发 tx，不能用 ETH nonce。 */
function sweepIdempotencyKey(
  userId: number,
  token: UsdcTokenVariant,
  destination: EoaUsdcForwardDestination,
  opts: {
    triggerTxHash?: string;
    triggerLogIndex?: number;
    balanceWei?: bigint;
    eoaTxNonce?: number;
  },
): string {
  const trigger = (opts.triggerTxHash ?? '').trim().toLowerCase();
  if (trigger) {
    return `eoa-auto-sweep-${userId}-${token}-${destination}-${trigger}-${opts.triggerLogIndex ?? 0}`;
  }
  return `eoa-auto-sweep-${userId}-${token}-${destination}-${opts.balanceWei?.toString() ?? '0'}-n${opts.eoaTxNonce ?? 0}`;
}

function isGasError(err: unknown): boolean {
  if (isAppError(err)) {
    const msg = err.message.toLowerCase();
    const details = err.details as { hint?: string; nativeBalanceWei?: string } | undefined;
    if (msg.includes('insufficient native token') || msg.includes('insufficient funds')) {
      return true;
    }
    if (typeof details?.nativeBalanceWei === 'string') {
      return true;
    }
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('insufficient native token') || msg.includes('insufficient funds');
  }
  return false;
}

async function readErc20Balance(account: Address, token: Address): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: [
      {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
      },
    ] as const,
    functionName: 'balanceOf',
    args: [account],
  });
}

/** 按当前 gas 价估算 EOA 上 ERC20 transfer 所需 POL（wei）。 */
async function estimateNativeGasForErc20Transfer(): Promise<bigint> {
  const feeHints = await publicClient.estimateFeesPerGas().catch(() => null);
  const gasPrice = feeHints?.maxFeePerGas ?? (await publicClient.getGasPrice());
  return ERC20_TRANSFER_GAS_LIMIT * gasPrice;
}

function formatGasNeedMessage(nativeGas: bigint, requiredGas: bigint): string {
  const havePol = (Number(nativeGas) / 1e18).toFixed(4);
  const needPol = (Number(requiredGas) / 1e18).toFixed(4);
  return `Insufficient POL for gas: have ${havePol} POL, need ~${needPol} POL on custodial EOA`;
}

async function upsertForwardJob(input: {
  userId: number;
  idempotencyKey: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'PENDING_GAS' | 'COMPLETED' | 'FAILED';
  triggerTxHash?: string;
  triggerLogIndex?: number;
  lastError?: string | null;
  incrementAttempts?: boolean;
}): Promise<void> {
  const attemptsInc = input.incrementAttempts ? { increment: 1 } : undefined;
  try {
    await (prisma as any).custodyEoaForwardJob.upsert({
    where: {
      userId_idempotencyKey: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    create: {
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      triggerTxHash: input.triggerTxHash ?? null,
      triggerLogIndex: input.triggerLogIndex ?? null,
      lastError: input.lastError ?? null,
      attempts: input.incrementAttempts ? 1 : 0,
      completedAt: input.status === 'COMPLETED' ? new Date() : null,
    },
    update: {
      status: input.status,
      triggerTxHash: input.triggerTxHash ?? undefined,
      triggerLogIndex: input.triggerLogIndex ?? undefined,
      lastError: input.lastError ?? null,
      ...(attemptsInc ? { attempts: attemptsInc } : {}),
      completedAt: input.status === 'COMPLETED' ? new Date() : null,
    },
  });
  } catch (e) {
    console.warn('[custodial-eoa-forward] CustodyEoaForwardJob upsert failed (run migration?)', {
      userId: input.userId,
      status: input.status,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

async function transferTokenFromCustody(
  userId: number,
  token: UsdcTokenVariant,
  opts?: ScheduleCustodialEoaDepositForwardOptions,
): Promise<{ txHash: string | null; amount: string; destination: EoaUsdcForwardDestination } | null> {
  const fromAddr = getAddress((await getCustodialWalletForUser(userId)).address as Address);
  const tokenAddr =
    token === 'native'
      ? USDC_NATIVE_ADDRESS
      : token === 'usdt'
        ? USDT_POLYGON_ADDRESS
        : token === 'usdt0'
          ? USDT0_POLYGON_ADDRESS
          : USDC_E_ADDRESS;
  const balance = await readErc20Balance(fromAddr, tokenAddr);
  if (balance <= 0n) {
    return null;
  }
  const eoaTxNonce = Number(
    await publicClient.getTransactionCount({ address: fromAddr, blockTag: 'pending' }),
  );

  const route = await resolveEoaUsdcForwardRoute(userId, token, 'auto_chain_deposit');

  const result = await fundPolymarketDepositFromCustody({
    userId,
    usdcToken: token,
    fundSource: 'auto_chain_deposit',
    idempotencyKey: sweepIdempotencyKey(userId, token, route.destination, {
      triggerTxHash: opts?.triggerTxHash,
      triggerLogIndex: opts?.triggerLogIndex,
      balanceWei: balance,
      eoaTxNonce,
    }),
    waitForReceipt: true,
  });
  return {
    txHash: result.txHash,
    amount: result.amount,
    destination: result.forwardDestination,
  };
}

/**
 * 将 custodial EOA 上 USDC.e / 原生 USDC / USDT 自动归集（USDC.e→deposit，原生 USDC/USDT→Bridge evm）。
 */
export async function tryCustodialEoaDepositForward(
  userId: number,
  opts?: ScheduleCustodialEoaDepositForwardOptions,
): Promise<CustodialEoaForwardResult> {
  if (!CONFIG.autoForwardEoaDeposit) {
    return { attempted: false, completed: false, pendingGas: false, skippedReason: 'disabled' };
  }

  const jobKey = `eoa-fwd-user-${userId}`;
  const triggerTxHash = opts?.triggerTxHash;
  const triggerLogIndex = opts?.triggerLogIndex;

  let bundle;
  try {
    bundle = await getCustodialWalletForUser(userId);
  } catch {
    return { attempted: false, completed: false, pendingGas: false, skippedReason: 'no_funder' };
  }

  if (!(bundle.polymarketFunderAddress ?? '').trim()) {
    return { attempted: false, completed: false, pendingGas: false, skippedReason: 'no_funder' };
  }

  const fromAddr = getAddress(bundle.address as Address);
  const [usdceBal, nativeBal, usdtBal, usdt0Bal, nativeGas] = await Promise.all([
    readErc20Balance(fromAddr, USDC_E_ADDRESS),
    readErc20Balance(fromAddr, USDC_NATIVE_ADDRESS),
    readErc20Balance(fromAddr, USDT_POLYGON_ADDRESS),
    readErc20Balance(fromAddr, USDT0_POLYGON_ADDRESS),
    publicClient.getBalance({ address: fromAddr }),
  ]);

  if (usdceBal <= 0n && nativeBal <= 0n && usdtBal <= 0n && usdt0Bal <= 0n) {
    return { attempted: false, completed: false, pendingGas: false, skippedReason: 'no_balance' };
  }

  if (!isEoaForwardGasRelayerConfigured()) {
    const requiredGas = await estimateNativeGasForErc20Transfer();
    if (nativeGas < requiredGas) {
      const gasMsg = formatGasNeedMessage(nativeGas, requiredGas);
      await upsertForwardJob({
        userId,
        idempotencyKey: jobKey,
        status: 'PENDING_GAS',
        triggerTxHash,
        triggerLogIndex,
        lastError: gasMsg,
        incrementAttempts: true,
      });
      return {
        attempted: true,
        completed: false,
        pendingGas: true,
        error: gasMsg,
      };
    }
  }

  await upsertForwardJob({
    userId,
    idempotencyKey: jobKey,
    status: 'IN_PROGRESS',
    triggerTxHash,
    triggerLogIndex,
    lastError: null,
    incrementAttempts: true,
  });

  const transfers: Array<{
    token: UsdcTokenVariant;
    txHash: string | null;
    amount: string;
    destination: EoaUsdcForwardDestination;
  }> = [];

  try {
    for (const token of ['usdce', 'native', 'usdt', 'usdt0'] as const) {
      const moved = await transferTokenFromCustody(userId, token, opts);
      if (moved) {
        transfers.push({
          token,
          txHash: moved.txHash,
          amount: moved.amount,
          destination: moved.destination,
        });
      }
    }

    const [usdceAfter, nativeAfter, usdtAfter, usdt0After] = await Promise.all([
      readErc20Balance(fromAddr, USDC_E_ADDRESS),
      readErc20Balance(fromAddr, USDC_NATIVE_ADDRESS),
      readErc20Balance(fromAddr, USDT_POLYGON_ADDRESS),
      readErc20Balance(fromAddr, USDT0_POLYGON_ADDRESS),
    ]);
    if (usdceAfter > 0n || nativeAfter > 0n || usdtAfter > 0n || usdt0After > 0n) {
      const remainMsg = `EOA still has balance after forward (usdce=${usdceAfter}, native=${nativeAfter}, usdt=${usdtAfter}, usdt0=${usdt0After})`;
      await upsertForwardJob({
        userId,
        idempotencyKey: jobKey,
        status: 'PENDING',
        triggerTxHash,
        triggerLogIndex,
        lastError: remainMsg,
      });
      return {
        attempted: true,
        completed: false,
        pendingGas: false,
        error: remainMsg,
        transfers,
      };
    }

    await upsertForwardJob({
      userId,
      idempotencyKey: jobKey,
      status: 'COMPLETED',
      triggerTxHash,
      triggerLogIndex,
      lastError: null,
    });

    if (transfers.some((t) => t.destination === 'deposit')) {
      scheduleAutoWrapAfterEoaForward(userId, 'eoa_forward_complete');
    }

    return { attempted: true, completed: true, pendingGas: false, transfers };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isGasError(err)) {
      await upsertForwardJob({
        userId,
        idempotencyKey: jobKey,
        status: 'PENDING_GAS',
        triggerTxHash,
        triggerLogIndex,
        lastError: msg,
      });
      return { attempted: true, completed: false, pendingGas: true, error: msg, transfers };
    }

    await upsertForwardJob({
      userId,
      idempotencyKey: jobKey,
      status: 'FAILED',
      triggerTxHash,
      triggerLogIndex,
      lastError: msg,
    });
    console.error('[custodial-eoa-forward] failed', { userId, error: msg });
    return { attempted: true, completed: false, pendingGas: false, error: msg, transfers };
  }
}

/** 入账检测后：EOA→funder 转出，再 await wrap（不依赖用户打开钱包页）。 */
export async function runCustodialEoaDepositPipeline(
  userId: number,
  opts?: ScheduleCustodialEoaDepositForwardOptions,
): Promise<CustodialEoaDepositPipelineResult> {
  const forward = await tryCustodialEoaDepositForward(userId, opts);
  let wrap: AutoWrapPolymarketDepositResult | null = null;
  const shouldWrap =
    CONFIG.autoWrapPolymarketDepositUsdce &&
    forward.completed &&
    (forward.transfers?.some((t) => t.destination === 'deposit') ?? false);
  if (shouldWrap) {
    try {
      wrap = await tryAutoWrapPolymarketDepositUsdce(userId);
      if (wrap.attempted && wrap.transactionHash) {
        console.info('[custodial-eoa-pipeline] wrap ok', {
          userId,
          txHash: wrap.transactionHash,
          wrappedWei: wrap.wrappedWei,
        });
      } else {
        // 首次可能因 RPC 延迟读到 0；scheduleAutoWrapAfterEoaForward 已在 forward 完成时挂上重试
        if (wrap.skippedReason && wrap.skippedReason !== 'zero_collateral') {
          console.warn('[custodial-eoa-pipeline] wrap skipped', { userId, ...wrap });
        } else {
          scheduleAutoWrapAfterEoaForward(userId, 'eoa_pipeline_wrap_retry');
        }
      }
    } catch (err) {
      console.error('[custodial-eoa-pipeline] wrap failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleAutoWrapAfterEoaForward(userId, 'eoa_pipeline_wrap_error_retry');
    }
  }
  return { forward, wrap };
}

function enqueueCustodialEoaDepositPipeline(
  userId: number,
  reason: string,
  opts?: ScheduleCustodialEoaDepositForwardOptions,
): Promise<CustodialEoaDepositPipelineResult> {
  const existing = forwardInFlight.get(userId);
  if (existing) {
    return existing;
  }

  const job = runCustodialEoaDepositPipeline(userId, opts)
    .then((result) => {
      if (result.forward.attempted) {
        console.info('[custodial-eoa-pipeline]', {
          userId,
          reason,
          ...result.forward,
          wrapTxHash: result.wrap?.transactionHash ?? null,
        });
      }
      return result;
    })
    .finally(() => {
      forwardInFlight.delete(userId);
    });
  forwardInFlight.set(userId, job);
  return job;
}

/** Go chain_monitor 回调：立即 EOA→funder→wrap（无 debounce，后台执行不阻塞 HTTP）。 */
export function triggerCustodialEoaDepositPipeline(
  userId: number,
  reason: string,
  opts?: ScheduleCustodialEoaDepositForwardOptions,
): void {
  if (!CONFIG.autoForwardEoaDeposit) {
    return;
  }
  void enqueueCustodialEoaDepositPipeline(userId, reason, opts);
}

export function scheduleCustodialEoaDepositForward(
  userId: number,
  reason: string,
  opts?: ScheduleCustodialEoaDepositForwardOptions,
): void {
  if (!CONFIG.autoForwardEoaDeposit) {
    return;
  }

  const prev = scheduleTimers.get(userId);
  if (prev) {
    clearTimeout(prev);
  }

  const t = setTimeout(() => {
    scheduleTimers.delete(userId);
    void enqueueCustodialEoaDepositPipeline(userId, reason, opts);
  }, DEBOUNCE_MS);

  scheduleTimers.set(userId, t);
}

export type CustodialEoaDepositStatus = {
  eoaUsdcBalanceFormatted: string;
  eoaNativeUsdcBalanceFormatted: string;
  eoaUsdtBalanceFormatted: string;
  eoaUsdt0BalanceFormatted: string;
  pendingForward: boolean;
  forwardStatus: string | null;
  forwardError: string | null;
  nativeUsdcForwardRoute: 'bridge_evm' | 'deposit' | null;
  usdtForwardRoute: 'bridge_evm' | null;
  usdt0ForwardRoute: 'bridge_evm' | null;
  depositFundingReady: boolean;
  depositFundingBlockReasons: string[];
};

/** 供前端展示「处理中」状态。 */
export async function getCustodialEoaDepositStatus(userId: number): Promise<CustodialEoaDepositStatus> {
  const bundle = await getCustodialWalletForUser(userId);
  const fromAddr = getAddress(bundle.address as Address);
  const [usdceBal, nativeBal, usdtBal, usdt0Bal] = await Promise.all([
    readErc20Balance(fromAddr, USDC_E_ADDRESS),
    readErc20Balance(fromAddr, USDC_NATIVE_ADDRESS),
    readErc20Balance(fromAddr, USDT_POLYGON_ADDRESS),
    readErc20Balance(fromAddr, USDT0_POLYGON_ADDRESS),
  ]);

  const job = (await (prisma as any).custodyEoaForwardJob.findFirst({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: { status: true, lastError: true },
  })) as { status: string; lastError: string | null } | null;

  const bridgeEnabled = shouldRouteNativeUsdcEoaToBridge('auto_chain_deposit');
  const hasEoaBalance = usdceBal > 0n || nativeBal > 0n || usdtBal > 0n || usdt0Bal > 0n;
  const pendingForward =
    hasEoaBalance ||
    job?.status === 'PENDING' ||
    job?.status === 'IN_PROGRESS' ||
    job?.status === 'PENDING_GAS';

  return {
    eoaUsdcBalanceFormatted: (Number(usdceBal) / 1_000_000).toFixed(6),
    eoaNativeUsdcBalanceFormatted: (Number(nativeBal) / 1_000_000).toFixed(6),
    eoaUsdtBalanceFormatted: (Number(usdtBal) / 1_000_000).toFixed(6),
    eoaUsdt0BalanceFormatted: (Number(usdt0Bal) / 1_000_000).toFixed(6),
    pendingForward,
    forwardStatus: job?.status ?? null,
    forwardError: job?.lastError ?? null,
    nativeUsdcForwardRoute: bridgeEnabled
      ? 'bridge_evm'
      : nativeBal > 0n
        ? 'deposit'
        : null,
    usdtForwardRoute: bridgeEnabled ? 'bridge_evm' : null,
    usdt0ForwardRoute: bridgeEnabled ? 'bridge_evm' : null,
    depositFundingReady: true,
    depositFundingBlockReasons: [],
  };
}
