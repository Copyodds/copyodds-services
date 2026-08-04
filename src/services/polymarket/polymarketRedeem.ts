/**
 * Polymarket CTF redeemPositions — Polygon mainnet (see docs.polymarket.com/developers/CTF/redeem)
 * 默认经 Builder Relayer 在 deposit wallet 上执行（与 CLOB BUY/SELL 一致，无需托管 EOA 的 MATIC）。
 */

import { ethers } from 'ethers';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { createConflictError } from '../../utils/appError';
import {
  assertAutomationPermission,
  getExecutionWalletForUser,
  recordAutomationAction,
} from './automationSession';
import {
  indexSetForOutcomeViem,
  isPolymarketRelayerBuilderConfigured,
  redeemCtfPositionsViaDepositRelayer,
} from './polymarketRelayerDeposit';
import { clearAutoRedeemFailures } from '../../copyTrading/services/autoRedeemFailureGuard';
import { resolveRedeemUsdcProceedsFromChain } from './redeemProceedsFromChain';

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
];

function getRpcProvider() {
  if (!CONFIG.rpcUrl) {
    throw new Error('RPC_URL is required for CTF redeem');
  }
  return new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl, {
    chainId: CONFIG.chainId || 137,
    name: 'polygon',
  });
}

function normalizeConditionId(conditionId: string): string {
  const hex = conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`;
  return ethers.utils.hexZeroPad(hex, 32);
}

/** Gnosis CTF index set for outcome slot i (binary and multi-outcome). */
export function indexSetForOutcome(outcomeIndex: number): ethers.BigNumber {
  return ethers.BigNumber.from(indexSetForOutcomeViem(outcomeIndex).toString());
}

export async function hasRedeemLog(userId: number, conditionId: string): Promise<boolean> {
  const norm = conditionId.toLowerCase();
  const row = await prisma.polymarketRedeemLog.findUnique({
    where: { userId_conditionId: { userId, conditionId: norm } },
  });
  return !!row;
}

export async function recordRedeemLog(userId: number, conditionId: string, txHash: string) {
  const norm = conditionId.toLowerCase();
  await prisma.polymarketRedeemLog.create({
    data: {
      userId,
      conditionId: norm,
      txHash,
    },
  });
}

async function resolveRedeemDepositAddress(
  userId: number,
  expectedAddress?: string
): Promise<string | null> {
  const ctx = await getExecutionWalletForUser(userId, expectedAddress);
  const depositRaw = (ctx.polymarketFunderAddress ?? '').trim();
  if (depositRaw && /^0x[a-fA-F0-9]{40}$/.test(depositRaw)) {
    return depositRaw.toLowerCase();
  }
  const custodial = ctx.address.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(custodial) ? custodial.toLowerCase() : null;
}

/** 链上确认该 condition 赎回已入账 USDC.e 才视为完成；$0 入账不阻塞后续重试。 */
export async function redeemProceedsUsdFromLog(
  userId: number,
  conditionId: string,
  depositAddress?: string | null
): Promise<number | null> {
  const norm = conditionId.toLowerCase();
  const log = await prisma.polymarketRedeemLog.findUnique({
    where: { userId_conditionId: { userId, conditionId: norm } },
    select: { txHash: true },
  });
  const txHash = log?.txHash?.trim();
  if (!txHash || !/^0x[a-f0-9]{64}$/i.test(txHash)) return null;

  const deposit =
    depositAddress?.trim().toLowerCase() ?? (await resolveRedeemDepositAddress(userId, undefined));
  if (!deposit) return null;

  const chain = await resolveRedeemUsdcProceedsFromChain(txHash, deposit);
  if (chain.kind !== 'confirmed') return null;
  return chain.usd;
}

async function clearRedeemLogIfZeroProceeds(
  userId: number,
  conditionId: string,
  depositAddress?: string | null
): Promise<boolean> {
  const usd = await redeemProceedsUsdFromLog(userId, conditionId, depositAddress);
  if (usd == null) return false;
  if (usd > 0) return false;
  const norm = conditionId.toLowerCase();
  await prisma.polymarketRedeemLog.deleteMany({
    where: { userId, conditionId: norm },
  });
  console.warn('[polymarket-redeem] cleared zero-proceeds redeem log to allow retry', {
    userId,
    conditionId: norm,
    proceedsUsd: usd,
  });
  return true;
}

export type RedeemParams = {
  conditionId: string;
  outcomeIndex: number;
  /** Data API `negativeRisk` — neg-risk 市场须走 Collateral Adapter */
  negativeRisk?: boolean;
  /** Data API 份额；NegRiskAdapter 白名单回退需要 */
  size?: number;
  /** Data API `asset` tokenId；用于读链上余额 */
  assetTokenId?: string;
};

/**
 * 托管 EOA 直连 redeem（仅 deposit 与 custodial 同址时的兜底；需该地址有 MATIC）。
 */
async function redeemCtfForUserViaCustodialEoa(
  userId: number,
  params: RedeemParams,
  expectedAddress?: string
): Promise<{ txHash: string }> {
  const { signer } = await getExecutionWalletForUser(userId, expectedAddress);
  const provider = getRpcProvider();
  const connected = signer.connect(provider);
  const ctf = new ethers.Contract(CTF, CTF_ABI, connected);

  const conditionBytes = normalizeConditionId(params.conditionId);
  const indexSets = [indexSetForOutcome(params.outcomeIndex)];

  const tx = await ctf.redeemPositions(USDC_E, ethers.constants.HashZero, conditionBytes, indexSets);
  const receipt = await tx.wait();
  const txHash = receipt.transactionHash ?? tx.hash;
  return { txHash };
}

/**
 * Execute redeemPositions on CTF. Caller should ensure position is redeemable and not already logged.
 * Neg-risk markets may require different flows; failures are thrown for logging.
 */
export async function redeemCtfForUser(
  userId: number,
  params: RedeemParams,
  expectedAddress?: string
): Promise<{ txHash: string }> {
  await assertAutomationPermission({ userId, action: 'REDEEM', expectedAddress });
  const ctx = await getExecutionWalletForUser(userId, expectedAddress);
  const custodial = ethers.utils.getAddress(ctx.address);
  const depositRaw = (ctx.polymarketFunderAddress ?? '').trim();

  let txHash: string;

  if (!depositRaw) {
    throw createConflictError('未配置 Polymarket deposit 地址，请先完成托管开通与 Polymarket 授权', {
      reasonCode: 'POLYMARKET_DEPOSIT_MISSING',
      hint: 'POST /api/custody/open 或 /api/custody/authorize-polymarket',
    });
  }

  const deposit = ethers.utils.getAddress(depositRaw);
  if (deposit.toLowerCase() === custodial.toLowerCase()) {
    if (!isPolymarketRelayerBuilderConfigured()) {
      console.warn('[polymarket-redeem] deposit equals custodial, falling back to EOA redeem', {
        userId,
        address: custodial,
      });
      ({ txHash } = await redeemCtfForUserViaCustodialEoa(userId, params, expectedAddress));
    } else {
      throw createConflictError(
        '当前钱包未使用独立 Polymarket deposit 地址，无法通过 relayer 赎回；请联系支持或完成 deposit 钱包开通。',
        { reasonCode: 'POLYMARKET_DEPOSIT_NOT_SEPARATE' }
      );
    }
  } else {
    ({ txHash } = await redeemCtfPositionsViaDepositRelayer({
      userId,
      custodialAddress: custodial,
      depositAddress: deposit,
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
      negativeRisk: params.negativeRisk,
      size: params.size,
      assetTokenId: params.assetTokenId,
    }));
  }

  await recordAutomationAction({
    userId,
    action: 'REDEEM',
    expectedAddress,
    txHash,
    referenceId: params.conditionId,
  });
  return { txHash };
}

export async function redeemIfLoggedOrSkip(
  userId: number,
  params: RedeemParams,
  expectedAddress?: string
): Promise<{ txHash?: string; skipped: boolean; reason?: string }> {
  const norm = params.conditionId.toLowerCase();
  const deposit = await resolveRedeemDepositAddress(userId, expectedAddress);

  if (await hasRedeemLog(userId, norm)) {
    const proceeds = await redeemProceedsUsdFromLog(userId, norm, deposit);
    if (proceeds != null && proceeds > 0) {
      await clearAutoRedeemFailures({
        userId,
        conditionId: norm,
        outcomeIndex: params.outcomeIndex,
      });
      return { skipped: true, reason: 'already_redeemed' };
    }
    if (proceeds != null && proceeds <= 0) {
      await clearRedeemLogIfZeroProceeds(userId, norm, deposit);
    } else {
      // RPC 读不到入账时不要当成 already_redeemed（否则前端显示成功、仓位被藏）。
      const log = await prisma.polymarketRedeemLog.findUnique({
        where: { userId_conditionId: { userId, conditionId: norm } },
        select: { txHash: true },
      });
      throw createConflictError(
        '已有赎回记录但无法确认 USDC.e 入账，未记为成功；请检查 RPC 后重试。',
        {
          reasonCode: 'POLYMARKET_REDEEM_LOG_UNVERIFIED',
          conditionId: norm,
          txHash: log?.txHash ?? null,
        }
      );
    }
  }

  const { txHash } = await redeemCtfForUser(userId, params, expectedAddress);

  if (deposit) {
    const chain = await resolveRedeemUsdcProceedsFromChain(txHash, deposit);
    if (chain.kind === 'confirmed' && chain.usd <= 0) {
      console.warn('[polymarket-redeem] redeem tx confirmed but zero USDC.e proceeds; not logging', {
        userId,
        conditionId: norm,
        outcomeIndex: params.outcomeIndex,
        txHash,
        negativeRisk: params.negativeRisk === true,
      });
      // NegRisk 误走 CTF 直兑时常出现「链上有 tx、仓位仍在、API 却 200」——不得记成功。
      throw createConflictError(
        '赎回交易已上链但未收到 USDC.e，未记为成功；请确认市场类型后重试。',
        {
          reasonCode: 'POLYMARKET_REDEEM_ZERO_PROCEEDS',
          txHash,
          conditionId: norm,
          outcomeIndex: params.outcomeIndex,
          negativeRisk: params.negativeRisk === true,
        }
      );
    }
    if (chain.kind !== 'confirmed') {
      console.warn('[polymarket-redeem] redeem tx submitted but proceeds unverified; not logging', {
        userId,
        conditionId: norm,
        outcomeIndex: params.outcomeIndex,
        txHash,
        chainKind: chain.kind,
      });
      throw createConflictError(
        '赎回交易已提交但无法确认 USDC.e 入账（RPC/解析失败），未记为成功；请稍后重试。',
        {
          reasonCode: 'POLYMARKET_REDEEM_PROCEEDS_UNVERIFIED',
          txHash,
          conditionId: norm,
          outcomeIndex: params.outcomeIndex,
          chainKind: chain.kind,
        }
      );
    }
  }

  await recordRedeemLog(userId, params.conditionId, txHash);
  await clearAutoRedeemFailures({
    userId,
    conditionId: params.conditionId,
    outcomeIndex: params.outcomeIndex,
  });
  return { txHash, skipped: false };
}
