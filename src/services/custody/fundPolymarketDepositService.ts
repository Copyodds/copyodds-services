import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { Code } from '../../utils/response';
import { createAppError, createConflictError, isAppError } from '../../utils/appError';
import { getCustodialWalletForUser } from './custody';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from './userWalletLedger';
import { invalidateOnChainUsdcBalanceCacheForCustodialUser } from './custodyOnChainBalance';
import {
  invalidatePolymarketDepositUsdcBalanceCache,
} from '../polymarket/polymarketDepositWithdraw';
import { invalidatePolymarketDepositWithdrawPreviewCache } from '../polymarket/polymarketDepositWithdrawV2';
import {
  publicClient,
  broadcastRawTransaction,
  USDC_E_ADDRESS,
  USDC_NATIVE_ADDRESS,
  USDT_POLYGON_ADDRESS,
  USDT0_POLYGON_ADDRESS,
} from '../polymarket/web3';
import { encodeFunctionData, formatUnits, getAddress, toHex, type Address } from 'viem';
import { goSignTransaction } from '../walletApi/goWalletClient';
import { syncCustodialPolymarketDepositFunderIfEmpty } from '../polymarket/polymarketAuth';
import { scheduleAutoWrapAfterEoaForward } from '../polymarket/polymarketDepositAutoWrap';
import { isEoaForwardGasRelayerConfigured } from './gasRelayerWallet';
import { fundPolymarketDepositViaPermitRelayer } from './fundPolymarketDepositViaPermitRelayer';
import { resolveEoaUsdcForwardRoute } from './eoaUsdcForwardRouting';

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

export type UsdcTokenVariant = 'usdce' | 'native' | 'usdt' | 'usdt0';

export type FundPolymarketDepositSource = 'manual_api' | 'auto_order' | 'auto_chain_deposit';

export type FundPolymarketDepositOptions = {
  userId: number;
  /** Exact USDC amount (6 decimals). Omit to sweep full custodial balance for the selected token. */
  amountWei?: bigint;
  idempotencyKey?: string;
  /** Wait for on-chain receipt (recommended for auto-fund before CLOB order). */
  waitForReceipt?: boolean;
  fundSource?: FundPolymarketDepositSource;
  /** Which token to transfer from custodial EOA. Default USDC.e. */
  usdcToken?: UsdcTokenVariant;
};

export type FundPolymarketDepositResult = {
  idempotencyKey: string;
  status: string;
  from: string;
  to: string;
  polymarketDeposit: string;
  amount: string;
  token: 'USDC.e' | 'USDC' | 'USDT' | 'USDT0';
  txHash: string | null;
  forwardDestination: 'deposit' | 'bridge_evm';
};

function usdcTokenAddress(variant: UsdcTokenVariant): `0x${string}` {
  if (variant === 'native') return USDC_NATIVE_ADDRESS;
  if (variant === 'usdt') return USDT_POLYGON_ADDRESS;
  if (variant === 'usdt0') return USDT0_POLYGON_ADDRESS;
  return USDC_E_ADDRESS;
}

function usdcTokenLabel(variant: UsdcTokenVariant): 'USDC.e' | 'USDC' | 'USDT' | 'USDT0' {
  if (variant === 'native') return 'USDC';
  if (variant === 'usdt') return 'USDT';
  if (variant === 'usdt0') return 'USDT0';
  return 'USDC.e';
}

function ledgerSymbolForToken(variant: UsdcTokenVariant): 'USDC' | 'USDT' | 'USDT0' {
  if (variant === 'usdt') return 'USDT';
  if (variant === 'usdt0') return 'USDT0';
  return 'USDC';
}

function isGasRelatedWithdrawError(error: string | null | undefined): boolean {
  const msg = (error ?? '').toLowerCase();
  return msg.includes('insufficient native token') || msg.includes('insufficient funds');
}

function isMissingCustodyWithdrawTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { code?: unknown; message?: unknown };
  if (anyErr.code === 'P2021') return true;
  const msg = typeof anyErr.message === 'string' ? anyErr.message : '';
  return msg.includes('CustodyWithdrawRequest') && msg.includes('does not exist');
}

