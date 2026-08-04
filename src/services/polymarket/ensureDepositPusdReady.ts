/**
 * Polymarket CLOB V2：deposit wallet 侧 pUSD 抵押准备（wrap + pUSD approve + CLOB updateBalanceAllowance）。
 * updateBalanceAllowance 使用 CLOB L2 鉴权（client 已绑定 ApiKeyCreds）；`signature_type` 由 SDK 从 `orderBuilder.signatureType` 注入（POLY_1271 = 3）。
 */
import { AssetType, type ClobClient } from '@polymarket/clob-client-v2';
import { ethers } from 'ethers';
import { getAddress, parseUnits, type Address } from 'viem';
import { CONFIG } from '../../config/env';
import { createConflictError } from '../../utils/appError';
import {
  invalidatePusdClobSyncCache,
  isPusdClobSyncCached,
  markPusdClobSyncCached,
} from './polymarketDepositPrepCache';
import {
  assertRelayDerivedDepositMatches,
  collectDepositPusdCtfRelayerCalls,
  collectUsdceApproveOnrampCallIfNeeded,
  encodeOnrampWrapUsdceToDepositCall,
  ensurePolymarketDepositWalletRegisteredWithRelayer,
  executeDepositWalletBatchWithRetry,
  isPolymarketRelayerBuilderConfigured,
  runWithDepositRelayerFailover,
  waitRelayerTxSuccess,
} from './polymarketRelayerDeposit';
import { getAllPolymarketCollateralSpenders } from './polymarketContractSpenders';
import { parseClobCollateralBalanceToWei6 } from './polymarketClob';
import { tryAutoWrapPolymarketDepositUsdce } from './polymarketDepositAutoWrap';
import {
  COLLATERAL_ONRAMP_ADDRESS,
  getNativeUsdcBalance,
  getPusdBalance,
  getUsdcBalance,
  publicClient,
  PUSD_TOKEN,
  USDC_E_TOKEN,
} from './web3';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clobAllowanceBalanceToRawString(ba: unknown): string {
  if (!ba || typeof ba !== 'object') return '';
  const b = (ba as { balance?: unknown }).balance;
  if (b == null) return '';
  if (typeof b === 'string') return b;
  if (typeof b === 'number') return Number.isFinite(b) ? String(b) : '';
  return String(b);
}

async function readPusdAllowanceBySpender(deposit: Address): Promise<Record<string, string>> {
  const spenders = getAllPolymarketCollateralSpenders();
  const out: Record<string, string> = {};
  for (const s of spenders) {
    try {
      const a = await publicClient.readContract({
        address: PUSD_TOKEN,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: 'allowance',
        args: [getAddress(deposit), getAddress(s as `0x${string}`)],
      });
      out[s] = a.toString();
    } catch {
      out[s] = 'read_failed';
    }
  }
  return out;
}

async function readClobCollateralBalanceWei6(client: ClobClient): Promise<bigint> {
  const c = client as unknown as {
    getBalanceAllowance?: (p: { asset_type: AssetType }) => Promise<unknown>;
  };
  if (typeof c.getBalanceAllowance !== 'function') {
    return 0n;
  }
  const ba = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return parseClobCollateralBalanceToWei6(clobAllowanceBalanceToRawString(ba));
}

export type EnsureDepositPusdReadyParams = {
  userId: number;
  walletId: number;
  executionAddress: string;
  depositAddress: string;
  requiredPusdAmountRaw: bigint;
  clobClient: ClobClient;
};

export type EnsureDepositPusdReadyResult = {
  wrapRequired: boolean;
  wrapTxId?: string;
  wrapTxHash?: string;
  onchainDeployed: boolean;
  relayerWalletCreateState: string;
  /** true 表示 CLOB getBalanceAllowance 已满足本单，下单路径可跳过重复 updateBalanceAllowance + sleep */
  clobCollateralSynced: boolean;
};

