/**
 * EOA 入账自动归集（方案 B）：custodial EOA 签 EIP-2612 permit（链下），
 * 平台 relayer 两笔链上 tx（permit → transferFrom）付 gas，EOA 无需 POL。
 */
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
import { invalidatePolymarketDepositUsdcBalanceCache } from '../polymarket/polymarketDepositWithdraw';
import { invalidatePolymarketDepositWithdrawPreviewCache } from '../polymarket/polymarketDepositWithdrawV2';
import { publicClient, USDC_E_ADDRESS, USDC_NATIVE_ADDRESS, USDT_POLYGON_ADDRESS, USDT0_POLYGON_ADDRESS } from '../polymarket/web3';
import {
  formatUnits,
  getAddress,
  numberToHex,
  parseSignature,
  type Address,
  type Hex,
} from 'viem';
import { polygon } from 'viem/chains';
import { goSignTypedData } from '../walletApi/goWalletClient';
import { syncCustodialPolymarketDepositFunderIfEmpty } from '../polymarket/polymarketAuth';
import { scheduleAutoWrapAfterEoaForward } from '../polymarket/polymarketDepositAutoWrap';
import {
  getEoaForwardGasRelayerAccount,
  getEoaForwardGasRelayerWalletClient,
  getEoaForwardRelayerAddress,
  isEoaForwardGasRelayerConfigured,
} from './gasRelayerWallet';
import type {
  FundPolymarketDepositOptions,
  FundPolymarketDepositResult,
  UsdcTokenVariant,
} from './fundPolymarketDepositService';
import { resolveEoaUsdcForwardRoute } from './eoaUsdcForwardRouting';

