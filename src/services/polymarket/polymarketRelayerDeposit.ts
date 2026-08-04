/**
 * Shared Polymarket Builder Relayer helpers for deposit wallets (WALLET-CREATE, batches).
 */
import { RelayClient, RelayerTransactionState } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { ethers } from 'ethers';
import { encodeFunctionData, getAddress, maxUint256, padHex, type Address, type Hex } from 'viem';
import { CONFIG } from '../../config/env';
import { createConflictError, isAppError } from '../../utils/appError';
import { getCustodialExecutionWallet } from '../custody/custody';
import {
  COLLATERAL_OFFRAMP_ADDRESS,
  COLLATERAL_ONRAMP_ADDRESS,
  getPusdBalance,
  getUsdcBalance,
  publicClient,
  PUSD_TOKEN,
  USDC_E_ADDRESS,
  WCOL_TOKEN,
} from './web3';
import {
  getAllPolymarketCollateralSpenders,
  getAllPolymarketConditionalOperators,
} from './polymarketContractSpenders';
import {
  isSellApprovalsPrepCached,
  markSellApprovalsPrepCached,
  invalidatePusdClobSyncCache,
} from './polymarketDepositPrepCache';
import {
  builderSlotPool,
  createBuilderConfigForSlot,
  getBuilderCredentialSlotsForPreference,
  getBuilderQuotaCooldownRemainingMs,
  isAnyBuilderSlotAvailable,
  listBuilderCredentialSlots,
  noteBuilderSlotQuotaCooldown,
  type BuilderCredentialSlot,
  type BuilderSlotPreference,
} from './polymarketBuilderCredentials';
import { persistPolymarketWalletCreateRelayerTxId, loadPolymarketWalletCreateRelayerTxId } from './polymarketWalletCreateRelayerTx';
import { resolvePolymarketDepositWalletAddress } from './polymarketDepositWalletDerive';
import type { GoWithdrawalAuthorization } from '../walletApi/goWalletClient';
import { resolveRedeemUsdcProceedsFromChain } from './redeemProceedsFromChain';

export {
  buildNegRiskAdapterRedeemAmounts,
  encodeNegRiskAdapterRedeemCall,
  sharesToConditionalTokenRaw,
} from './negRiskAdapterRedeemEncode';

export { getBuilderCredentialSlotStatus } from './polymarketBuilderCredentials';

const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as const;

const CTF_PARENT_COLLECTION_ID_ZERO =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

