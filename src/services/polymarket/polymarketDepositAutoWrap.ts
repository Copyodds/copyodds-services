/**
 * Polymarket deposit：链上 USDC.e 到账后自动 wrap 为 pUSD（CLOB V2 交易抵押）。
 * 原生 USDC 不经 DEX 转换，请走 Polymarket Bridge（EOA 归集）或直充 USDC.e。
 */
import { ethers } from 'ethers';
import { getAddress, type Address } from 'viem';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  COLLATERAL_ONRAMP_ADDRESS,
  getNativeUsdcBalance,
  getUsdcBalance,
} from './web3';
import { syncCustodialPolymarketDepositFunderIfEmpty } from './polymarketAuth';
import type { RelayClient } from '@polymarket/builder-relayer-client';
import {
  assertRelayDerivedDepositMatches,
  collectUsdceApproveOnrampCallIfNeeded,
  executeDepositWalletBatchWithRetry,
  encodeOnrampWrapUsdceToDepositCall,
  isPolymarketRelayerBuilderConfigured,
  isRelayerQuotaCooldownActive,
  isRelayerQuotaExceededError,
  isRelayerWalletBusyError,
  noteRelayerQuotaCooldownFromMessage,
  relayerThrownMessage,
  getRelayerQuotaCooldownRemainingMs,
  runWithDepositRelayerFailover,
  waitRelayerTxSuccess,
} from './polymarketRelayerDeposit';

export type AutoWrapPolymarketDepositResult = {
  attempted: boolean;
  wrappedWei?: string;
  transactionHash?: string;
  skippedReason?:
    | 'disabled'
    | 'relayer_not_configured'
    | 'no_deposit_wallet'
    | 'zero_collateral'
    | 'native_usdc_on_deposit'
    | 'relayer_busy'
    | 'relayer_quota_exceeded'
    | 'registry_stuck'
    | 'rpc_error';
  message?: string;
};

const scheduleTimers = new Map<number, ReturnType<typeof setTimeout>>();
const wrapInFlight = new Map<number, Promise<AutoWrapPolymarketDepositResult>>();
/** 转发刚完成时 RPC 可能尚未读到 USDC.e，对 zero_collateral 做有限次退避重试 */
const postForwardRetryTimers = new Map<number, ReturnType<typeof setTimeout>[]>();

const RELAYER_BUSY_MAX_ATTEMPTS = 8;
const RELAYER_BUSY_BASE_DELAY_MS = 2000;
const POST_FORWARD_WRAP_RETRY_DELAYS_MS = [2_000, 8_000, 20_000] as const;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DepositBatchCall = { target: string; value: string; data: `0x${string}` };