const ERC20_PERMIT_ABI = [
  {
    type: 'function',
    name: 'permit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'version',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const ERC20_TRANSFER_FROM_ABI = [
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

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
  return msg.includes('insufficient') && (msg.includes('funds') || msg.includes('balance'));
}

/** Polygon PoS bridged tokens (USDC.e / USDT0) use legacy EIP-712: salt = chainId (no chainId field). */
function usesPolygonLegacyPermitDomain(token: Address): boolean {
  const lower = getAddress(token).toLowerCase();
  return (
    lower === getAddress(USDC_E_ADDRESS).toLowerCase() ||
    lower === getAddress(USDT0_POLYGON_ADDRESS).toLowerCase()
  );
}

function polygonLegacyPermitSalt(chainId: number): Hex {
  return numberToHex(chainId, { size: 32 });
}

type PermitEip712Domain =
  | {
      kind: 'standard';
      domain: { name: string; version: string; chainId: number; verifyingContract: Address };
      eip712DomainTypes: Array<{ name: string; type: string }>;
    }
  | {
      kind: 'polygon_legacy';
      domain: { name: string; version: string; verifyingContract: Address; salt: Hex };
      eip712DomainTypes: Array<{ name: string; type: string }>;
    };

async function readPermitEip712Domain(token: Address): Promise<PermitEip712Domain> {
  const name = String(
    await publicClient.readContract({
      address: token,
      abi: ERC20_PERMIT_ABI,
      functionName: 'name',
    }),
  );
  const chainId = CONFIG.chainId || 137;

  if (usesPolygonLegacyPermitDomain(token)) {
    // https://github.com/maticnetwork/pos-portal EIP712Base — salt replaces chainId
    return {
      kind: 'polygon_legacy',
      domain: {
        name,
        version: '1',
        verifyingContract: token,
        salt: polygonLegacyPermitSalt(chainId),
      },
      eip712DomainTypes: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
    };
  }

  const version = String(
    await publicClient
      .readContract({
        address: token,
        abi: ERC20_PERMIT_ABI,
        functionName: 'version',
      })
      .catch(() => '2'),
  );
  return {
    kind: 'standard',
    domain: {
      name,
      version: version || '2',
      chainId,
      verifyingContract: token,
    },
    eip712DomainTypes: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
  };
}

function permitSignatureV(v: bigint | undefined, yParity?: number): number {
  if (v != null) {
    return Number(v >= 27n ? v : v + 27n);
  }
  if (yParity != null) {
    return yParity + 27;
  }
  throw new Error('Invalid permit signature: missing v/yParity');
}

async function signUsdcPermit(input: {
  referCode: string;
  walletIndex: number;
  walletPassword: string;
  token: Address;
  owner: Address;
  spender: Address;
  value: bigint;
  deadline: bigint;
}): Promise<Hex> {
  const permitDomain = await readPermitEip712Domain(input.token);
  const nonce = await publicClient.readContract({
    address: input.token,
    abi: ERC20_PERMIT_ABI,
    functionName: 'nonces',
    args: [input.owner],
  });

  const typedData = {
    types: {
      EIP712Domain: permitDomain.eip712DomainTypes,
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    domain: permitDomain.domain,
    message: {
      owner: input.owner,
      spender: input.spender,
      value: input.value,
      nonce,
      deadline: input.deadline,
    },
  };

  const { signature, address } = await goSignTypedData(
    input.referCode,
    input.walletIndex,
    input.walletPassword,
    typedData,
  );
  const owner = getAddress(input.owner);
  if (getAddress(address) !== owner) {
    throw new Error(`Go permit signer address mismatch: expected ${owner}, got ${address}`);
  }
  return signature as Hex;
}

export async function fundPolymarketDepositViaPermitRelayer(
  options: FundPolymarketDepositOptions,
): Promise<FundPolymarketDepositResult> {
  if (!isEoaForwardGasRelayerConfigured()) {
    throw createConflictError('EOA forward gas relayer is not configured');
  }

  const {
    userId,
    idempotencyKey,
    waitForReceipt = false,
    fundSource = 'manual_api',
    usdcToken = 'usdce',
  } = options;
  const tokenAddr = usdcTokenAddress(usdcToken);
  const tokenLabel = usdcTokenLabel(usdcToken);
  const relayer = getEoaForwardRelayerAddress();
  if (!relayer) {
    throw createConflictError('EOA forward gas relayer address unavailable');
  }

  const bundle = await getCustodialWalletForUser(userId);
  const { address: from, signingProvider, walletIndex, referCode, walletPassword } = bundle;
  const wid = bundle.walletId;
  if (wid == null) {
    throw createConflictError('Custodial wallet id missing');
  }
  if (
    signingProvider !== 'GO_REMOTE' ||
    walletIndex == null ||
    !referCode ||
    !walletPassword
  ) {
    throw createConflictError('Requires Go custodial wallet for permit signing');
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
    throw createConflictError('未配置 Polymarket deposit 地址');
  }

  const route = await resolveEoaUsdcForwardRoute(userId, usdcToken, fundSource);
  const to = route.transferTo;
  const owner = getAddress(from) as Address;
  if (to.toLowerCase() === owner.toLowerCase()) {
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
      await (prisma as any).custodyWithdrawRequest.delete({ where: { id: existing.id } });
    } else if (fundSource === 'auto_chain_deposit' && existing.status === 'BROADCASTED') {
      const onChainBal = await publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_PERMIT_ABI,
        functionName: 'balanceOf',
        args: [owner],
      });
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
  if (options.amountWei != null) {
    amountUnits = options.amountWei;
    if (amountUnits <= 0n) {
      throw createAppError({
        code: Code.VALIDATION_FAILED,
        httpStatus: 400,
        message: 'amount must be > 0',
      });
    }
  } else {
    amountUnits = await publicClient.readContract({
      address: tokenAddr,
      abi: ERC20_PERMIT_ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
    if (amountUnits <= 0n) {
      throw createConflictError(`托管地址链上 ${tokenLabel} 余额为 0`, { from: owner, usdcToken });
    }
  }

  const amountStr = formatUnits(amountUnits, 6);

  const withdrawReq = await (prisma as any).custodyWithdrawRequest.create({
    data: {
      userId,
      idempotencyKey: effectiveIdempotencyKey,
      fromAddress: owner,
      toAddress: to,
      amountRaw: amountUnits.toString(),
      amount: new Prisma.Decimal(amountUnits.toString()).div(1_000_000),
      status: 'PENDING',
    },
    select: { id: true },
  });

  let txHash: `0x${string}`;
  try {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await signUsdcPermit({
      referCode,
      walletIndex: Number(walletIndex),
      walletPassword,
      token: tokenAddr,
      owner,
      spender: relayer,
      value: amountUnits,
      deadline,
    });
    const { v, r, s, yParity } = parseSignature(signature);
    const permitV = permitSignatureV(v, yParity);

    const walletClient = getEoaForwardGasRelayerWalletClient();
    const relayerAccount = getEoaForwardGasRelayerAccount();

    // Polygon USDC.e: permit + transferFrom as two relayer txs (Multicall3 batch fails allowance check on legacy token).
    const permitTxHash = await walletClient.writeContract({
      account: relayerAccount,
      address: tokenAddr,
      abi: ERC20_PERMIT_ABI,
      functionName: 'permit',
      args: [owner, relayer, amountUnits, deadline, permitV, r, s],
      chain: { ...polygon, id: CONFIG.chainId || 137 },
    });

    const permitReceipt = await publicClient.waitForTransactionReceipt({ hash: permitTxHash });
    if (permitReceipt.status !== 'success') {
      throw createAppError({
        code: Code.DEPENDENCY_UNAVAILABLE,
        httpStatus: 502,
        message: `Polymarket deposit permit failed on-chain (txHash=${permitTxHash})`,
        details: { txHash: permitTxHash, receiptStatus: permitReceipt.status },
      });
    }

    txHash = await walletClient.writeContract({
      account: relayerAccount,
      address: tokenAddr,
      abi: ERC20_TRANSFER_FROM_ABI,
      functionName: 'transferFrom',
      args: [owner, to, amountUnits],
      chain: { ...polygon, id: CONFIG.chainId || 137 },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await (prisma as any).custodyWithdrawRequest.update({
      where: { id: withdrawReq.id },
      data: { status: 'FAILED', error: msg },
    });
    throw e instanceof Error ? e : new Error(msg);
  }

  await (prisma as any).custodyWithdrawRequest.update({
    where: { id: withdrawReq.id },
    data: { status: 'BROADCASTED', txHash: String(txHash), error: null },
  });

  const idem = `chain-pm-dep-relayer-${withdrawReq.id}`;
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
      from: owner,
      to,
      polymarketDeposit: route.depositAddress,
      amountRaw: amountUnits.toString(),
      fundSource,
      usdcToken,
      forwardDestination: route.destination,
      bridgeEvmAddress: route.bridgeEvmAddress ?? null,
      gasPayment: 'platform_relayer_permit',
      relayer,
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
          error: `Relayer transaction reverted (status=${receipt.status})`,
        },
      });
      throw createAppError({
        code: Code.DEPENDENCY_UNAVAILABLE,
        httpStatus: 502,
        message: `Polymarket deposit relayer forward failed on-chain (txHash=${txHash})`,
        details: { txHash, receiptStatus: receipt.status },
      });
    }
    if (route.destination === 'deposit') {
      scheduleAutoWrapAfterEoaForward(userId, `pm_deposit_confirmed:${txHash}`);
    }
  }

  console.info('[eoa-forward-relayer] permit+transferFrom ok', {
    userId,
    txHash,
    token: tokenLabel,
    amount: amountStr,
    relayer,
    owner,
    forwardDestination: route.destination,
    to,
  });

  return {
    idempotencyKey: effectiveIdempotencyKey,
    status: 'BROADCASTED',
    from: owner,
    to,
    polymarketDeposit: route.depositAddress,
    amount: amountStr,
    token: tokenLabel,
    txHash: String(txHash),
    forwardDestination: route.destination,
  };
}