const CTF_REDEEM_ABI = [
  {
    type: 'function',
    name: 'redeemPositions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const;

export type DepositRelayerCall = { target: string; value: string; data: `0x${string}` };

export function normalizeConditionIdToBytes32(conditionId: string): Hex {
  const hex = (conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`) as Hex;
  return padHex(hex, { size: 32 });
}

/** Gnosis CTF index set for outcome slot i. */
export function indexSetForOutcomeViem(outcomeIndex: number): bigint {
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0) {
    throw createConflictError('Invalid outcomeIndex for CTF redeem');
  }
  return 1n << BigInt(outcomeIndex);
}

export function encodeCtfRedeemPositionsCall(params: {
  conditionId: string;
  outcomeIndex: number;
  collateralToken?: string;
}): `0x${string}` {
  return encodeFunctionData({
    abi: CTF_REDEEM_ABI,
    functionName: 'redeemPositions',
    args: [
      getAddress(params.collateralToken ?? USDC_E_ADDRESS),
      CTF_PARENT_COLLECTION_ID_ZERO,
      normalizeConditionIdToBytes32(params.conditionId),
      [indexSetForOutcomeViem(params.outcomeIndex)],
    ],
  });
}

/** 直连 CTF 赎回双方 outcome（与已成功的 auto_redeem 链上路径一致；Relayer 常已放行 CTF:0x01b7037c）。 */
export function encodeCtfRedeemBothOutcomesCall(params: {
  conditionId: string;
  collateralToken?: string;
}): `0x${string}` {
  return encodeFunctionData({
    abi: CTF_REDEEM_ABI,
    functionName: 'redeemPositions',
    args: [
      getAddress(params.collateralToken ?? USDC_E_ADDRESS),
      CTF_PARENT_COLLECTION_ID_ZERO,
      normalizeConditionIdToBytes32(params.conditionId),
      [1n, 2n],
    ],
  });
}

/** V2 adapter redeem 前须 CTF setApprovalForAll(adapter)，否则 relayer 模拟会 400 / 链上 revert。 */
export async function collectCtfAdapterApprovalCalls(
  deposit: Address,
  adapterAddress: Address
): Promise<DepositRelayerCall[]> {
  const operator = getAddress(adapterAddress);
  const owner = getAddress(deposit);
  const approved = await publicClient.readContract({
    address: CTF_CONTRACT,
    abi: ERC1155_ABI,
    functionName: 'isApprovedForAll',
    args: [owner, operator],
  });
  if (approved) {
    return [];
  }
  const data = encodeFunctionData({
    abi: ERC1155_ABI,
    functionName: 'setApprovalForAll',
    args: [operator, true],
  });
  return [{ target: CTF_CONTRACT, value: '0', data }];
}

/** Neg-risk / 标准 V2：经 Collateral Adapter 赎回；挂单价无关，indexSets=[1,2] 烧掉全部份额、赢面付 pUSD。 */
export function encodeCollateralAdapterRedeemCall(params: {
  conditionId: string;
}): `0x${string}` {
  return encodeFunctionData({
    abi: CTF_REDEEM_ABI,
    functionName: 'redeemPositions',
    args: [
      getAddress(PUSD_TOKEN),
      CTF_PARENT_COLLECTION_ID_ZERO,
      normalizeConditionIdToBytes32(params.conditionId),
      [1n, 2n],
    ],
  });
}

/** @deprecated 使用 encodeCollateralAdapterRedeemCall */
export function encodeNegRiskCollateralAdapterRedeemCall(params: {
  conditionId: string;
}): `0x${string}` {
  return encodeCollateralAdapterRedeemCall(params);
}

const CTF_POSITION_ID_ABI = [
  {
    type: 'function',
    name: 'getCollectionId',
    stateMutability: 'pure',
    inputs: [
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSet', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getPositionId',
    stateMutability: 'pure',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'collectionId', type: 'bytes32' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const WCOL_UNWRAP_ABI = [
  {
    type: 'function',
    name: 'unwrap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export type RedeemOutcomeCollateralKind = 'wcol' | 'pusd' | 'usdce' | 'unknown';

/**
 * 用 Data API asset tokenId 反推该 outcome 代币挂在哪种 CTF collateral 下。
 * neg-risk 常见为 WCOL；V2 标准/部分市场为 pUSD；老市场为 USDC.e。
 */
export async function resolveRedeemOutcomeCollateralKind(params: {
  conditionId: string;
  assetTokenId?: string;
}): Promise<RedeemOutcomeCollateralKind> {
  const asset = (params.assetTokenId ?? '').trim();
  if (!asset || !/^\d+$/.test(asset)) return 'unknown';
  const assetId = BigInt(asset);
  const conditionId = normalizeConditionIdToBytes32(params.conditionId);
  const candidates: Array<{ kind: RedeemOutcomeCollateralKind; collateral: Address }> = [
    { kind: 'wcol', collateral: getAddress(WCOL_TOKEN) },
    { kind: 'pusd', collateral: getAddress(PUSD_TOKEN) },
    { kind: 'usdce', collateral: getAddress(USDC_E_ADDRESS) },
  ];
  try {
    for (const { kind, collateral } of candidates) {
      for (const indexSet of [1n, 2n]) {
        const collectionId = await publicClient.readContract({
          address: CTF_CONTRACT,
          abi: CTF_POSITION_ID_ABI,
          functionName: 'getCollectionId',
          args: [CTF_PARENT_COLLECTION_ID_ZERO, conditionId, indexSet],
        });
        const positionId = await publicClient.readContract({
          address: CTF_CONTRACT,
          abi: CTF_POSITION_ID_ABI,
          functionName: 'getPositionId',
          args: [collateral, collectionId],
        });
        if (positionId === assetId) return kind;
      }
    }
  } catch (e) {
    console.warn('[polymarket-relayer] resolveRedeemOutcomeCollateralKind failed', {
      conditionId: params.conditionId,
      assetTokenId: asset,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return 'unknown';
}

function encodeWcolUnwrapCall(to: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: WCOL_UNWRAP_ABI,
    functionName: 'unwrap',
    args: [getAddress(to), amount],
  });
}

export async function executeDepositWalletBatchWithRetry(
  relayClient: RelayClient,
  deposit: string,
  calls: DepositRelayerCall[],
  submitFailureReasonCode: string,
  opts?: { slotId?: string },
): Promise<{ transactionID: string; transactionHash?: string }> {
  if (isDepositRegistryStuck(deposit)) {
    throw createDepositRegistryStuckError(deposit);
  }
  const deadline = Math.floor(Date.now() / 1000 + 600).toString();
  let txResp;
  try {
    txResp = await relayClient.executeDepositWalletBatch(calls, deposit, deadline);
  } catch (e) {
    const msg = relayerThrownMessage(e);
    if (isWalletNotRegisteredBatchError(msg)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        await ensurePolymarketDepositWalletRegisteredWithRelayer(relayClient, deposit, {
          ...opts,
          forceRedeploy: true,
        });
        if (attempt > 0) {
          await sleepMs(2500);
        }
        try {
          txResp = await relayClient.executeDepositWalletBatch(calls, deposit, deadline);
          return txResp;
        } catch (e2) {
          const msg2 = relayerThrownMessage(e2);
          if (isWalletNotRegisteredBatchError(msg2) && attempt === 0) {
            console.warn('[polymarket-relayer] wallet still not registered after forced redeploy, retrying', {
              deposit,
              slotId: opts?.slotId ?? 'primary',
            });
            continue;
          }
          if (isWalletNotRegisteredBatchError(msg2)) {
            noteDepositRegistryStuck(deposit);
            console.error('[polymarket-relayer] deposit registry stuck after forced redeploy attempts', {
              deposit,
              slotId: opts?.slotId ?? 'primary',
              cooldownMs: REGISTRY_STUCK_COOLDOWN_MS,
            });
            throw createDepositRegistryStuckError(deposit);
          }
          throwRelayerSubmitError(e2, submitFailureReasonCode, opts?.slotId);
        }
      }
      throwRelayerSubmitError(e, submitFailureReasonCode, opts?.slotId);
    } else {
      throwRelayerSubmitError(e, submitFailureReasonCode, opts?.slotId);
    }
  }
  return txResp;
}

type RedeemRelayerPath = 'collateral_adapter' | 'ctf_wcol' | 'ctf_direct';

/**
 * 在 Polymarket deposit wallet 上通过 Builder Relayer 调用 CTF redeemPositions（与 BUY/SELL 一致，无需托管 EOA 上的 MATIC）。
 *
 * Neg-risk 仓位多数挂在 WCOL（不是 pUSD）。路径按 collateral 选择：
 * - WCOL：NegRiskCtfCollateralAdapter → CTF(WCOL)+unwrap(USDC.e)
 * - pUSD：NegRiskCtfCollateralAdapter → 直连 CTF(pUSD)
 * - 其它：Collateral Adapter → 直连 CTF(USDC.e)
 *
 * 不调用已废弃的 NegRiskAdapter（CLOB v1；Relayer V2 会 not permitted）。
 * 任一路经「not permitted / not whitelisted」或「上链成功但入账为 0」时自动试下一条。
 */
export async function redeemCtfPositionsViaDepositRelayer(params: {
  userId: number;
  custodialAddress: string;
  depositAddress: string;
  conditionId: string;
  outcomeIndex: number;
  negativeRisk?: boolean;
  /** Data API 份额；NegRiskAdapter 回退需要 */
  size?: number;
  /** Data API asset tokenId；用于读链上 CTF 余额 */
  assetTokenId?: string;
}): Promise<{ txHash: string }> {
  if (!isPolymarketRelayerBuilderConfigured()) {
    throw createConflictError(
      'Polymarket deposit 赎回需配置 POLYMARKET_BUILDER_API_KEY、POLYMARKET_BUILDER_SECRET、POLYMARKET_BUILDER_PASSPHRASE（及 POLYMARKET_RELAYER_URL）。',
      { reasonCode: 'POLYMARKET_RELAYER_NOT_CONFIGURED' }
    );
  }

  const custodial = ethers.utils.getAddress(params.custodialAddress);
  const deposit = ethers.utils.getAddress(params.depositAddress);
  if (deposit.toLowerCase() === custodial.toLowerCase()) {
    throw createConflictError('当前未使用独立 Polymarket deposit 钱包，无法通过 relayer 赎回', {
      reasonCode: 'POLYMARKET_DEPOSIT_NOT_SEPARATE',
    });
  }

  return runWithDepositRelayerFailover(
    params.userId,
    custodial,
    async ({ relayClient, slotId }) => {
    await assertRelayDerivedDepositMatches(relayClient, deposit, custodial);
    await ensurePolymarketDepositWalletRegisteredWithRelayer(relayClient, deposit, { slotId });

    const negativeRisk = params.negativeRisk === true;
    const collateralKind = await resolveRedeemOutcomeCollateralKind({
      conditionId: params.conditionId,
      assetTokenId: params.assetTokenId,
    });
    const collateralAdapter = getAddress(
      negativeRisk
        ? CONFIG.negRiskCtfCollateralAdapterAddress
        : CONFIG.ctfCollateralAdapterAddress
    );
    const ctfTarget = getAddress(CTF_CONTRACT);
    const wcolTarget = getAddress(WCOL_TOKEN);
    const triedTargets: string[] = [];
    const triedPaths: RedeemRelayerPath[] = [];
    let lastTxHash: string | null = null;
    let lastPath: RedeemRelayerPath | null = null;
    let lastTarget: string | null = null;
    let sawNotWhitelisted = false;
    const notWhitelistedErrors: Array<{ path: RedeemRelayerPath; target: string; error: string }> =
      [];

    console.info('[polymarket-relayer] redeem collateral kind', {
      userId: params.userId,
      deposit,
      conditionId: params.conditionId,
      outcomeIndex: params.outcomeIndex,
      negativeRisk,
      collateralKind,
      assetTokenId: params.assetTokenId ?? null,
      builderSlotId: slotId,
    });

    const submitPath = async (
      path: RedeemRelayerPath,
      target: string,
      calls: DepositRelayerCall[],
      reason: string
    ): Promise<'submitted' | 'not_whitelisted' | 'skipped'> => {
      if (triedPaths.includes(path)) return 'skipped';
      triedPaths.push(path);
      triedTargets.push(target);
      console.warn('[polymarket-relayer] attempting redeem path', {
        userId: params.userId,
        deposit,
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        negativeRisk,
        collateralKind,
        builderSlotId: slotId,
        redeemPath: path,
        redeemTarget: target,
        reason: reason.slice(0, 240),
        triedPaths: [...triedPaths],
      });
      try {
        const txResp = await executeDepositWalletBatchWithRetry(
          relayClient,
          deposit,
          calls,
          'POLYMARKET_RELAYER_REDEEM_SUBMIT_FAILED',
          { slotId }
        );
        const result = await waitRelayerTxSuccess(relayClient, txResp.transactionID, {
          reasonCode: 'POLYMARKET_RELAYER_REDEEM_TIMEOUT',
          message: 'Polymarket relayer 赎回确认超时',
        });
        const txHash = result.transactionHash || txResp.transactionHash;
        if (!txHash || !txHash.startsWith('0x')) {
          throw createConflictError('Polymarket relayer 赎回已完成但未返回 transactionHash', {
            reasonCode: 'POLYMARKET_RELAYER_REDEEM_NO_TX_HASH',
            transactionID: txResp.transactionID,
            redeemPath: path,
          });
        }
        lastTxHash = txHash;
        lastPath = path;
        lastTarget = target;
        return 'submitted';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Relayer V2 常见文案：call blocked / not permitted（旧版也有 not whitelisted）
        if (/not whitelisted|not permitted|call blocked/i.test(msg)) {
          sawNotWhitelisted = true;
          notWhitelistedErrors.push({ path, target, error: msg.slice(0, 500) });
          console.warn('[polymarket-relayer] redeem path not allowed by relayer', {
            userId: params.userId,
            redeemPath: path,
            redeemTarget: target,
            error: msg.slice(0, 500),
          });
          return 'not_whitelisted';
        }
        throw e;
      }
    };

    const buildCollateralAdapterCalls = async (): Promise<DepositRelayerCall[]> => {
      const approvalCalls = await collectCtfAdapterApprovalCalls(
        deposit as Address,
        collateralAdapter as Address
      );
      return [
        ...approvalCalls,
        {
          target: collateralAdapter,
          value: '0',
          data: encodeCollateralAdapterRedeemCall({ conditionId: params.conditionId }),
        },
      ];
    };

    /** 仅 CTF(WCOL) 赎回（不要与 unwrap 同批：Relayer 常未放行 WCOL.unwrap，会拖垮整批）。 */
    const buildCtfWcolCalls = (): DepositRelayerCall[] => [
      {
        target: ctfTarget,
        value: '0',
        data: encodeCtfRedeemBothOutcomesCall({
          conditionId: params.conditionId,
          collateralToken: WCOL_TOKEN,
        }),
      },
    ];

    /** 赎回入 WCOL 后尽量 unwrap→USDC.e；未放行则保留 WCOL（等值抵押，仍算兑付成功）。 */
    const tryUnwrapWcolBestEffort = async (expectedAmount: bigint): Promise<string | null> => {
      if (expectedAmount <= 0n) return null;
      try {
        const txResp = await executeDepositWalletBatchWithRetry(
          relayClient,
          deposit,
          [
            {
              target: wcolTarget,
              value: '0',
              data: encodeWcolUnwrapCall(deposit as Address, expectedAmount),
            },
          ],
          'POLYMARKET_RELAYER_REDEEM_SUBMIT_FAILED',
          { slotId }
        );
        const result = await waitRelayerTxSuccess(relayClient, txResp.transactionID, {
          reasonCode: 'POLYMARKET_RELAYER_REDEEM_TIMEOUT',
          message: 'Polymarket relayer WCOL unwrap 确认超时',
        });
        return result.transactionHash || txResp.transactionHash || null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[polymarket-relayer] WCOL unwrap skipped after redeem', {
          userId: params.userId,
          deposit,
          conditionId: params.conditionId,
          expectedAmount: expectedAmount.toString(),
          error: msg.slice(0, 240),
        });
        return null;
      }
    };

    const buildCtfDirectCalls = (collateralToken: string): DepositRelayerCall[] => [
      {
        target: ctfTarget,
        value: '0',
        data: encodeCtfRedeemBothOutcomesCall({
          conditionId: params.conditionId,
          collateralToken,
        }),
      },
    ];

    type PathStep = {
      path: RedeemRelayerPath;
      target: string;
      build: () => Promise<DepositRelayerCall[] | null> | DepositRelayerCall[] | null;
    };

    const pathPlan: PathStep[] = [];
    if (negativeRisk && collateralKind === 'wcol') {
      // V2：NegRiskCtfCollateralAdapter；CTF(WCOL) 作 fallback。不走已废弃 NegRiskAdapter。
      pathPlan.push(
        {
          path: 'collateral_adapter',
          target: collateralAdapter,
          build: () => buildCollateralAdapterCalls(),
        },
        {
          path: 'ctf_wcol',
          target: ctfTarget,
          build: () => buildCtfWcolCalls(),
        }
      );
    } else if (negativeRisk) {
      pathPlan.push({
        path: 'collateral_adapter',
        target: collateralAdapter,
        build: () => buildCollateralAdapterCalls(),
      });
      if (collateralKind === 'unknown') {
        pathPlan.push({
          path: 'ctf_wcol',
          target: ctfTarget,
          build: () => buildCtfWcolCalls(),
        });
      }
      if (collateralKind === 'usdce' || collateralKind === 'unknown') {
        pathPlan.push({
          path: 'ctf_direct',
          target: ctfTarget,
          build: () => buildCtfDirectCalls(USDC_E_ADDRESS),
        });
      }
      if (collateralKind === 'pusd') {
        pathPlan.push({
          path: 'ctf_direct',
          target: ctfTarget,
          build: () => buildCtfDirectCalls(PUSD_TOKEN),
        });
      }
    } else {
      pathPlan.push({
        path: 'collateral_adapter',
        target: collateralAdapter,
        build: () => buildCollateralAdapterCalls(),
      });
      pathPlan.push({
        path: 'ctf_direct',
        target: ctfTarget,
        build: () =>
          buildCtfDirectCalls(collateralKind === 'pusd' ? PUSD_TOKEN : USDC_E_ADDRESS),
      });
    }

    for (let i = 0; i < pathPlan.length; i++) {
      const step = pathPlan[i]!;
      const calls = await step.build();
      if (!calls || calls.length === 0) continue;

      const submitResult = await submitPath(
        step.path,
        step.target,
        calls,
        i === 0 ? 'primary' : `fallback after ${triedPaths[triedPaths.length - 1] ?? 'prior'}`
      );
      if (submitResult !== 'submitted' || !lastTxHash) {
        continue;
      }

      const proceeds = await resolveRedeemUsdcProceedsFromChain(lastTxHash, deposit);
      if (proceeds.kind !== 'confirmed') {
        console.warn('[polymarket-relayer] redeem proceeds unverified; stopping path failover', {
          userId: params.userId,
          conditionId: params.conditionId,
          redeemPath: lastPath,
          txHash: lastTxHash,
        });
        break;
      }
      if (proceeds.usd > 0) {
        if (lastPath === 'ctf_wcol') {
          const unwrapRaw = BigInt(Math.round(proceeds.usd * 1_000_000));
          const unwrapTx = await tryUnwrapWcolBestEffort(unwrapRaw);
          console.info('[polymarket-relayer] WCOL redeem succeeded; unwrap attempted', {
            userId: params.userId,
            deposit,
            conditionId: params.conditionId,
            redeemTxHash: lastTxHash,
            unwrapTxHash: unwrapTx,
            proceedsUsd: proceeds.usd,
          });
        }
        console.info('[polymarket-relayer] CTF redeem via deposit wallet', {
          userId: params.userId,
          deposit,
          conditionId: params.conditionId,
          outcomeIndex: params.outcomeIndex,
          negativeRisk,
          collateralKind,
          redeemPath: lastPath,
          redeemTarget: lastTarget,
          builderSlotId: slotId,
          txHash: lastTxHash,
          proceedsUsd: proceeds.usd,
          triedPaths,
        });
        return { txHash: lastTxHash };
      }

      const hasNext = pathPlan.slice(i + 1).some((p) => !triedPaths.includes(p.path));
      console.warn('[polymarket-relayer] redeem tx confirmed with zero proceeds; trying next path', {
        userId: params.userId,
        deposit,
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        negativeRisk,
        collateralKind,
        redeemPath: lastPath,
        redeemTarget: lastTarget,
        txHash: lastTxHash,
        hasNext,
        triedPaths,
      });
      if (!hasNext) break;
    }

    if (lastTxHash) {
      console.info('[polymarket-relayer] CTF redeem via deposit wallet (zero proceeds after failover)', {
        userId: params.userId,
        deposit,
        conditionId: params.conditionId,
        outcomeIndex: params.outcomeIndex,
        negativeRisk,
        collateralKind,
        redeemPath: lastPath,
        redeemTarget: lastTarget,
        builderSlotId: slotId,
        txHash: lastTxHash,
        triedPaths,
        triedTargets,
      });
      return { txHash: lastTxHash };
    }

    if (sawNotWhitelisted) {
      throw createConflictError(
        `Polymarket relayer 未放行赎回：已试 ${triedTargets.join(', ') || '(none)'}。V2 路径应走 NegRiskCtfCollateralAdapter / CtfCollateralAdapter（或 CTF）。请联系 builder@polymarket.com。`,
        {
          reasonCode: 'POLYMARKET_RELAYER_REDEEM_NOT_WHITELISTED',
          triedTargets,
          triedPaths,
          notWhitelistedErrors,
          negativeRisk,
          collateralKind,
          builderSlotId: slotId,
          triedFallback: true,
          hint: 'Email builder@polymarket.com to whitelist NegRiskCtfCollateralAdapter 0xadA20056… / CtfCollateralAdapter 0xAdA100… for deposit-wallet WALLET batches.',
        }
      );
    }

    throw createConflictError('Polymarket relayer 赎回未提交任何路径', {
      reasonCode: 'POLYMARKET_RELAYER_REDEEM_SUBMIT_FAILED',
      triedPaths,
      negativeRisk,
      collateralKind,
    });
    },
    {
      slotPreference: params.negativeRisk === true ? 'primary_only' : 'backup_first',
      op: params.negativeRisk === true ? 'neg_risk_redeem' : 'standard_redeem',
    }
  );
}

const OFFRAMP_UNWRAP_ABI = [
  {
    type: 'function',
    name: 'unwrap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_asset', type: 'address' },
      { name: '_to', type: 'address' },
      { name: '_amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const ONRAMP_WRAP_ABI = [
  {
    type: 'function',
    name: 'wrap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_asset', type: 'address' },
      { name: '_to', type: 'address' },
      { name: '_amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const ERC1155_ABI = [
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

export function relayerThrownMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(raw) as { data?: { error?: string }; error?: string };
    const inner = parsed?.data?.error ?? parsed?.error;
    if (typeof inner === 'string' && inner.trim()) {
      return inner.trim();
    }
  } catch {
    /* not JSON */
  }
  const dataErrorMatch = raw.match(/"error"\s*:\s*"wallet registry[^"]+"/i);
  if (dataErrorMatch) {
    return dataErrorMatch[0].replace(/^"error"\s*:\s*"/, '').replace(/"$/, '');
  }
  return raw;
}

export function isBenignDepositWalletDeployConflict(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('already') ||
    m.includes('deployed') ||
    m.includes('exists') ||
    m.includes('duplicate')
  );
}

export function isWalletNotRegisteredBatchError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('not registered') || m.includes('wallet registry validation failed');
}

function isRelayerWalletCreateIncompleteError(e: unknown): boolean {
  if (!isAppError(e)) return false;
  const d = e.details as { reasonCode?: string } | undefined;
  return d?.reasonCode === 'POLYMARKET_WALLET_CREATE_INCOMPLETE';
}

/** Relayer 同一 deposit wallet 同时只能有一笔 in-flight batch。 */
export function isRelayerWalletBusyError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('wallet busy') || m.includes('active action exists');
}

/** Builder Relayer 日配额 / Cloudflare 限流（含 quota exceeded: 0 units remaining）。 */
export function isRelayerQuotaExceededError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('quota exceeded') ||
    m.includes('too many requests') ||
    m.includes('"status":429') ||
    m.includes('status":429') ||
    m.includes('error code: 1015')
  );
}

export function parseRelayerQuotaResetMs(msg: string): number | null {
  const match = msg.match(/resets in (\d+) seconds/i);
  if (!match?.[1]) return null;
  const sec = Number.parseInt(match[1], 10);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000;
}

let relayerQuotaCooldownUntilMs = 0;

export function isRelayerQuotaCooldownActive(): boolean {
  return !isAnyBuilderSlotAvailable();
}

export function getRelayerQuotaCooldownRemainingMs(): number {
  return getBuilderQuotaCooldownRemainingMs();
}

export function noteRelayerQuotaCooldownFromMessage(msg: string, slotId = 'primary'): void {
  noteBuilderSlotQuotaCooldown(slotId, msg);
  if (!isAnyBuilderSlotAvailable()) {
    relayerQuotaCooldownUntilMs = Date.now() + getBuilderQuotaCooldownRemainingMs();
  } else {
    relayerQuotaCooldownUntilMs = 0;
  }
}

export function createRelayerQuotaExceededError(sourceMsg?: string) {
  const retryAfterMs = getRelayerQuotaCooldownRemainingMs();
  const retrySec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const message =
    sourceMsg && /日配额|quota exceeded/i.test(sourceMsg)
      ? sourceMsg
      : `Polymarket Builder Relayer 日配额已用尽，约 ${retrySec} 秒后可重试`;
  return createConflictError(message, {
    reasonCode: 'POLYMARKET_RELAYER_QUOTA_EXCEEDED',
    retryAfterMs,
  });
}

/** 所有 Builder slot 均不可用时拒绝。 */
export function assertRelayerQuotaAvailable(): void {
  if (isAnyBuilderSlotAvailable()) return;
  throw createRelayerQuotaExceededError();
}

function throwRelayerSubmitError(e: unknown, submitFailureReasonCode: string, slotId?: string): never {
  const msg = relayerThrownMessage(e);
  if (isRelayerQuotaExceededError(msg)) {
    noteRelayerQuotaCooldownFromMessage(msg, slotId ?? 'primary');
    throw createRelayerQuotaExceededError(msg);
  }
  if (isRelayerWalletBusyError(msg)) {
    throw createConflictError('Polymarket relayer 正在处理该 deposit 钱包的其它交易，请稍后再试', {
      reasonCode: 'POLYMARKET_RELAYER_WALLET_BUSY',
    });
  }
  throw createConflictError(`Polymarket relayer 提交失败: ${msg}`, {
    reasonCode: submitFailureReasonCode,
  });
}

const depositRelayerRegisteredCache = new Set<string>();

function depositRelayerCacheKey(deposit: string): string {
  return deposit.trim().toLowerCase();
}

export function markDepositWalletRelayerRegistered(deposit: string): void {
  depositRelayerRegisteredCache.add(depositRelayerCacheKey(deposit));
}

function isDepositWalletRelayerRegisteredCached(deposit: string): boolean {
  return depositRelayerRegisteredCache.has(depositRelayerCacheKey(deposit));
}

const forcedRedeployCooldownUntilMs = new Map<string, number>();
const FORCED_REDEPLOY_COOLDOWN_MS = 5 * 60 * 1000;
const registryStuckUntilMs = new Map<string, number>();
const REGISTRY_STUCK_COOLDOWN_MS = 30 * 60 * 1000;

function canAttemptForcedRedeploy(deposit: string): boolean {
  return (forcedRedeployCooldownUntilMs.get(depositRelayerCacheKey(deposit)) ?? 0) <= Date.now();
}

function noteForcedRedeployAttempt(deposit: string): void {
  forcedRedeployCooldownUntilMs.set(
    depositRelayerCacheKey(deposit),
    Date.now() + FORCED_REDEPLOY_COOLDOWN_MS,
  );
}

function isDepositRegistryStuck(deposit: string): boolean {
  return (registryStuckUntilMs.get(depositRelayerCacheKey(deposit)) ?? 0) > Date.now();
}

function getDepositRegistryStuckRemainingMs(deposit: string): number {
  return Math.max(0, (registryStuckUntilMs.get(depositRelayerCacheKey(deposit)) ?? 0) - Date.now());
}

function noteDepositRegistryStuck(deposit: string): void {
  registryStuckUntilMs.set(depositRelayerCacheKey(deposit), Date.now() + REGISTRY_STUCK_COOLDOWN_MS);
}

function createDepositRegistryStuckError(deposit: string) {
  return createConflictError('Polymarket deposit 钱包注册状态异常，请稍后再试或联系支持处理。', {
    reasonCode: 'POLYMARKET_DEPOSIT_REGISTRY_STUCK',
    deposit,
    retryAfterMs: getDepositRegistryStuckRemainingMs(deposit),
  });
}

export async function depositWalletHasOnChainCode(deposit: string): Promise<boolean> {
  const code = await publicClient.getBytecode({ address: deposit as `0x${string}` });
  return Boolean(code && code !== '0x');
}

export async function readDepositWalletRelayerDeployed(
  relayClient: RelayClient,
  deposit: string,
): Promise<boolean> {
  try {
    return await relayClient.getDeployed(deposit, 'WALLET');
  } catch {
    return false;
  }
}

/** 文档：链上 bytecode + GET /deployed?type=WALLET 均就绪方可 batch。 */
export async function verifyDepositWalletRelayerReady(
  relayClient: RelayClient,
  deposit: string,
): Promise<{ onchainDeployed: boolean; relayerDeployed: boolean; ready: boolean }> {
  const [onchainDeployed, relayerDeployed] = await Promise.all([
    depositWalletHasOnChainCode(deposit),
    readDepositWalletRelayerDeployed(relayClient, deposit),
  ]);
  return {
    onchainDeployed,
    relayerDeployed,
    ready: onchainDeployed && relayerDeployed,
  };
}

function clearDepositWalletRelayerRegisteredCache(deposit: string): void {
  depositRelayerRegisteredCache.delete(depositRelayerCacheKey(deposit));
}

function isWalletCreateWaitFailureRecoverable(e: unknown): boolean {
  if (!isAppError(e)) return false;
  const d = e.details as { reasonCode?: string } | undefined;
  return (
    d?.reasonCode === 'POLYMARKET_RELAYER_TX_FAILED' || d?.reasonCode === 'POLYMARKET_RELAYER_TX_INVALID'
  );
}

const RELAYER_TX_POLL_MS = 3000;
const RELAYER_TX_MAX_WAIT_MS = 15 * 60 * 1000;

/** Polymarket 文档：WALLET-CREATE / WALLET batch 均以 STATE_CONFIRMED 为终态。 */
const RELAYER_CONFIRMED_STATES = new Set<string>([RelayerTransactionState.STATE_CONFIRMED]);

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitRelayerTxSuccess(
  relayClient: RelayClient,
  transactionID: string,
  timeoutPayload: { reasonCode: string; message: string }
): Promise<{ state: string; transactionHash?: string }> {
  const deadline = Date.now() + RELAYER_TX_MAX_WAIT_MS;
  let lastState: string | undefined;

  while (Date.now() < deadline) {
    const txs = await relayClient.getTransaction(transactionID);
    const txn = txs[0];
    if (txn) {
      lastState = txn.state;
      if (RELAYER_CONFIRMED_STATES.has(txn.state)) {
        return txn;
      }
      if (txn.state === RelayerTransactionState.STATE_FAILED) {
        throw createConflictError('Polymarket relayer 交易失败（STATE_FAILED）', {
          reasonCode: 'POLYMARKET_RELAYER_TX_FAILED',
          transactionID,
          transactionHash: txn.transactionHash,
          relayerMetadata: txn.metadata,
        });
      }
      if (txn.state === RelayerTransactionState.STATE_INVALID) {
        throw createConflictError('Polymarket relayer 交易无效（STATE_INVALID）', {
          reasonCode: 'POLYMARKET_RELAYER_TX_INVALID',
          transactionID,
          relayerMetadata: txn.metadata,
        });
      }
    }
    await sleepMs(RELAYER_TX_POLL_MS);
  }

  throw createConflictError(timeoutPayload.message, {
    reasonCode: timeoutPayload.reasonCode,
    transactionID,
    lastKnownState: lastState,
    hint: '交易可能仍在 relayer 队列中，可稍后重试；也可用 transactionID 向 Polymarket 侧查询。',
  });
}

/**
 * WALLET-CREATE：部署/注册 deposit wallet（与 Polymarket deposit wallet 文档一致）。
 */
export type RelayerWalletCreateState =
  | 'STATE_SUCCEEDED'
  | 'STATE_FAILED'
  | 'STATE_INVALID'
  | 'STATE_TIMEOUT'
  | 'DEPLOY_SUBMIT_REJECTED'
  | 'CACHED'
  | 'UNKNOWN';

export type DepositWalletRelayerRegisterOutcome = {
  /**
   * true：WALLET-CREATE 已 STATE_CONFIRMED，且链上 bytecode + GET /deployed?type=WALLET 均为 true。
   */
  relayerEndStateConfirmed: boolean;
  onchainDeployed: boolean;
  relayerWalletCreateState: RelayerWalletCreateState;
};

function mapRelayerState(state: string | undefined): RelayerWalletCreateState {
  if (!state) return 'UNKNOWN';
  if (state === RelayerTransactionState.STATE_CONFIRMED) return 'STATE_SUCCEEDED';
  if (state === RelayerTransactionState.STATE_FAILED) return 'STATE_FAILED';
  if (state === RelayerTransactionState.STATE_INVALID) return 'STATE_INVALID';
  return 'UNKNOWN';
}

/** 若 DB 已有 WALLET-CREATE transactionID，先 poll 至 STATE_CONFIRMED，避免重复 submit 触发 already deployed。 */
async function awaitPendingWalletCreateRelayerTxIfAny(
  relayClient: RelayClient,
  deposit: string,
  opts?: { slotId?: string; blockUntilConfirmed?: boolean },
): Promise<DepositWalletRelayerRegisterOutcome | null> {
  const pendingTxId = await loadPolymarketWalletCreateRelayerTxId(deposit);
  if (!pendingTxId) {
    return null;
  }
  console.info('[polymarket-relayer-provision] WALLET-CREATE resuming pending relayer tx', {
    deposit,
    slotId: opts?.slotId ?? 'primary',
    relayerTransactionId: pendingTxId,
  });
  try {
    let txn: { state: string; transactionHash?: string } | undefined;
    if (opts?.blockUntilConfirmed) {
      txn = await waitRelayerTxSuccess(relayClient, pendingTxId, {
        reasonCode: 'POLYMARKET_RELAYER_DEPLOY_TIMEOUT',
        message: 'Polymarket deposit wallet（WALLET-CREATE）确认超时',
      });
    } else {
      const txs = await relayClient.getTransaction(pendingTxId);
      txn = txs[0];
      if (!txn) {
        return null;
      }
      if (RELAYER_CONFIRMED_STATES.has(txn.state)) {
        // proceed
      } else if (
        txn.state === RelayerTransactionState.STATE_FAILED ||
        txn.state === RelayerTransactionState.STATE_INVALID
      ) {
        return null;
      } else {
        return null;
      }
    }
    const verify = await verifyDepositWalletRelayerReady(relayClient, deposit);
    if (verify.ready) {
      markDepositWalletRelayerRegistered(deposit);
    }
    console.info('[polymarket-relayer-provision] WALLET-CREATE pending tx outcome', {
      deposit,
      relayerTransactionId: pendingTxId,
      relayerState: txn?.state ?? null,
      onchainDeployed: verify.onchainDeployed,
      relayerDeployed: verify.relayerDeployed,
      ready: verify.ready,
    });
    return {
      relayerEndStateConfirmed: verify.ready,
      onchainDeployed: verify.onchainDeployed,
      relayerWalletCreateState: verify.ready ? mapRelayerState(txn?.state) : 'DEPLOY_SUBMIT_REJECTED',
    };
  } catch (e) {
    console.warn('[polymarket-relayer-provision] WALLET-CREATE pending tx wait failed', {
      deposit,
      relayerTransactionId: pendingTxId,
      error: relayerThrownMessage(e),
    });
    return null;
  }
}

/** 链上已有 deposit 合约但 relayer registry 未完成时，补一次 force WALLET-CREATE。 */
export async function ensureDepositWalletRelayerRegisteredWithRecovery(
  relayClient: RelayClient,
  deposit: string,
  opts?: { slotId?: string },
): Promise<DepositWalletRelayerRegisterOutcome> {
  let outcome = await ensurePolymarketDepositWalletRegisteredWithRelayer(relayClient, deposit, opts);
  if (!outcome.relayerEndStateConfirmed && !outcome.onchainDeployed) {
    let relayerDeployed = false;
    try {
      relayerDeployed = await relayClient.getDeployed(deposit, 'WALLET');
    } catch (e) {
      console.warn('[polymarket-relayer-provision] getDeployed query failed', {
        deposit,
        slotId: opts?.slotId ?? 'primary',
        error: relayerThrownMessage(e),
      });
    }
    if (relayerDeployed) {
      console.error('[polymarket-relayer-provision] relayer-chain DESYNC: relayer deployed=true, on-chain bytecode=false', {
        deposit,
        slotId: opts?.slotId ?? 'primary',
        relayerWalletCreateState: outcome.relayerWalletCreateState,
        hint:
          'Relayer 拒绝 WALLET-CREATE（already deployed）但链上无合约；USDC 可转入 counterfactual 地址但无法 wrap。需 Polymarket 侧修复 registry 或换 Builder key 重试 deploy。',
      });
    } else {
      console.error('[polymarket-relayer-provision] WALLET-CREATE unconfirmed and not on-chain; retry force deploy', {
        deposit,
        slotId: opts?.slotId ?? 'primary',
        relayerDeployed,
        relayerWalletCreateState: outcome.relayerWalletCreateState,
        hint: 'GET /deployed=false 但 submit 仍可能 already deployed；尝试 force WALLET-CREATE',
      });
      outcome = await ensurePolymarketDepositWalletRegisteredWithRelayer(relayClient, deposit, {
        ...opts,
        forceRedeploy: true,
      });
    }
  }
  if (!outcome.relayerEndStateConfirmed && outcome.onchainDeployed) {
    console.warn('[polymarket-relayer-provision] WALLET-CREATE unconfirmed with on-chain code; force redeploy', {
      deposit,
      slotId: opts?.slotId ?? 'primary',
      relayerWalletCreateState: outcome.relayerWalletCreateState,
    });
    outcome = await ensurePolymarketDepositWalletRegisteredWithRelayer(relayClient, deposit, {
      ...opts,
      forceRedeploy: true,
    });
  }
  return outcome;
}

export async function ensurePolymarketDepositWalletRegisteredWithRelayer(
  relayClient: RelayClient,
  deposit: string,
  opts?: { slotId?: string; forceRedeploy?: boolean },
): Promise<DepositWalletRelayerRegisterOutcome> {
  const dep = deposit.trim();
  if (isDepositRegistryStuck(dep)) {
    const retryAfterMs = getDepositRegistryStuckRemainingMs(dep);
    console.warn('[polymarket-relayer-provision] WALLET-CREATE blocked: registry_stuck', {
      deposit: dep,
      slotId: opts?.slotId ?? 'primary',
      retryAfterMs,
      hint: 'pm2 restart backend 可立即清除进程内熔断；根因多为连续 not registered 补注册失败',
    });
    throw createDepositRegistryStuckError(dep);
  }
  const slotId = opts?.slotId ?? 'primary';
  const forceRedeployRequested = opts?.forceRedeploy === true;
  const forceRedeploy = forceRedeployRequested && canAttemptForcedRedeploy(dep);
  const onchainDeployedEarly = await depositWalletHasOnChainCode(dep);

  if (!forceRedeploy && isDepositWalletRelayerRegisteredCached(dep)) {
    const cachedVerify = await verifyDepositWalletRelayerReady(relayClient, dep);
    if (cachedVerify.ready) {
      console.info('[polymarket-relayer-provision] WALLET-CREATE skipped (relayer registered cache)', {
        deposit: dep,
        slotId: opts?.slotId ?? 'primary',
      });
      return {
        relayerEndStateConfirmed: true,
        onchainDeployed: true,
        relayerWalletCreateState: 'CACHED',
      };
    }
    clearDepositWalletRelayerRegisteredCache(dep);
  }

  if (!forceRedeploy) {
    const resumed = await awaitPendingWalletCreateRelayerTxIfAny(relayClient, dep, {
      slotId,
      blockUntilConfirmed: true,
    });
    if (resumed?.relayerEndStateConfirmed) {
      return resumed;
    }
  }

  console.info('[polymarket-relayer-provision] WALLET-CREATE submit', {
    deposit: dep,
    slotId: opts?.slotId ?? 'primary',
    forceRedeploy,
    onchainDeployedEarly,
  });

  let txResp;
  try {
    if (forceRedeploy) {
      noteForcedRedeployAttempt(dep);
      console.warn('[polymarket-relayer] forcing WALLET-CREATE redeploy for registry recovery', {
        deposit: dep,
        slotId,
      });
    } else if (forceRedeployRequested) {
      console.warn('[polymarket-relayer] forced WALLET-CREATE redeploy throttled', {
        deposit: dep,
        slotId,
        cooldownMs: FORCED_REDEPLOY_COOLDOWN_MS,
      });
    }
    txResp = await relayClient.deployDepositWallet();
    await persistPolymarketWalletCreateRelayerTxId({
      depositAddress: dep,
      relayerTransactionId: txResp.transactionID,
    });
  } catch (e) {
    const msg = relayerThrownMessage(e);
    console.warn('[polymarket-relayer-provision] WALLET-CREATE deployDepositWallet error', {
      deposit: dep,
      slotId,
      forceRedeploy,
      forceRedeployRequested,
      onchainDeployedEarly,
      rawMessage: msg,
    });
    if (isRelayerQuotaExceededError(msg)) {
      noteRelayerQuotaCooldownFromMessage(msg, slotId);
      throw createRelayerQuotaExceededError(msg);
    }
    if (isBenignDepositWalletDeployConflict(msg)) {
      const resumed = await awaitPendingWalletCreateRelayerTxIfAny(relayClient, dep, {
        slotId,
        blockUntilConfirmed: true,
      });
      if (resumed?.relayerEndStateConfirmed) {
        return resumed;
      }
      const verify = await verifyDepositWalletRelayerReady(relayClient, dep);
      const relayerWalletCreateState: RelayerWalletCreateState = verify.ready
        ? 'STATE_SUCCEEDED'
        : 'DEPLOY_SUBMIT_REJECTED';
      console.warn('[polymarket-relayer] WALLET-CREATE benign conflict; deposit may still be unregistered', {
        deposit: dep,
        onchainDeployed: verify.onchainDeployed,
        relayerDeployed: verify.relayerDeployed,
        relayerChainDesync: verify.relayerDeployed && !verify.onchainDeployed,
        forceRedeployRequested,
        relayerWalletCreateState,
        hint: verify.ready
          ? 'already deployed 且链上/registry 均已确认'
          : 'already deployed 但链上或 GET /deployed 未就绪；勿继续发 batch',
      });
      if (verify.ready) {
        markDepositWalletRelayerRegistered(dep);
      }
      return {
        relayerEndStateConfirmed: verify.ready,
        onchainDeployed: verify.onchainDeployed,
        relayerWalletCreateState,
      };
    }
    if (onchainDeployedEarly || (await depositWalletHasOnChainCode(dep))) {
      const verify = await verifyDepositWalletRelayerReady(relayClient, dep);
      console.warn(
        '[polymarket-relayer] WALLET-CREATE submit rejected but deposit has on-chain code; registry may still be incomplete',
        {
          deposit: dep,
          forceRedeployRequested,
          onchainDeployed: verify.onchainDeployed,
          relayerDeployed: verify.relayerDeployed,
          relayerWalletCreateState: verify.ready ? 'STATE_SUCCEEDED' : 'DEPLOY_SUBMIT_REJECTED',
        },
      );
      if (verify.ready) {
        markDepositWalletRelayerRegistered(dep);
      }
      return {
        relayerEndStateConfirmed: verify.ready,
        onchainDeployed: verify.onchainDeployed,
        relayerWalletCreateState: verify.ready ? 'STATE_SUCCEEDED' : 'DEPLOY_SUBMIT_REJECTED',
      };
    }
    throw createConflictError(`Polymarket deposit wallet（WALLET-CREATE）提交失败: ${msg}`, {
      reasonCode: 'POLYMARKET_RELAYER_DEPLOY_FAILED',
    });
  }
  try {
    console.info('[polymarket-relayer-provision] WALLET-CREATE waiting relayer tx', {
      deposit: dep,
      slotId: opts?.slotId ?? 'primary',
      relayerTransactionId: txResp.transactionID,
    });
    const txn = await waitRelayerTxSuccess(relayClient, txResp.transactionID, {
      reasonCode: 'POLYMARKET_RELAYER_DEPLOY_TIMEOUT',
      message: 'Polymarket deposit wallet（WALLET-CREATE）确认超时',
    });
    const verify = await verifyDepositWalletRelayerReady(relayClient, dep);
    if (verify.ready) {
      markDepositWalletRelayerRegistered(dep);
    }
    console.info('[polymarket-relayer-provision] WALLET-CREATE relayer confirmed', {
      deposit: dep,
      slotId: opts?.slotId ?? 'primary',
      relayerState: txn.state,
      onchainDeployed: verify.onchainDeployed,
      relayerDeployed: verify.relayerDeployed,
      transactionHash: txn.transactionHash ?? txResp.transactionHash ?? null,
    });
    return {
      relayerEndStateConfirmed: verify.ready,
      onchainDeployed: verify.onchainDeployed,
      relayerWalletCreateState: verify.ready ? mapRelayerState(txn.state) : 'DEPLOY_SUBMIT_REJECTED',
    };
  } catch (e) {
    const verify = await verifyDepositWalletRelayerReady(relayClient, dep);
    if (isWalletCreateWaitFailureRecoverable(e) && verify.ready) {
      markDepositWalletRelayerRegistered(dep);
      return {
        relayerEndStateConfirmed: true,
        onchainDeployed: verify.onchainDeployed,
        relayerWalletCreateState: mapRelayerState(
          isAppError(e) && (e.details as { reasonCode?: string } | undefined)?.reasonCode ===
            'POLYMARKET_RELAYER_TX_INVALID'
            ? RelayerTransactionState.STATE_INVALID
            : RelayerTransactionState.STATE_FAILED,
        ),
      };
    }
    if (isWalletCreateWaitFailureRecoverable(e) && verify.onchainDeployed) {
      const st: RelayerWalletCreateState =
        isAppError(e) && (e.details as { reasonCode?: string } | undefined)?.reasonCode ===
        'POLYMARKET_RELAYER_TX_INVALID'
          ? 'STATE_INVALID'
          : 'STATE_FAILED';
      console.warn(
        '[polymarket-relayer] WALLET-CREATE relayer STATE_FAILED/INVALID; chain has code but registry not ready',
        {
          deposit: dep,
          onchainDeployed: verify.onchainDeployed,
          relayerDeployed: verify.relayerDeployed,
          relayerWalletCreateState: st,
          details: isAppError(e) ? e.details : undefined,
        },
      );
      return {
        relayerEndStateConfirmed: false,
        onchainDeployed: verify.onchainDeployed,
        relayerWalletCreateState: st,
      };
    }
    throw e;
  }
}

export function isPolymarketRelayerBuilderConfigured(): boolean {
  return (
    Boolean(CONFIG.polymarketRelayerUrl?.trim()) &&
    Boolean(CONFIG.polymarketBuilderApiKey) &&
    Boolean(CONFIG.polymarketBuilderSecret) &&
    Boolean(CONFIG.polymarketBuilderPassphrase)
  );
}

export function createBuilderConfigOrThrow(): BuilderConfig {
  const slot =
    listBuilderCredentialSlots().find((s) => s.id === 'primary') ?? listBuilderCredentialSlots()[0];
  if (!slot) {
    throw createConflictError('Polymarket Builder 凭证未配置');
  }
  return createBuilderConfigForSlot(slot);
}

export type DepositRelayerClientContext = {
  relayClient: RelayClient;
  builderConfig: BuilderConfig;
  slotId: string;
};

async function buildDepositRelayClientForSlot(
  userId: number,
  custodialAddress: string,
  slot: BuilderCredentialSlot,
  options?: {
    withdrawalAuthorization?: GoWithdrawalAuthorization;
  },
): Promise<DepositRelayerClientContext> {
  const execution = await getCustodialExecutionWallet(userId, custodialAddress, options);
  const builderConfig = createBuilderConfigForSlot(slot);
  const relayClient = new RelayClient(
    CONFIG.polymarketRelayerUrl,
    CONFIG.chainId || 137,
    execution.walletClient as any,
    builderConfig,
  );
  return { relayClient, builderConfig, slotId: slot.id };
}

/**
 * 按 slotPreference 选用 Builder 凭证；主/备配额用尽时在候选池内 failover。
 * NegRisk 赎回应传 primary_only（不会切到备用号）。
 */
export async function runWithDepositRelayerFailover<TResult>(
  userId: number,
  custodialAddress: string,
  fn: (ctx: DepositRelayerClientContext) => Promise<TResult>,
  options?: {
    withdrawalAuthorization?: GoWithdrawalAuthorization;
    slotPreference?: BuilderSlotPreference;
    /** 日志用操作名：neg_risk_redeem / provision / withdraw 等 */
    op?: string;
  },
): Promise<TResult> {
  const slotPreference: BuilderSlotPreference = options?.slotPreference ?? 'backup_first';
  const op = options?.op ?? 'deposit_relayer';
  const selection = getBuilderCredentialSlotsForPreference(slotPreference);
  const slots = selection.slots;
  if (!slots.length) {
    if (slotPreference === 'primary_only') {
      console.warn('[polymarket-builder-slot] primary exhausted', {
        op,
        userId,
        pool: 'primary',
        slotPreference,
        reason: 'primary_quota_exhausted_no_failover',
        skippedCooldownSlotIds: selection.skippedCooldownSlotIds,
      });
    }
    throw createRelayerQuotaExceededError();
  }

  const firstPool = builderSlotPool(slots[0]!.id);
  console.info('[polymarket-builder-slot] select', {
    op,
    userId,
    slotPreference,
    pool: firstPool,
    candidateSlotIds: slots.map((s) => s.id),
    fallbackToPrimary: selection.fallbackToPrimary,
    skippedCooldownSlotIds: selection.skippedCooldownSlotIds,
  });

  let lastQuotaErr: unknown;
  let lastWalletCreateErr: unknown;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const pool = builderSlotPool(slot.id);
    console.info('[polymarket-builder-slot] attempt', {
      op,
      userId,
      pool,
      slotId: slot.id,
      slotLabel: slot.label,
      keyPrefix: slot.key.slice(0, 8),
      attempt: i + 1,
      candidatesTotal: slots.length,
      slotPreference,
      fallbackToPrimary: selection.fallbackToPrimary,
    });
    const ctx = await buildDepositRelayClientForSlot(userId, custodialAddress, slot, options);
    try {
      const result = await fn(ctx);
      console.info('[polymarket-builder-slot] success', {
        op,
        userId,
        pool,
        slotId: slot.id,
        slotPreference,
        fallbackToPrimary: selection.fallbackToPrimary,
      });
      return result;
    } catch (e) {
      const msg = relayerThrownMessage(e);
      if (isRelayerQuotaExceededError(msg)) {
        noteRelayerQuotaCooldownFromMessage(msg, slot.id);
        const next = slots[i + 1];
        console.warn('[polymarket-builder-slot] quota exceeded, trying next', {
          op,
          userId,
          fromSlotId: slot.id,
          fromPool: pool,
          nextSlotId: next?.id ?? null,
          nextPool: next ? builderSlotPool(next.id) : null,
          slotPreference,
        });
        if (!next && slotPreference === 'primary_only') {
          console.warn('[polymarket-builder-slot] primary exhausted', {
            op,
            userId,
            pool: 'primary',
            slotPreference,
            reason: 'primary_quota_exhausted_no_failover',
          });
        }
        lastQuotaErr = e;
        continue;
      }
      if (isRelayerWalletCreateIncompleteError(e)) {
        console.warn('[polymarket-relayer] builder slot WALLET-CREATE incomplete, trying next', {
          op,
          slotId: slot.id,
          slotLabel: slot.label,
          pool,
          slotPreference,
          error: msg,
        });
        lastWalletCreateErr = e;
        continue;
      }
      throw e;
    }
  }
  if (lastWalletCreateErr) {
    throw lastWalletCreateErr;
  }
  throw createRelayerQuotaExceededError(relayerThrownMessage(lastQuotaErr));
}

/**
 * RelayClient for the user's custodial owner + Builder HMAC（与 withdraw 批次一致）。
 */
export async function createDepositRelayClientForCustodialUser(
  userId: number,
  custodialAddress: string,
  options?: { slotPreference?: BuilderSlotPreference; op?: string },
): Promise<DepositRelayerClientContext> {
  const slotPreference: BuilderSlotPreference = options?.slotPreference ?? 'backup_first';
  const op = options?.op ?? 'deposit_relayer';
  const selection = getBuilderCredentialSlotsForPreference(slotPreference);
  const slots = selection.slots;
  if (!slots.length) {
    if (slotPreference === 'primary_only') {
      console.warn('[polymarket-builder-slot] primary exhausted', {
        op,
        userId,
        pool: 'primary',
        slotPreference,
        reason: 'primary_quota_exhausted_no_failover',
      });
    }
    throw createRelayerQuotaExceededError();
  }
  const slot = slots[0]!;
  console.info('[polymarket-builder-slot] select', {
    op,
    userId,
    slotPreference,
    pool: builderSlotPool(slot.id),
    candidateSlotIds: slots.map((s) => s.id),
    fallbackToPrimary: selection.fallbackToPrimary,
    skippedCooldownSlotIds: selection.skippedCooldownSlotIds,
  });
  return buildDepositRelayClientForSlot(userId, custodialAddress, slot);
}

export async function assertRelayDerivedDepositMatches(
  relayClient: RelayClient,
  storedDeposit: string,
  ownerAddress?: string,
): Promise<void> {
  const stored = storedDeposit.toLowerCase();
  if (ownerAddress) {
    const resolved = ethers.utils.getAddress(
      await resolvePolymarketDepositWalletAddress(ownerAddress, CONFIG.chainId),
    );
    if (resolved.toLowerCase() === stored) {
      return;
    }
  }
  const derived = ethers.utils.getAddress(await relayClient.deriveDepositWalletAddress());
  if (derived.toLowerCase() === stored) {
    return;
  }
  throw createConflictError('Polymarket deposit 地址与推导不一致，请检查链 ID 与钱包', {
    expectedFromRelayerDerive: derived,
    expectedFromResolve: ownerAddress
      ? await resolvePolymarketDepositWalletAddress(ownerAddress, CONFIG.chainId).catch(() => null)
      : null,
    storedDeposit,
  });
}

const MIN_MEANINGFUL_ALLOWANCE = 1_000_000n * 1_000_000n; // 1e12 wei units — treat as "unlimited enough" for trading

/** pUSD 对 CLOB spenders 的 approve + CTF operators（relayer batch 用） */
export async function collectDepositPusdCtfRelayerCalls(deposit: Address): Promise<
  Array<{ target: string; value: string; data: `0x${string}` }>
> {
  const calls: Array<{ target: string; value: string; data: `0x${string}` }> = [];
  const owner = getAddress(deposit);

  for (const spenderRaw of getAllPolymarketCollateralSpenders()) {
    const spender = getAddress(spenderRaw as `0x${string}`);
    const allowance = await publicClient.readContract({
      address: PUSD_TOKEN,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
    if (allowance >= MIN_MEANINGFUL_ALLOWANCE) {
      continue;
    }
    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [spender, maxUint256],
    });
    calls.push({ target: PUSD_TOKEN, value: '0', data });
  }

  for (const operatorRaw of getAllPolymarketConditionalOperators()) {
    const operator = getAddress(operatorRaw as `0x${string}`);
    const approved = await publicClient.readContract({
      address: CTF_CONTRACT,
      abi: ERC1155_ABI,
      functionName: 'isApprovedForAll',
      args: [owner, operator],
    });
    if (approved) {
      continue;
    }
    const data = encodeFunctionData({
      abi: ERC1155_ABI,
      functionName: 'setApprovalForAll',
      args: [operator, true],
    });
    calls.push({ target: CTF_CONTRACT, value: '0', data });
  }

  return calls;
}

export type EnsureDepositTradingApprovalsResult = {
  ran: boolean;
  transactionHash?: string;
  callCount: number;
  /** false：WALLET-CREATE 未在 relayer 侧确认成功，仅链上已有合约；日志须保留 */
  depositWalletRelayerConfirmed?: boolean;
  onchainDeployed?: boolean;
  relayerWalletCreateState?: RelayerWalletCreateState;
};

/**
 * 通过 relayer 在 deposit wallet 上执行 pUSD approve（CLOB V2 BUY collateral）+ CTF setApprovalForAll（链上幂等）。
 */
export async function ensurePolymarketDepositTradingApprovalsViaRelayer(params: {
  userId: number;
  custodialAddress: string;
  depositAddress: string;
}): Promise<EnsureDepositTradingApprovalsResult> {
  if (!isPolymarketRelayerBuilderConfigured()) {
    return { ran: false, callCount: 0 };
  }

  const custodial = ethers.utils.getAddress(params.custodialAddress);
  const deposit = ethers.utils.getAddress(params.depositAddress) as Address;

  if (deposit.toLowerCase() === custodial.toLowerCase()) {
    return { ran: false, callCount: 0 };
  }

  if (isSellApprovalsPrepCached(deposit, CONFIG.polyDepositSellPrepCacheMs)) {
    console.info('[polymarket-relayer-provision] approval batch skipped (sell prep cache)', {
      userId: params.userId,
      deposit,
    });
    return {
      ran: false,
      callCount: 0,
      onchainDeployed: true,
      relayerWalletCreateState: 'CACHED',
    };
  }

  console.info('[polymarket-relayer-provision] start', {
    userId: params.userId,
    custodial,
    deposit,
  });

  return runWithDepositRelayerFailover(params.userId, custodial, async ({ relayClient, slotId }) => {
    console.info('[polymarket-relayer-provision] relay slot', { userId: params.userId, deposit, slotId });
    await assertRelayDerivedDepositMatches(relayClient, deposit, custodial);
    console.info('[polymarket-relayer-provision] derive address ok', { userId: params.userId, deposit, slotId });
    const registerOutcome = await ensureDepositWalletRelayerRegisteredWithRecovery(relayClient, deposit, {
      slotId,
    });
    console.info('[polymarket-relayer-provision] WALLET-CREATE outcome', {
      userId: params.userId,
      deposit,
      slotId,
      ...registerOutcome,
    });

    const onchainAfterRegister =
      registerOutcome.onchainDeployed || (await depositWalletHasOnChainCode(deposit));
    if (!registerOutcome.relayerEndStateConfirmed) {
      throw createConflictError(
        'Polymarket deposit WALLET-CREATE 未完成（需 STATE_CONFIRMED 且链上合约 + Relayer registry 就绪），已跳过授权批次',
        {
          reasonCode: 'POLYMARKET_WALLET_CREATE_INCOMPLETE',
          deposit,
          slotId,
          onchainDeployed: onchainAfterRegister,
          relayerWalletCreateState: registerOutcome.relayerWalletCreateState,
          hint: '文档：poll 至 STATE_CONFIRMED，且 GET /deployed?type=WALLET 与链上 bytecode 均为 true 后再 batch。',
        },
      );
    }

    const calls = await collectDepositPusdCtfRelayerCalls(deposit);
    if (!calls.length) {
      const spenders = getAllPolymarketCollateralSpenders();
      const allowanceBySpender: Record<string, string> = {};
      for (const s of spenders) {
        try {
          const a = await publicClient.readContract({
            address: PUSD_TOKEN,
            abi: ERC20_ALLOWANCE_ABI,
            functionName: 'allowance',
            args: [getAddress(deposit), getAddress(s as `0x${string}`)],
          });
          allowanceBySpender[s] = a.toString();
        } catch {
          allowanceBySpender[s] = 'read_failed';
        }
      }
      console.warn('[polymarket-relayer] deposit approval batch skipped (no pending calls)', {
        deposit,
        chainId: CONFIG.chainId,
        collateralToken: PUSD_TOKEN,
        spenderCount: spenders.length,
        pUsdAllowanceBySpender: allowanceBySpender,
        onchainDeployed: registerOutcome.onchainDeployed,
        relayerWalletCreateState: registerOutcome.relayerWalletCreateState,
        hint:
          '若 spenderCount<3 或缺少 0xE111…，说明运行中的后端未包含 polymarketContractSpenders 的 canonical 合并；请重新 build 并部署。若链上 allowance 已极大但 CLOB 仍为 0，则非本批授权问题，需看 CLOB/凭证。',
      });
      markSellApprovalsPrepCached(deposit);
      return {
        ran: false,
        callCount: 0,
        depositWalletRelayerConfirmed: registerOutcome.relayerEndStateConfirmed,
        onchainDeployed: registerOutcome.onchainDeployed,
        relayerWalletCreateState: registerOutcome.relayerWalletCreateState,
      };
    }

    const deadline = Math.floor(Date.now() / 1000 + 600).toString();

    let relayerConfirmed = registerOutcome.relayerEndStateConfirmed;
    let walletCreateMeta = registerOutcome;
    let txResp;
    try {
      console.info('[polymarket-relayer-provision] approval batch submit', {
        userId: params.userId,
        deposit,
        slotId,
        callCount: calls.length,
      });
      txResp = await relayClient.executeDepositWalletBatch(calls, deposit, deadline);
    } catch (e) {
      const msg = relayerThrownMessage(e);
      if (isWalletNotRegisteredBatchError(msg)) {
        console.warn('[polymarket-relayer-provision] approval batch not registered, retry WALLET-CREATE', {
          userId: params.userId,
          deposit,
          slotId,
          error: msg,
        });
        const reg2 = await ensureDepositWalletRelayerRegisteredWithRecovery(relayClient, deposit, { slotId });
        relayerConfirmed = relayerConfirmed || reg2.relayerEndStateConfirmed;
        walletCreateMeta = reg2;
        txResp = await relayClient.executeDepositWalletBatch(calls, deposit, deadline);
      } else if (isRelayerQuotaExceededError(msg)) {
        noteRelayerQuotaCooldownFromMessage(msg, slotId);
        throw createRelayerQuotaExceededError(msg);
      } else {
        throw createConflictError(`Polymarket relayer 授权批次提交失败: ${msg}`, {
          reasonCode: 'POLYMARKET_RELAYER_APPROVAL_BATCH_FAILED',
        });
      }
    }

    const result = await waitRelayerTxSuccess(relayClient, txResp.transactionID, {
      reasonCode: 'POLYMARKET_RELAYER_APPROVAL_TIMEOUT',
      message: 'Polymarket relayer 授权批次确认超时',
    });

    const transactionHash = result.transactionHash || txResp.transactionHash || '';
    markSellApprovalsPrepCached(deposit);
    invalidatePusdClobSyncCache(deposit);
    return {
      ran: true,
      transactionHash: transactionHash.startsWith('0x') ? transactionHash : undefined,
      callCount: calls.length,
      depositWalletRelayerConfirmed: relayerConfirmed,
      onchainDeployed: walletCreateMeta.onchainDeployed,
      relayerWalletCreateState: walletCreateMeta.relayerWalletCreateState,
    };
  }, { slotPreference: 'backup_first', op: 'provision' });
}

/** USDC.e → CollateralOnramp 的 approve（wrap 前须授权 Onramp 扣款） */
export async function collectUsdceApproveOnrampCallIfNeeded(deposit: Address): Promise<
  Array<{ target: string; value: string; data: `0x${string}` }>
> {
  const owner = getAddress(deposit);
  const onramp = getAddress(COLLATERAL_ONRAMP_ADDRESS);
  const allowance = await publicClient.readContract({
    address: USDC_E_ADDRESS,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [owner, onramp],
  });
  if (allowance >= MIN_MEANINGFUL_ALLOWANCE) {
    return [];
  }
  const data = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [onramp, maxUint256],
  });
  return [{ target: USDC_E_ADDRESS, value: '0', data }];
}

export function encodeOfframpUnwrapPusdToUsdceOnDepositCall(deposit: Address, unwrapPusdWei: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: OFFRAMP_UNWRAP_ABI,
    functionName: 'unwrap',
    args: [getAddress(USDC_E_ADDRESS), getAddress(deposit), unwrapPusdWei],
  });
}

/** pUSD → CollateralOfframp 的 approve（unwrap 前须授权 Offramp 销毁 pUSD） */
export async function collectPusdApproveOfframpCallIfNeeded(deposit: Address): Promise<
  Array<{ target: string; value: string; data: `0x${string}` }>
> {
  const owner = getAddress(deposit);
  const offramp = getAddress(COLLATERAL_OFFRAMP_ADDRESS);
  const allowance = await publicClient.readContract({
    address: PUSD_TOKEN,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [owner, offramp],
  });
  if (allowance >= MIN_MEANINGFUL_ALLOWANCE) {
    return [];
  }
  const data = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [offramp, maxUint256],
  });
  return [{ target: PUSD_TOKEN, value: '0', data }];
}

/**
 * 若链上 USDC.e 低于 `minUsdceWeiRequired`，则生成 approve(offramp)+unwrap(pUSD→USDC.e) 前缀调用（与后续 USDC.e transfer 同批执行）。
 */
export async function buildUnwrapPusdPrefixCallsIfUsdceShort(
  deposit: Address,
  minUsdceWeiRequired: bigint
): Promise<Array<{ target: string; value: string; data: `0x${string}` }>> {
  if (minUsdceWeiRequired <= 0n) {
    return [];
  }
  const dep = getAddress(deposit);
  const usdce = (await getUsdcBalance(dep)).raw;
  if (usdce >= minUsdceWeiRequired) {
    return [];
  }
  const shortfall = minUsdceWeiRequired - usdce;
  const pusd = (await getPusdBalance(dep)).raw;
  if (pusd < shortfall) {
    throw createConflictError(
      '链上 USDC.e 不足且 pUSD 不足以 unwrap：提现 / 付款需先将部分 pUSD 经 Collateral Offramp 换回 USDC.e。',
      {
        reasonCode: 'INSUFFICIENT_USDCE_UNWRAP',
        usdceOnDeposit: usdce.toString(),
        pusdOnDeposit: pusd.toString(),
        minUsdceWeiRequired: minUsdceWeiRequired.toString(),
        shortfall: shortfall.toString(),
      }
    );
  }
  const prefix = await collectPusdApproveOfframpCallIfNeeded(dep);
  prefix.push({
    target: COLLATERAL_OFFRAMP_ADDRESS,
    value: '0',
    data: encodeOfframpUnwrapPusdToUsdceOnDepositCall(dep, shortfall),
  });
  return prefix;
}

export function encodeOnrampWrapUsdceToDepositCall(deposit: Address, wrapWei: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: ONRAMP_WRAP_ABI,
    functionName: 'wrap',
    args: [getAddress(USDC_E_ADDRESS), getAddress(deposit), wrapWei],
  });
}