async function submitAutoWrapDepositBatch(
  relayClient: RelayClient,
  calls: DepositBatchCall[],
  deposit: Address,
  userId: number,
  slotId: string,
) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RELAYER_BUSY_MAX_ATTEMPTS; attempt++) {
    try {
      return await executeDepositWalletBatchWithRetry(
        relayClient,
        deposit,
        calls,
        'POLYMARKET_AUTO_WRAP_SUBMIT_FAILED',
        { slotId },
      );
    } catch (e) {
      const msg = relayerThrownMessage(e);
      if (isRelayerWalletBusyError(msg) && attempt + 1 < RELAYER_BUSY_MAX_ATTEMPTS) {
        const delayMs = RELAYER_BUSY_BASE_DELAY_MS * (attempt + 1);
        console.info('[polymarket-auto-wrap] relayer wallet busy, retrying', {
          userId,
          deposit,
          attempt: attempt + 1,
          delayMs,
        });
        await sleepMs(delayMs);
        lastErr = e;
        continue;
      }
      if (isRelayerQuotaExceededError(msg)) {
        noteRelayerQuotaCooldownFromMessage(msg, slotId);
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * 入账后异步整包 wrap（debounce 同一 user，避免多笔 ledger 连续插入时重复打 relayer）。
 * 与「读余额 await tryAutoWrap」互补：不阻塞 HTTP，也不进入每笔下单热路径。
 */
function clearPostForwardWrapRetries(userId: number): void {
  const timers = postForwardRetryTimers.get(userId);
  if (!timers?.length) return;
  for (const t of timers) clearTimeout(t);
  postForwardRetryTimers.delete(userId);
}

/**
 * EOA→Deposit 刚完成后调用：立刻排一次 wrap，并对 zero_collateral / rpc_error 做延迟重试
 *（避免链上已到账但 RPC 短暂读到 0，导致只能靠前端 wrap=1）。
 */
export function scheduleAutoWrapAfterEoaForward(userId: number, reason = 'eoa_forward_complete'): void {
  if (!CONFIG.autoWrapPolymarketDepositUsdce) {
    return;
  }
  clearPostForwardWrapRetries(userId);
  scheduleTryAutoWrapPolymarketDepositUsdce(userId, reason);

  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const delayMs of POST_FORWARD_WRAP_RETRY_DELAYS_MS) {
    const t = setTimeout(() => {
      void tryAutoWrapPolymarketDepositUsdce(userId)
        .then((result) => {
          if (result.attempted && result.transactionHash) {
            console.info('[polymarket-auto-wrap-schedule] post-forward retry ok', {
              userId,
              reason,
              delayMs,
              txHash: result.transactionHash,
            });
            clearPostForwardWrapRetries(userId);
            return;
          }
          if (
            result.skippedReason &&
            result.skippedReason !== 'zero_collateral' &&
            result.skippedReason !== 'rpc_error'
          ) {
            console.warn('[polymarket-auto-wrap-schedule] post-forward retry stop', {
              userId,
              reason,
              delayMs,
              ...result,
            });
            clearPostForwardWrapRetries(userId);
          }
        })
        .catch((err) => {
          console.warn('[polymarket-auto-wrap-schedule] post-forward retry unexpected', {
            userId,
            reason,
            delayMs,
            err,
          });
        });
    }, delayMs);
    timers.push(t);
  }
  postForwardRetryTimers.set(userId, timers);
}

export function scheduleTryAutoWrapPolymarketDepositUsdce(userId: number, reason: string): void {
  if (!CONFIG.autoWrapPolymarketDepositUsdce) {
    return;
  }
  if (isRelayerQuotaCooldownActive()) {
    console.info('[polymarket-auto-wrap-schedule] skipped relayer quota cooldown', {
      userId,
      reason,
      retryAfterMs: getRelayerQuotaCooldownRemainingMs(),
    });
    return;
  }

  const DEBOUNCE_MS = 650;
  const prev = scheduleTimers.get(userId);
  if (prev) {
    clearTimeout(prev);
  }
  const t = setTimeout(() => {
    scheduleTimers.delete(userId);
    void tryAutoWrapPolymarketDepositUsdce(userId)
      .then((result) => {
        if (result.attempted && result.transactionHash) {
          console.info('[polymarket-auto-wrap-schedule] ok', { userId, reason, txHash: result.transactionHash });
          clearPostForwardWrapRetries(userId);
          return;
        }
        if (result.skippedReason && result.skippedReason !== 'zero_collateral') {
          console.warn('[polymarket-auto-wrap-schedule]', { userId, reason, ...result });
        }
      })
      .catch((err) => {
        console.warn('[polymarket-auto-wrap-schedule] unexpected', { userId, reason, err });
      });
  }, DEBOUNCE_MS);
  scheduleTimers.set(userId, t);
}

export async function tryAutoWrapPolymarketDepositUsdce(userId: number): Promise<AutoWrapPolymarketDepositResult> {
  const inFlight = wrapInFlight.get(userId);
  if (inFlight) {
    return inFlight;
  }
  const run = tryAutoWrapPolymarketDepositUsdceOnce(userId).finally(() => {
    wrapInFlight.delete(userId);
  });
  wrapInFlight.set(userId, run);
  return run;
}

async function tryAutoWrapPolymarketDepositUsdceOnce(userId: number): Promise<AutoWrapPolymarketDepositResult> {
  if (!CONFIG.autoWrapPolymarketDepositUsdce) {
    return { attempted: false, skippedReason: 'disabled' };
  }
  if (!isPolymarketRelayerBuilderConfigured()) {
    return { attempted: false, skippedReason: 'relayer_not_configured' };
  }

  try {
    const w = await prisma.wallet.findFirst({
      where: { userId, type: 'CUSTODIAL' } as any,
      orderBy: { createdAt: 'asc' },
      select: { id: true, address: true, polymarketFunderAddress: true },
    });
    if (!w?.address) {
      return { attempted: false, skippedReason: 'no_deposit_wallet' };
    }
    const custodial = ethers.utils.getAddress(w.address);
    let depositRaw = (w.polymarketFunderAddress ?? '').trim();
    if (!depositRaw) {
      await syncCustodialPolymarketDepositFunderIfEmpty({
        userId,
        walletId: w.id,
        ownerAddress: custodial,
      });
      const w2 = await prisma.wallet.findUnique({
        where: { id: w.id },
        select: { polymarketFunderAddress: true },
      });
      depositRaw = (w2?.polymarketFunderAddress ?? '').trim();
    }
    if (!depositRaw || depositRaw.toLowerCase() === custodial.toLowerCase()) {
      return { attempted: false, skippedReason: 'no_deposit_wallet' };
    }

    const deposit = getAddress(depositRaw) as Address;
    const [usdceBal, nativeBal] = await Promise.all([
      getUsdcBalance(deposit),
      getNativeUsdcBalance(deposit),
    ]);

    if (nativeBal.raw > 0n) {
      console.warn('[polymarket-auto-wrap] native USDC on deposit ignored (use Polymarket Bridge or USDC.e)', {
        userId,
        deposit,
        nativeUsdcRaw: nativeBal.raw.toString(),
        hint: 'GET /api/custody/polymarket-bridge/deposit-addresses',
      });
    }

    const wrapWei = usdceBal.raw;
    console.info('[polymarket-auto-wrap] start', {
      userId,
      deposit,
      usdcERaw: usdceBal.raw.toString(),
      nativeUsdcRaw: nativeBal.raw.toString(),
      wrapWei: wrapWei.toString(),
    });

    if (wrapWei === 0n) {
      if (nativeBal.raw > 0n) {
        return { attempted: false, skippedReason: 'native_usdc_on_deposit' };
      }
      return { attempted: false, skippedReason: 'zero_collateral' };
    }

    return await runWithDepositRelayerFailover(
      userId,
      custodial,
      async ({ relayClient, slotId }) => {
      await assertRelayDerivedDepositMatches(relayClient, deposit, custodial);
      const calls: DepositBatchCall[] = [];
      calls.push(...(await collectUsdceApproveOnrampCallIfNeeded(deposit)));
      calls.push({
        target: COLLATERAL_ONRAMP_ADDRESS,
        value: '0',
        data: encodeOnrampWrapUsdceToDepositCall(deposit, wrapWei),
      });

      const txResp = await submitAutoWrapDepositBatch(relayClient, calls, deposit, userId, slotId);

      const result = await waitRelayerTxSuccess(relayClient, txResp.transactionID, {
        reasonCode: 'POLYMARKET_AUTO_WRAP_TIMEOUT',
        message: 'Polymarket deposit 自动 wrap 确认超时',
      });
      const th = (result.transactionHash || txResp.transactionHash || '').trim();
      const txHash = th.startsWith('0x') ? th : undefined;
      console.info('[polymarket-auto-wrap] success', {
        userId,
        deposit,
        wrappedWei: wrapWei.toString(),
        transactionHash: txHash ?? null,
        relayerTxId: txResp.transactionID,
        builderSlotId: slotId,
      });
      return {
        attempted: true,
        wrappedWei: wrapWei.toString(),
        transactionHash: txHash,
      };
    },
      { slotPreference: 'backup_first', op: 'auto_wrap' }
    );
  } catch (e) {
    const message = relayerThrownMessage(e);
    let skippedReason: AutoWrapPolymarketDepositResult['skippedReason'] = 'rpc_error';
    if (isRelayerQuotaExceededError(message)) {
      noteRelayerQuotaCooldownFromMessage(message);
      skippedReason = 'relayer_quota_exceeded';
    } else if (isRelayerWalletBusyError(message)) {
      skippedReason = 'relayer_busy';
    } else if (message.includes('注册状态异常') || message.includes('REGISTRY_STUCK')) {
      skippedReason = 'registry_stuck';
    }
    console.error('[polymarket-auto-wrap] failed', {
      userId,
      skippedReason,
      message,
      stack: e instanceof Error ? e.stack : undefined,
    });
    return { attempted: true, skippedReason, message };
  }
}