export async function ensureDepositPusdReady(
  params: EnsureDepositPusdReadyParams
): Promise<EnsureDepositPusdReadyResult> {
  const { userId, walletId, executionAddress, depositAddress, requiredPusdAmountRaw, clobClient } = params;
  void walletId;
  const deposit = getAddress(depositAddress) as Address;
  const custodial = ethers.utils.getAddress(executionAddress);

  if (requiredPusdAmountRaw === 0n) {
    return {
      wrapRequired: false,
      onchainDeployed: false,
      relayerWalletCreateState: 'SKIPPED_ZERO_REQUIREMENT',
      clobCollateralSynced: true,
    };
  }

  if (isPusdClobSyncCached(deposit, requiredPusdAmountRaw, CONFIG.polyDepositPusdSyncCacheMs)) {
    const cachedBal = await readClobCollateralBalanceWei6(clobClient);
    if (cachedBal >= requiredPusdAmountRaw) {
      return {
        wrapRequired: false,
        onchainDeployed: true,
        relayerWalletCreateState: 'CACHED',
        clobCollateralSynced: true,
      };
    }
    invalidatePusdClobSyncCache(deposit);
  }

  let depositUsdcERaw = (await getUsdcBalance(deposit)).raw;
  let depositPusdRaw = (await getPusdBalance(deposit)).raw;
  const shortfall = requiredPusdAmountRaw > depositPusdRaw ? requiredPusdAmountRaw - depositPusdRaw : 0n;
  const approvalCalls = await collectDepositPusdCtfRelayerCalls(deposit);
  const needWrap = shortfall > 0n;
  const needRelayerOnChain = needWrap || approvalCalls.length > 0;

  if (needWrap && depositUsdcERaw < shortfall) {
    const nativeRaw = (await getNativeUsdcBalance(deposit)).raw;
    if (nativeRaw > 0n) {
      await tryAutoWrapPolymarketDepositUsdce(userId);
      depositUsdcERaw = (await getUsdcBalance(deposit)).raw;
      depositPusdRaw = (await getPusdBalance(deposit)).raw;
    }
  }

  if (needWrap && depositUsdcERaw < shortfall) {
    if (depositUsdcERaw > 0n && depositPusdRaw === 0n && !isPolymarketRelayerBuilderConfigured()) {
      console.log('[deposit-collateral-debug]', {
        depositAddress: deposit,
        usdcEToken: USDC_E_TOKEN,
        pUsdToken: PUSD_TOKEN,
        depositUsdcERaw: depositUsdcERaw.toString(),
        depositPusdRaw: depositPusdRaw.toString(),
        requiredPusdRaw: requiredPusdAmountRaw.toString(),
        wrapRequired: true,
        collateralTokenUsedForClob: PUSD_TOKEN,
      });
      throw createConflictError(
        'Deposit wallet has USDC.e but no pUSD. CLOB V2 requires pUSD collateral. Please wrap USDC.e to pUSD first.',
        {
          reasonCode: 'POLYMARKET_DEPOSIT_PUSD_WRAP_REQUIRED',
          wrapRequired: true,
        }
      );
    }
    throw createConflictError(
      '保证金不足：deposit 上 pUSD 与可 wrap 的 USDC.e 合计仍低于下单所需（CLOB V2 以 pUSD 为抵押）。',
      {
        reasonCode: 'INSUFFICIENT_COLLATERAL',
        requiredPusdRaw: requiredPusdAmountRaw.toString(),
        depositPusdRaw: depositPusdRaw.toString(),
        depositUsdcERaw: depositUsdcERaw.toString(),
        collateralTokenUsedForClob: PUSD_TOKEN,
      }
    );
  }

  if (needRelayerOnChain && !isPolymarketRelayerBuilderConfigured()) {
    if (depositUsdcERaw > 0n && depositPusdRaw === 0n) {
      console.log('[deposit-collateral-debug]', {
        depositAddress: deposit,
        usdcEToken: USDC_E_TOKEN,
        pUsdToken: PUSD_TOKEN,
        depositUsdcERaw: depositUsdcERaw.toString(),
        depositPusdRaw: depositPusdRaw.toString(),
        requiredPusdRaw: requiredPusdAmountRaw.toString(),
        wrapRequired: true,
        collateralTokenUsedForClob: PUSD_TOKEN,
      });
      throw createConflictError(
        'Deposit wallet has USDC.e but no pUSD. CLOB V2 requires pUSD collateral. Please wrap USDC.e to pUSD first.',
        {
          reasonCode: 'POLYMARKET_DEPOSIT_PUSD_WRAP_REQUIRED',
          wrapRequired: true,
        }
      );
    }
    throw createConflictError(
      'Polymarket deposit 钱包需通过 Builder Relayer 完成 pUSD 授权 / USDC.e→pUSD wrap；请配置 POLYMARKET_BUILDER_* 与 POLYMARKET_RELAYER_URL。',
      { reasonCode: 'POLYMARKET_RELAYER_NOT_CONFIGURED' }
    );
  }

  let registerOutcome = {
    onchainDeployed: false,
    relayerWalletCreateState: 'UNKNOWN' as string,
  };

  let wrapRequired = false;
  let wrapTxId: string | undefined;
  let wrapTxHash: string | undefined;

  if (needRelayerOnChain) {
    await runWithDepositRelayerFailover(
      userId,
      custodial,
      async ({ relayClient, slotId }) => {
      await assertRelayDerivedDepositMatches(relayClient, deposit, custodial);
      const reg = await ensurePolymarketDepositWalletRegisteredWithRelayer(relayClient, deposit, { slotId });
      registerOutcome = {
        onchainDeployed: reg.onchainDeployed,
        relayerWalletCreateState: reg.relayerWalletCreateState,
      };

      const calls: Array<{ target: string; value: string; data: `0x${string}` }> = [];
      if (needWrap) {
        wrapRequired = true;
        calls.push(...(await collectUsdceApproveOnrampCallIfNeeded(deposit)));
        calls.push({
          target: COLLATERAL_ONRAMP_ADDRESS,
          value: '0',
          data: encodeOnrampWrapUsdceToDepositCall(deposit, shortfall),
        });
      }
      calls.push(...approvalCalls);

      const txResp = await executeDepositWalletBatchWithRetry(
        relayClient,
        deposit,
        calls,
        'POLYMARKET_RELAYER_BATCH_SUBMIT_FAILED',
        { slotId },
      );
      wrapTxId = txResp.transactionID;
      const result = await waitRelayerTxSuccess(relayClient, txResp.transactionID, {
        reasonCode: 'POLYMARKET_RELAYER_BATCH_TIMEOUT',
        message: 'Polymarket relayer wrap/授权批次确认超时',
      });
      const th = result.transactionHash || txResp.transactionHash || '';
      wrapTxHash = th.startsWith('0x') ? th : undefined;
      depositUsdcERaw = (await getUsdcBalance(deposit)).raw;
      depositPusdRaw = (await getPusdBalance(deposit)).raw;
    },
      { slotPreference: 'backup_first', op: 'ensure_pusd_ready' }
    );
  }

  if (depositPusdRaw < requiredPusdAmountRaw) {
    throw createConflictError(
      'Polymarket relayer 执行后 deposit 上 pUSD 仍不足以满足本单；请检查链上状态或稍后重试。',
      {
        reasonCode: 'INSUFFICIENT_PUSD_AFTER_WRAP',
        depositPusdRaw: depositPusdRaw.toString(),
        requiredPusdRaw: requiredPusdAmountRaw.toString(),
      }
    );
  }

  const clobBalanceBeforeUpdate = await readClobCollateralBalanceWei6(clobClient);
  if (clobBalanceBeforeUpdate >= requiredPusdAmountRaw) {
    markPusdClobSyncCached(deposit, clobBalanceBeforeUpdate);
    return {
      wrapRequired,
      wrapTxId,
      wrapTxHash,
      onchainDeployed: registerOutcome.onchainDeployed,
      relayerWalletCreateState: registerOutcome.relayerWalletCreateState,
      clobCollateralSynced: true,
    };
  }

  /** 有上限轮询；CLOB 已跟上时提前结束以降低跟单/下单延迟。 */
  const syncPollMs = 180;
  const syncBudgetMs = needRelayerOnChain ? 4800 : 1200;
  const syncDeadline = Date.now() + syncBudgetMs;

  await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  let clobBalanceAfterUpdate = await readClobCollateralBalanceWei6(clobClient);

  while (clobBalanceAfterUpdate < requiredPusdAmountRaw && Date.now() < syncDeadline) {
    await sleep(syncPollMs);
    await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    clobBalanceAfterUpdate = await readClobCollateralBalanceWei6(clobClient);
  }

  const pUsdAllowanceBySpender = CONFIG.clobDebugUserTrace
    ? await readPusdAllowanceBySpender(deposit)
    : {};

  let clobAllowanceAfterUpdate: unknown;
  try {
    const c = clobClient as unknown as {
      getBalanceAllowance?: (p: { asset_type: AssetType }) => Promise<unknown>;
    };
    clobAllowanceAfterUpdate =
      typeof c.getBalanceAllowance === 'function'
        ? await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
        : null;
  } catch {
    clobAllowanceAfterUpdate = null;
  }

  console.log('[deposit-collateral-debug]', {
    depositAddress: deposit,
    usdcEToken: USDC_E_TOKEN,
    pUsdToken: PUSD_TOKEN,
    depositUsdcERaw: depositUsdcERaw.toString(),
    depositPusdRaw: depositPusdRaw.toString(),
    requiredPusdRaw: requiredPusdAmountRaw.toString(),
    wrapRequired,
    wrapTxId: wrapTxId ?? null,
    wrapTxHash: wrapTxHash ?? null,
    pUsdAllowanceBySpender,
    clobBalanceBeforeUpdate: clobBalanceBeforeUpdate.toString(),
    clobBalanceAfterUpdate: clobBalanceAfterUpdate.toString(),
    clobAllowanceAfterUpdate,
    collateralTokenUsedForClob: PUSD_TOKEN,
    onchainDeployed: registerOutcome.onchainDeployed,
    relayerWalletCreateState: registerOutcome.relayerWalletCreateState,
  });

  if (clobBalanceAfterUpdate < requiredPusdAmountRaw) {
    throw createConflictError(
      'Polymarket CLOB 抵押余额仍不足：已 wrap/授权并调用 updateBalanceAllowance(signature_type=3) 后 getBalanceAllowance 仍低于本单所需 pUSD。可稍后在 polymarket.com 同步或重试。',
      {
        reasonCode: 'POLYMARKET_CLOB_COLLATERAL_INSUFFICIENT',
        clobBalanceAfterUpdate: clobBalanceAfterUpdate.toString(),
        requiredPusdRaw: requiredPusdAmountRaw.toString(),
        onchainDeployed: registerOutcome.onchainDeployed,
        relayerWalletCreateState: registerOutcome.relayerWalletCreateState,
      }
    );
  }

  const synced = clobBalanceAfterUpdate >= requiredPusdAmountRaw;
  if (synced) {
    markPusdClobSyncCached(deposit, clobBalanceAfterUpdate);
  } else {
    invalidatePusdClobSyncCache(deposit);
  }

  return {
    wrapRequired,
    wrapTxId,
    wrapTxHash,
    onchainDeployed: registerOutcome.onchainDeployed,
    relayerWalletCreateState: registerOutcome.relayerWalletCreateState,
    clobCollateralSynced: synced,
  };
}