/**
 * Transfer USDC.e from the user's custodial address to their Polymarket deposit (POLY_1271 funder).
 * Throws AppError on business failures; throws raw err for missing DB table (caller maps to 503).
 */
export async function fundPolymarketDepositFromCustody(
  options: FundPolymarketDepositOptions
): Promise<FundPolymarketDepositResult> {
  const {
    userId,
    idempotencyKey,
    waitForReceipt = false,
    fundSource = 'manual_api',
    usdcToken = 'usdce',
  } = options;

  if (isEoaForwardGasRelayerConfigured()) {
    return fundPolymarketDepositViaPermitRelayer(options);
  }
  const tokenAddr = usdcTokenAddress(usdcToken);
  const tokenLabel = usdcTokenLabel(usdcToken);

  const bundle = await getCustodialWalletForUser(userId);
  const { address: from, signingProvider, walletIndex, referCode, walletPassword } = bundle;
  const wid = bundle.walletId;
  if (wid == null) {
    throw createConflictError('Custodial wallet id missing');
  }

  let depositRaw = (bundle.polymarketFunderAddress ?? '').trim();
  if (!depositRaw) {
    await syncCustodialPolymarketDepositFunderIfEmpty({
      userId,
      walletId: wid,
      ownerAddress: from,
    });
    const w = await prisma.wallet.findUnique({
      where: { id: wid },
      select: { polymarketFunderAddress: true },
    });
    depositRaw = (w?.polymarketFunderAddress ?? '').trim();
  }
  if (!depositRaw) {
    throw createConflictError(
      '未配置 Polymarket deposit 地址，请先完成托管开通与 Polymarket 授权',
      {
        hint: 'POST /api/custody/open 或 /api/custody/authorize-polymarket',
      }
    );
  }

  const route = await resolveEoaUsdcForwardRoute(userId, usdcToken, fundSource);
  const to = route.transferTo;
  if (to.toLowerCase() === from.toLowerCase()) {
    throw createConflictError('Transfer destination matches custodial address');
  }

  const effectiveIdempotencyKey = (idempotencyKey ?? '').trim() || randomUUID();

  const existing = await (prisma as any).custodyWithdrawRequest?.findUnique?.({
    where: { userId_idempotencyKey: { userId, idempotencyKey: effectiveIdempotencyKey } },
  });
  if (existing) {
    if (existing.status === 'FAILED') {
      const canRetry =
        fundSource === 'auto_chain_deposit' || isGasRelatedWithdrawError(existing.error);
      if (canRetry) {
        await (prisma as any).custodyWithdrawRequest.delete({ where: { id: existing.id } });
      } else {
        throw createConflictError('Request previously failed; use a new idempotencyKey', {
          idempotencyKey: effectiveIdempotencyKey,
          error: existing.error ?? null,
        });
      }
    } else if (fundSource === 'auto_chain_deposit' && existing.status === 'PENDING') {
      // 卡住的上一次 sweep 尝试：允许用新 idempotencyKey 重试
      await (prisma as any).custodyWithdrawRequest.delete({ where: { id: existing.id } });
    } else if (fundSource === 'auto_chain_deposit' && existing.status === 'BROADCASTED') {
      const onChainBal = await publicClient.readContract({
        address: tokenAddr,
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
        args: [getAddress(from)],
      }).catch(() => 0n);
      if (onChainBal > 0n) {
        await (prisma as any).custodyWithdrawRequest.delete({ where: { id: existing.id } });
      } else {
        return {
          idempotencyKey: effectiveIdempotencyKey,
          status: existing.status,
          from: existing.fromAddress,
          to: existing.toAddress,
          polymarketDeposit: route.depositAddress,
          amount: existing.amount?.toString?.() ?? '',
          token: tokenLabel,
          txHash: existing.txHash ?? null,
          forwardDestination: route.destination,
        };
      }
    } else {
      return {
        idempotencyKey: effectiveIdempotencyKey,
        status: existing.status,
        from: existing.fromAddress,
        to: existing.toAddress,
        polymarketDeposit: route.depositAddress,
        amount: existing.amount?.toString?.() ?? '',
        token: tokenLabel,
        txHash: existing.txHash ?? null,
        forwardDestination: route.destination,
      };
    }
  }

  let amountUnits: bigint;
  let amountStr: string;

  if (options.amountWei != null) {
    amountUnits = options.amountWei;
    if (amountUnits <= 0n) {
      throw createAppError({
        code: Code.VALIDATION_FAILED,
        httpStatus: 400,
        message: 'amount must be > 0',
      });
    }
    amountStr = formatUnits(amountUnits, 6);
  } else {
    const raw = await publicClient.readContract({
      address: tokenAddr,
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
      args: [from as `0x${string}`],
    });
    if (raw <= 0n) {
      throw createConflictError(`托管地址链上 ${tokenLabel} 余额为 0，无需划转`, { from, usdcToken });
    }
    amountUnits = raw;
    amountStr = formatUnits(raw, 6);
  }

  const withdrawReq = await (prisma as any).custodyWithdrawRequest.create({
    data: {
      userId,
      idempotencyKey: effectiveIdempotencyKey,
      fromAddress: from,
      toAddress: to,
      amountRaw: amountUnits.toString(),
      amount: new Prisma.Decimal(amountUnits.toString()).div(1_000_000),
      status: 'PENDING',
    },
    select: { id: true },
  });

  try {
    const native = await publicClient.getBalance({ address: from as `0x${string}` });
    const feeHints = await publicClient.estimateFeesPerGas().catch(() => null);
    const gasPrice = feeHints?.maxFeePerGas ?? (await publicClient.getGasPrice());
    const minGas = 100_000n * gasPrice;
    if (native < minGas) {
      await (prisma as any).custodyWithdrawRequest.update({
        where: { id: withdrawReq.id },
        data: { status: 'FAILED', error: 'Insufficient native token balance for gas' },
      });
      throw createConflictError('Insufficient native token balance for gas', {
        from,
        nativeBalanceWei: native.toString(),
        requiredMinWei: minGas.toString(),
        idempotencyKey: effectiveIdempotencyKey,
        hint: '托管 EOA 需要足够 POL 支付 USDC 转账 gas；当前 gas 价下建议至少 0.05 POL。',
      });
    }
  } catch (e) {
    if (isAppError(e)) {
      throw e;
    }
    /* ignore RPC errors for gas pre-check */
  }

  try {
    const rawBal = await publicClient.readContract({
      address: tokenAddr,
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
      args: [from as `0x${string}`],
    });
    if (rawBal < amountUnits) {
      await (prisma as any).custodyWithdrawRequest.update({
        where: { id: withdrawReq.id },
        data: { status: 'FAILED', error: 'Insufficient on-chain USDC balance' },
      });
      throw createConflictError('Insufficient on-chain USDC balance', {
        from,
        requested: amountUnits.toString(),
        available: rawBal.toString(),
        idempotencyKey: effectiveIdempotencyKey,
      });
    }
  } catch (e) {
    if (isAppError(e)) {
      throw e;
    }
    /* ignore */
  }

  let txHash: `0x${string}`;
  try {
    if (
      signingProvider !== 'GO_REMOTE' ||
      walletIndex == null ||
      !referCode ||
      !walletPassword
    ) {
      await (prisma as any).custodyWithdrawRequest.update({
        where: { id: withdrawReq.id },
        data: { status: 'FAILED', error: 'Requires GO_REMOTE wallet with walletIndex' },
      });
      throw createConflictError('Requires Go custodial wallet', {
        signingProvider,
        walletIndex,
        idempotencyKey: effectiveIdempotencyKey,
      });
    }
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [to, amountUnits],
    });
    const nonce = await publicClient.getTransactionCount({
      address: from as Address,
      blockTag: 'pending',
    });
    const gasLimit = await publicClient.estimateGas({
      account: from as Address,
      to: tokenAddr,
      data: data as `0x${string}`,
    });
    const feeHints = await publicClient.estimateFeesPerGas().catch(() => null);
    const chainId = CONFIG.chainId || 137;
    let out: Awaited<ReturnType<typeof goSignTransaction>>;
    if (feeHints?.maxFeePerGas != null && feeHints.maxPriorityFeePerGas != null) {
      out = await goSignTransaction({
        refer_code: referCode,
        walletIndex: Number(walletIndex),
        wallet_password: walletPassword,
        chainId,
        to: tokenAddr,
        data,
        value: '0x0',
        nonce,
        gasLimit: Number(gasLimit),
        maxFeePerGas: toHex(feeHints.maxFeePerGas),
        maxPriorityFeePerGas: toHex(feeHints.maxPriorityFeePerGas),
      });
    } else {
      const gasPrice = await publicClient.getGasPrice();
      out = await goSignTransaction({
        refer_code: referCode,
        walletIndex: Number(walletIndex),
        wallet_password: walletPassword,
        chainId,
        to: tokenAddr,
        data,
        value: '0x0',
        nonce,
        gasLimit: Number(gasLimit),
        gasPrice: toHex(gasPrice),
      });
    }
    if (out.code && out.code !== 0) {
      throw new Error(out.msg ?? `Go sign-transaction failed code=${out.code}`);
    }
    if (!out.rawTxHex) {
      throw new Error('Go sign-transaction returned empty rawTxHex');
    }
    txHash = await broadcastRawTransaction(out.rawTxHex as `0x${string}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lowered = msg.toLowerCase();
    const isInsufficient =
      lowered.includes('insufficient funds') ||
      lowered.includes('exceeds the balance of the account') ||
      (lowered.includes('insufficient') && lowered.includes('balance'));
    if (isInsufficient) {
      await (prisma as any).custodyWithdrawRequest.update({
        where: { id: withdrawReq.id },
        data: { status: 'FAILED', error: msg },
      });
      throw createConflictError('Insufficient funds (token balance or gas fee)', {
        from,
        to,
        amountRaw: amountUnits.toString(),
        error: msg,
        idempotencyKey: effectiveIdempotencyKey,
      });
    }
    await (prisma as any).custodyWithdrawRequest.update({
      where: { id: withdrawReq.id },
      data: { status: 'FAILED', error: msg },
    });
    if (isMissingCustodyWithdrawTableError(e)) {
      throw e;
    }
    throw e instanceof Error ? e : new Error(msg);
  }

  await (prisma as any).custodyWithdrawRequest.update({
    where: { id: withdrawReq.id },
    data: { status: 'BROADCASTED', txHash: String(txHash), error: null },
  });

  const idem = `chain-pm-dep-${withdrawReq.id}`;
  await appendUserWalletLedger({
    userId,
    rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
    direction: WALLET_LEDGER_DIRECTION.DEBIT,
    amount: new Prisma.Decimal(amountUnits.toString()).div(1_000_000),
    symbol: ledgerSymbolForToken(usdcToken),
    category: WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT,
    refType: 'ONCHAIN_TX',
    refId: String(txHash),
    idempotencyKey: idem,
    metadata: {
      withdrawRequestId: withdrawReq.id,
      idempotencyKey: effectiveIdempotencyKey,
      txHash,
      from,
      to,
      polymarketDeposit: route.depositAddress,
      amountRaw: amountUnits.toString(),
      fundSource,
      usdcToken,
      forwardDestination: route.destination,
      bridgeEvmAddress: route.bridgeEvmAddress ?? null,
    },
  });

  invalidateOnChainUsdcBalanceCacheForCustodialUser(userId);
  invalidatePolymarketDepositUsdcBalanceCache(userId);
  invalidatePolymarketDepositWithdrawPreviewCache(userId);

  if (waitForReceipt) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      await (prisma as any).custodyWithdrawRequest.update({
        where: { id: withdrawReq.id },
        data: {
          status: 'FAILED',
          error: `Transaction reverted or failed (status=${receipt.status})`,
        },
      });
      throw createAppError({
        code: Code.DEPENDENCY_UNAVAILABLE,
        httpStatus: 502,
        message: `Polymarket deposit funding transaction failed on-chain (txHash=${txHash})`,
        details: { txHash, receiptStatus: receipt.status },
      });
    }
    if (route.destination === 'deposit') {
      scheduleAutoWrapAfterEoaForward(userId, `pm_deposit_confirmed:${txHash}`);
    }
  }

  return {
    idempotencyKey: effectiveIdempotencyKey,
    status: 'BROADCASTED',
    from,
    to,
    polymarketDeposit: route.depositAddress,
    amount: amountStr,
    token: tokenLabel,
    txHash: String(txHash),
    forwardDestination: route.destination,
  };
}
