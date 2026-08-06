/**
 * Polymarket CLOB service: user-scoped order placement, cancellations, and order/trade queries.
 * Uses @polymarket/clob-client-v2 (CLOB V1/V2 wire + EIP-712 via GET /version).
 * Platform hot-wallet client is intentionally disabled; use per-user execution wallets.
 * Per-user client: DB ApiCredential by wallet (encrypted); missing/decrypt 失败时再 createOrDeriveApiKey；进程内缓存。
 */

import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type CreateOrderOptions,
  type ClobClientOptions,
  type OpenOrderParams,
  type TradeParams,
} from '@polymarket/clob-client-v2';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { computeOrderGasCost } from '../../config/gas';
import {
  assertSufficientGasForTradeOrder,
  deductGasForTradeOrder,
} from '../gas/gas';
import {
  COPY_GAS_INSUFFICIENT_ERROR_CODE,
  markUserCopyTradingFundingWarning,
} from '../../copyTrading/services/copyFundingMonitor';
import {
  getExecutionWalletForUser,
  recordAutomationAction,
} from './automationSession';
import { ensureAllowances, ensureConditionalSellApprovals } from '../../utils/ensureAllowance';
import { createConflictError } from '../../utils/appError';
import {
  getDecryptedClobCredsForWalletIfValid,
  syncCustodialPolymarketDepositFunderIfEmpty,
  upsertClobApiCredentialsForWallet,
} from './polymarketAuth';
import { exchangeClobL1ApiKeyCreateOrDerive } from './polymarketClobL1ApiKey';
import { recordAuditEvent } from '../audit/events';
import { TradingGuardService } from '../trading/tradingGuard';
import { fundPolymarketDepositFromCustody } from '../custody/fundPolymarketDepositService';
import {
  getClobOrderFillSummary,
  isMarketSellFloorPrice,
  mergeClobFillFromOpenOrder,
  mergeClobFillFromTrades,
  parseClobFilledAmount,
} from './clobFillSummary';
import {
  getPolymarketCollateralSpenders as getCollateralSpenders,
  getPolymarketConditionalOperators as getConditionalOperators,
} from './polymarketContractSpenders';
import {
  ensurePolymarketDepositTradingApprovalsViaRelayer,
  isPolymarketRelayerBuilderConfigured,
} from './polymarketRelayerDeposit';
import { ensureDepositPusdReady } from './ensureDepositPusdReady';
import { getPusdBalance, getUsdcBalance, PUSD_TOKEN, USDC_E_TOKEN } from './web3';
import {
  invalidateSellApprovalsPrepCache,
  isSellApprovalsPrepCached,
  markSellApprovalsPrepCached,
} from './polymarketDepositPrepCache';

/** Per-user CLOB client is built with viem `walletClient`; on-chain approvals use custody `ethersSigner`, not `client.signer`. */
type UserClobBundle = {
  client: ClobClient;
  ethersSigner: ethers.Signer;
  /** 与 Polymarket deposit / POLY_SIGNATURE_TYPE=3 一致：跳过 EOA 侧 approve */
  usesDepositFlow: boolean;
};
const cachedUserClobBundles: Map<string, UserClobBundle> = new Map();

function clobChainId(): Chain {
  return CONFIG.chainId as Chain;
}

function clobSignatureType(): SignatureTypeV2 {
  return CONFIG.polySignatureType as SignatureTypeV2;
}

/** 平台单：是否走 deposit 流程（仅看 env） */
function usesPolymarketDepositWalletFlow(): boolean {
  return CONFIG.polySignatureType === SignatureTypeV2.POLY_1271;
}

/** 用户单：DB 已绑 funder 时自动 POLY_1271，无需 POLY_SIGNATURE_TYPE=3 */
function userOrderUsesDepositFlow(polymarketFunderFromWallet?: string | null): boolean {
  return Boolean(polymarketFunderFromWallet?.trim()) || CONFIG.polySignatureType === SignatureTypeV2.POLY_1271;
}

/**
 * 用户 CLOB：funder + signatureType。若 Wallet 已存 polymarketFunderAddress，强制 deposit 流程（与 Polymarket 当前策略一致）。
 */
function resolveUserClobAuth(
  custodialAddress: string,
  polymarketFunderFromWallet?: string | null
): { funder: string; signatureType: SignatureTypeV2 } {
  const trimmed = polymarketFunderFromWallet?.trim();
  if (trimmed) {
    return {
      funder: ethers.utils.getAddress(trimmed),
      signatureType: SignatureTypeV2.POLY_1271,
    };
  }
  if (CONFIG.polySignatureType === SignatureTypeV2.POLY_1271) {
    throw createConflictError(
      'Polymarket 要求使用 deposit wallet（POLY_1271）：托管用户在 POST /api/custody/open 或 authorize 成功后会自动写入推导出的 deposit wallet 地址。若仍缺少 funder，可 PUT /api/polymarket/wallet/funder；或设置 POLY_SIGNATURE_TYPE=3 并配置 POLY_PLATFORM_FUNDER_ADDRESS。',
      {
        reasonCode: 'POLY_DEPOSIT_WALLET_REQUIRED',
        doc: 'https://docs.polymarket.com/developers/CLOB/introduction#signature-types',
      }
    );
  }
  return {
    funder: ethers.utils.getAddress(custodialAddress),
    signatureType: clobSignatureType(),
  };
}

function resolvePlatformClobFunder(signerAddress: string): string {
  if (usesPolymarketDepositWalletFlow()) {
    const p = CONFIG.polyPlatformFunderAddress?.trim();
    if (!p) {
      throw new Error(
        'POLY_PLATFORM_FUNDER_ADDRESS is required when POLY_SIGNATURE_TYPE=3 (Polymarket deposit wallet flow).'
      );
    }
    return ethers.utils.getAddress(p);
  }
  return ethers.utils.getAddress(signerAddress);
}

function collateralCheckOwnerAddress(custodialAddress: string, storedFunder?: string | null): string {
  const t = storedFunder?.trim();
  if (t) return ethers.utils.getAddress(t);
  return ethers.utils.getAddress(custodialAddress);
}

function l1TempClobOptions(signer: unknown): ClobClientOptions {
  return {
    host: CONFIG.clobHost,
    chain: clobChainId(),
    signer: signer as ClobClientOptions['signer'],
    useServerTime: true,
    retryOnError: true,
    throwOnError: true,
  };
}

function authenticatedClobOptions(
  signer: unknown,
  creds: ApiKeyCreds,
  funderAddress: string,
  signatureType?: SignatureTypeV2
): ClobClientOptions {
  return {
    ...l1TempClobOptions(signer),
    creds,
    signatureType: signatureType ?? clobSignatureType(),
    funderAddress,
  };
}

/** 同一 ClobClient 在 TTL 内复用 getServerTime，避免每笔订单多次 /time 往返。 */
const CLOB_SERVER_TIME_CACHE_MS = 30_000;

function patchClobServerTimeCache(client: ClobClient): void {
  const c = client as ClobClient & {
    __pmServerTimePatched?: boolean;
    __pmServerTimeCache?: { ts: number; at: number };
  };
  if (c.__pmServerTimePatched) return;
  const orig = client.getServerTime.bind(client);
  client.getServerTime = async () => {
    const now = Date.now();
    const hit = c.__pmServerTimeCache;
    if (hit && now - hit.at < CLOB_SERVER_TIME_CACHE_MS) {
      return hit.ts;
    }
    const ts = await orig();
    c.__pmServerTimeCache = { ts, at: now };
    return ts;
  };
  c.__pmServerTimePatched = true;
}

function newClobClient(options: ClobClientOptions): ClobClient {
  const client = new ClobClient(options);
  patchClobServerTimeCache(client);
  return client;
}
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
] as const;
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const ERC1155_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
] as const;

function normalizeApiKeyCreds(raw: unknown): ApiKeyCreds {
  if (!raw || typeof raw !== 'object') return raw as ApiKeyCreds;
  const r = raw as any;
  const key = (r.key ?? r.apiKey ?? r.api_key ?? '').toString();
  const secret = (r.secret ?? r.apiSecret ?? r.api_secret ?? '').toString();
  const passphrase = (r.passphrase ?? '').toString();
  return { key, secret, passphrase };
}

function assertNonEmptyCreds(creds: ApiKeyCreds) {
  const key = creds.key?.trim?.() ?? '';
  const secret = creds.secret?.trim?.() ?? '';
  const passphrase = creds.passphrase?.trim?.() ?? '';
  if (!key || !secret || !passphrase) {
    throw new Error(
      'Polymarket CLOB credential derivation returned empty credentials. ' +
        'Set POLY_API_KEY / POLY_SECRET / POLY_PASSPHRASE or ensure outbound access to CLOB_HOST.'
    );
  }
}

function maskClobApiKeyRef(key: string | undefined): string {
  const t = (key ?? '').trim();
  if (!t) return '(empty)';
  if (t.length <= 12) return `${t.slice(0, 4)}…`;
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

/** 仅当 `POLY_CLOB_DEBUG_USER_TRACE` / `CLOB_DEBUG_USER_TRACE` 为 true 时输出，便于线上逐步对照 CLOB 与链上状态。 */
function userClobTrace(step: string, payload: Record<string, unknown>) {
  if (!CONFIG.clobDebugUserTrace) return;
  console.log('[clob-user-trace]', { step, ts: new Date().toISOString(), ...payload });
}

async function traceClobCollateralSnapshot(
  step: string,
  client: ClobClient,
  extra: Record<string, unknown>
) {
  if (!CONFIG.clobDebugUserTrace) return;
  try {
    const c = client as unknown as {
      getBalanceAllowance?: (p: { asset_type: AssetType }) => Promise<unknown>;
    };
    if (typeof c.getBalanceAllowance !== 'function') {
      userClobTrace(step, { ...extra, error: 'client has no getBalanceAllowance' });
      return;
    }
    const allowance = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    userClobTrace(step, { ...extra, allowance });
  } catch (e) {
    userClobTrace(`${step}_failed`, {
      ...extra,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 凭证更新后清除进程内 ClobClient 缓存，避免继续用旧 ApiCredential */
export function invalidateUserClobClientCache(userId: number, expectedAddress?: string) {
  const prefix = expectedAddress
    ? `${userId}:${expectedAddress.toLowerCase()}:`
    : `${userId}:`;
  for (const k of cachedUserClobBundles.keys()) {
    if (k.startsWith(prefix)) cachedUserClobBundles.delete(k);
  }
}

function getRpcProvider() {
  if (!CONFIG.rpcUrl) {
    throw new Error('RPC_URL is required for allowance checks and approvals');
  }
  return new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl, {
    chainId: 137,
    name: 'polygon',
  });
}

/**
 * Returns an authenticated ClobClient (singleton). Derives L2 credentials on first use if POLY_* not set.
 */
export async function getClobClient(): Promise<ClobClient> {
  throw createConflictError(
    'Platform hot-wallet CLOB client is disabled. Use user-scoped trading endpoints or Polymarket deposit relayer flow.',
    { reasonCode: 'PLATFORM_HOT_WALLET_DISABLED' }
  );
}

async function getOrCreateUserClobBundle(userId: number, expectedAddress?: string): Promise<UserClobBundle> {
  userClobTrace('A1_bundle_input', {
    userId,
    expectedAddressFromCaller: expectedAddress ?? null,
    clobHost: CONFIG.clobHost,
    chainId: CONFIG.chainId,
  });

  const { signer, walletClient, walletId, address, polymarketFunderAddress } =
    await getExecutionWalletForUser(userId, expectedAddress);

  const { funder, signatureType: userSigType } = resolveUserClobAuth(address, polymarketFunderAddress ?? null);
  const usesDepositFlow = userOrderUsesDepositFlow(polymarketFunderAddress ?? null);
  /** 必须与 invalidateUserClobClientCache(userId, custodial) 一致：API 可能传 deposit 作 expectedAddress，不得参与 cacheKey，否则会命中旧 bundle 而 authorize 清不掉。 */
  const addrKey = address.toLowerCase();
  const cacheKey = `${userId}:${addrKey}:f${funder.toLowerCase()}:st${userSigType}`;
  userClobTrace('A2_bundle_context', {
    userId,
    walletId,
    executionAddress: address,
    polymarketFunderFromDb: (polymarketFunderAddress ?? '').trim() || null,
    funderUsedForClobClient: funder,
    signatureType: userSigType,
    usesDepositFlow,
    cacheKey,
    cacheSize: cachedUserClobBundles.size,
  });

  const existing = cachedUserClobBundles.get(cacheKey);
  if (existing) {
    userClobTrace('A3_bundle_cache_hit', { userId, cacheKey });
    return existing;
  }
  userClobTrace('A3_bundle_cache_miss', { userId, cacheKey });

  let creds: ApiKeyCreds;
  if (usesDepositFlow) {
    /**
     * POLY_1271：首次派生须在带 funder + signatureType 的 ClobClient 上调用；
     * 已有 DB 凭证时直接复用，避免每笔订单 L1 derive/create 往返。
     * @see https://docs.polymarket.com/developers/CLOB/authentication
     */
    const stored = await getDecryptedClobCredsForWalletIfValid(walletId);
    if (stored) {
      creds = stored;
      userClobTrace('A4_deposit_flow_use_db_creds', {
        userId,
        walletId,
        maskApiKey: maskClobApiKeyRef(creds.key),
      });
    } else {
      const depositTempOptions = {
        ...l1TempClobOptions(walletClient),
        signatureType: userSigType,
        funderAddress: funder,
      } as ClobClientOptions;
      const tempClient = newClobClient(depositTempOptions);
      userClobTrace('A4_deposit_flow_exchange_l1', {
        userId,
        walletId,
        tempClientFunder: depositTempOptions.funderAddress,
        tempClientSigType: depositTempOptions.signatureType,
      });
      creds = await exchangeClobL1ApiKeyCreateOrDerive(tempClient);
      assertNonEmptyCreds(creds);
      await upsertClobApiCredentialsForWallet({ userId, walletId, creds });
      userClobTrace('A5_deposit_flow_upserted', {
        userId,
        walletId,
        maskApiKey: maskClobApiKeyRef(creds.key),
      });
    }
  } else {
    const stored = await getDecryptedClobCredsForWalletIfValid(walletId);
    if (stored) {
      creds = stored;
      userClobTrace('A4_eoa_flow_use_db_creds', {
        userId,
        walletId,
        maskApiKey: maskClobApiKeyRef(creds.key),
      });
    } else {
      const tempClient = newClobClient(l1TempClobOptions(walletClient));
      userClobTrace('A4_eoa_flow_exchange_l1', { userId, walletId });
      creds = await exchangeClobL1ApiKeyCreateOrDerive(tempClient);
      assertNonEmptyCreds(creds);
      await upsertClobApiCredentialsForWallet({ userId, walletId, creds });
      userClobTrace('A5_eoa_flow_upserted', { userId, walletId, maskApiKey: maskClobApiKeyRef(creds.key) });
    }
  }

  const client = newClobClient(authenticatedClobOptions(walletClient, creds, funder, userSigType));
  const cProbe = client as unknown as { signatureType?: unknown; funderAddress?: string };
  userClobTrace('A6_authenticated_client', {
    userId,
    cacheKey,
    maskApiKey: maskClobApiKeyRef(creds.key),
    clientSignatureType: cProbe.signatureType ?? null,
    clientFunderAddress: cProbe.funderAddress ?? null,
  });
  const bundle: UserClobBundle = { client, ethersSigner: signer, usesDepositFlow };
  cachedUserClobBundles.set(cacheKey, bundle);
  userClobTrace('A7_bundle_cached', { userId, cacheKey });
  return bundle;
}

export async function getClobClientForUser(userId: number, expectedAddress?: string): Promise<ClobClient> {
  return (await getOrCreateUserClobBundle(userId, expectedAddress)).client;
}

export type CreateOrderParams = {
  tokenID: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  tickSize?: string;
  negRisk?: boolean;
  orderType?: 'GTC' | 'GTD' | 'FAK';
  marketBuyAmountUsd?: number;
};

/** 下单耗时日志元数据（copy / 用户单 / follow 等） */
export type CreateAndPostOrderTimingMeta = {
  source: string;
  copyTradeRowId?: string;
  leaderTradeId?: string;
};

type ClobSignPostTiming = {
  signMs: number;
  clobPostMs: number;
  retried: boolean;
};

const POLYMARKET_MIN_OUTCOME_ORDER_SIZE = 5;
const POLYMARKET_MARKET_SELL_MIN_PRICE = 0.01;

function logOrderTiming(payload: Record<string, unknown>) {
  console.log('[order-timing]', payload);
}

export { getClobOrderFillSummary, parseClobFilledAmount } from './clobFillSummary';

/** CLOB `getBalanceAllowance` balance is an integer string in 6-decimal base units. */
export function parseClobCollateralBalanceToWei6(raw: string): bigint {
  const s = raw.trim();
  if (!s) return 0n;
  if (/^\d+$/.test(s)) {
    return BigInt(s);
  }
  try {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * 1_000_000));
  } catch {
    return 0n;
  }
}

/**
 * postOrder 偶发不带 taking/makingAmount；若已有 orderID，用 getOrder.size_matched 补全，
 * 避免 BUY/SELL FAK 实际成交却被标成未成交（跟单 skip / 手动平仓 409）。
 * 市价卖单挂单价常为 0.01，不能当成交价；缺名义时再查 getTrades。
 */
async function reconcilePostOrderFill(
  client: ClobClient,
  result: unknown,
  side: 'BUY' | 'SELL',
  tokenID?: string
): Promise<unknown> {
  const initial = getClobOrderFillSummary(result, side);
  if (initial.filled) {
    const sellNeedsPriceFix =
      side === 'SELL' &&
      (!(initial.notional != null && initial.notional > 0) ||
        isMarketSellFloorPrice(initial.avgPrice));
    if (!sellNeedsPriceFix) return result;
  }
  if (result == null || typeof result !== 'object') return result;
  const orderID = String((result as { orderID?: unknown }).orderID ?? '').trim();
  if (!orderID) return result;

  let merged: unknown = result;
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) {
        await sleep(350 * (attempt - 1));
      }
      const openOrder = await client.getOrder(orderID);
      merged = mergeClobFillFromOpenOrder(merged, openOrder, side);
      const afterOrder = getClobOrderFillSummary(merged, side);
      if (afterOrder.filled && (side === 'BUY' || (afterOrder.notional != null && afterOrder.notional > 0))) {
        console.info('[clob-fill-reconcile] recovered fill from getOrder', {
          orderID,
          side,
          attempt,
          size: afterOrder.size ?? null,
          notional: afterOrder.notional ?? null,
          avgPrice: afterOrder.avgPrice ?? null,
          orderStatus: (openOrder as { status?: unknown } | null)?.status ?? null,
        });
        return merged;
      }
      console.warn('[clob-fill-reconcile] getOrder incomplete fill', {
        orderID,
        side,
        attempt,
        orderStatus: (openOrder as { status?: unknown } | null)?.status ?? null,
        sizeMatched: (openOrder as { size_matched?: unknown } | null)?.size_matched ?? null,
        size: afterOrder.size ?? null,
        notional: afterOrder.notional ?? null,
      });
    } catch (err) {
      console.warn('[clob-fill-reconcile] getOrder failed', {
        orderID,
        side,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 卖单：用成交明细拿真实价（避免 0.01 地板价）
  if (side === 'SELL') {
    try {
      const tradeParams: TradeParams = tokenID ? { asset_id: tokenID } : {};
      const trades = await client.getTrades(tradeParams, true);
      const withTrades = mergeClobFillFromTrades(merged, trades, side, orderID);
      const afterTrades = getClobOrderFillSummary(withTrades, side);
      if (afterTrades.filled && afterTrades.notional != null && afterTrades.notional > 0) {
        console.info('[clob-fill-reconcile] recovered sell fill from getTrades', {
          orderID,
          size: afterTrades.size ?? null,
          notional: afterTrades.notional ?? null,
          avgPrice: afterTrades.avgPrice ?? null,
        });
        return withTrades;
      }
    } catch (err) {
      console.warn('[clob-fill-reconcile] getTrades failed', {
        orderID,
        side,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return merged;
}

function estimateBuyMakerAmount(params: CreateOrderParams): ethers.BigNumber {
  const amountUsd =
    params.marketBuyAmountUsd != null && Number.isFinite(params.marketBuyAmountUsd)
      ? params.marketBuyAmountUsd
      : params.price * params.size;
  const quoteAmount = Math.max(0, Math.ceil(amountUsd * 1_000_000));
  return ethers.BigNumber.from(quoteAmount);
}

function quantizeMarketBuyAmountUsd(params: CreateOrderParams): number {
  const amountUsd =
    params.marketBuyAmountUsd != null && Number.isFinite(params.marketBuyAmountUsd)
      ? params.marketBuyAmountUsd
      : params.price * params.size;
  return Math.max(0, Math.ceil((amountUsd - 1e-9) * 100) / 100);
}

async function assertSufficientCollateralForTradeOrder(
  userId: number,
  params: CreateOrderParams,
  expectedAddress?: string,
  skipWhenClobSynced?: boolean
) {
  if (params.side !== 'BUY' || skipWhenClobSynced) {
    return;
  }
  let ctx = await getExecutionWalletForUser(userId, expectedAddress);
  // 与开通/授权时一致：避免 DB 未回填 polymarketFunderAddress 时在托管地址误查保证金（POLY_1271 实际在 deposit wallet）
  if (!(ctx.polymarketFunderAddress ?? '').trim()) {
    await syncCustodialPolymarketDepositFunderIfEmpty({
      userId,
      walletId: ctx.walletId,
      ownerAddress: ctx.address,
    });
    ctx = await getExecutionWalletForUser(userId, expectedAddress);
  }
  const collateralOwner = collateralCheckOwnerAddress(ctx.address, ctx.polymarketFunderAddress ?? null);
  const requiredAmount = estimateBuyMakerAmount(params);
  const pusd = await getPusdBalance(collateralOwner as `0x${string}`);
  const requiredRaw = BigInt(requiredAmount.toString());
  if (pusd.raw < requiredRaw) {
    const custodial = ethers.utils.getAddress(ctx.address);
    const isDepositCollateral = collateralOwner.toLowerCase() !== custodial.toLowerCase();
    throw createConflictError(
      isDepositCollateral
        ? '保证金不足：Polymarket CLOB V2 买单抵押为 pUSD（链上 deposit 地址）。请确保已 wrap 并有足够 pUSD，或减少下单数量。'
        : '保证金不足：请先持有足够 pUSD（CLOB V2 collateral）或减少下单数量。',
      {
        reasonCode: 'INSUFFICIENT_COLLATERAL',
        token: 'pUSD',
        collateralTokenUsedForClob: PUSD_TOKEN,
        address: collateralOwner,
        custodialAddress: custodial,
        checksDepositWallet: isDepositCollateral,
        required: ethers.utils.formatUnits(requiredAmount, 6),
        available: pusd.formatted,
        ...(isDepositCollateral
          ? {
              hint:
                'Polymarket CLOB V2 只认 pUSD 作为 BUY collateral。若 deposit 仅有 USDC.e，请先通过 Collateral Onramp wrap 成 pUSD；然后从 Deposit Wallet 授权 CLOB V2 Exchange，并调用 updateBalanceAllowance(signature_type=3)。',
            }
          : {}),
      }
    );
  }
}

/** 同一用户 CLOB 下单串行，避免并发买单重复自动划转到 deposit。 */
const userOrderLocks = new Map<number, Promise<void>>();

async function runUserOrderSerialized<T>(userId: number, task: () => Promise<T>): Promise<T> {
  const previous = userOrderLocks.get(userId) ?? Promise.resolve();

  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = previous.then(() => current);
  userOrderLocks.set(userId, queued);

  await previous;

  try {
    return await task();
  } finally {
    release();
    if (userOrderLocks.get(userId) === queued) {
      userOrderLocks.delete(userId);
    }
  }
}

/**
 * POLY_1271：若 deposit 上 USDC 不足而托管地址有余额，则按缺口自动划转并等待确认（受 AUTO_FUND_POLYMARKET_DEPOSIT 控制）。
 */
async function ensurePolymarketDepositCollateralAutoFund(
  userId: number,
  params: CreateOrderParams,
  expectedAddress?: string
): Promise<void> {
  if (!CONFIG.autoFundPolymarketDeposit) {
    return;
  }
  if (params.side !== 'BUY') {
    return;
  }

  let ctx = await getExecutionWalletForUser(userId, expectedAddress);
  if (!(ctx.polymarketFunderAddress ?? '').trim()) {
    await syncCustodialPolymarketDepositFunderIfEmpty({
      userId,
      walletId: ctx.walletId,
      ownerAddress: ctx.address,
    });
    ctx = await getExecutionWalletForUser(userId, expectedAddress);
  }
  const funderTrim = (ctx.polymarketFunderAddress ?? '').trim();
  if (!funderTrim) {
    return;
  }
  if (funderTrim.toLowerCase() === ctx.address.toLowerCase()) {
    return;
  }

  const collateralOwner = collateralCheckOwnerAddress(ctx.address, funderTrim);
  const requiredRaw =
    BigInt(estimateBuyMakerAmount(params).toString()) + BigInt(CONFIG.polyDepositAutoFundBufferRaw);
  const depositBal = await getUsdcBalance(collateralOwner as `0x${string}`);
  if (depositBal.raw >= requiredRaw) {
    return;
  }

  const shortfall = requiredRaw - depositBal.raw;
  const custodialBal = await getUsdcBalance(ctx.address as `0x${string}`);
  if (custodialBal.raw < shortfall) {
    return;
  }

  const fundResult = await fundPolymarketDepositFromCustody({
    userId,
    amountWei: shortfall,
    idempotencyKey: randomUUID(),
    waitForReceipt: true,
    fundSource: 'auto_order',
  });

  try {
    await recordAuditEvent({
      actorType: 'AUTO_FUND',
      actorId: 'polymarket-deposit',
      userId,
      action: 'POLYMARKET_DEPOSIT_AUTO_FUND',
      targetType: 'OnChainTx',
      targetId: fundResult.txHash ?? 'unknown',
      result: 'allowed',
      metadata: {
        amount: fundResult.amount,
        polymarketDeposit: fundResult.polymarketDeposit,
        from: fundResult.from,
        txHash: fundResult.txHash,
        requiredRaw: requiredRaw.toString(),
        shortfall: shortfall.toString(),
      },
    });
  } catch (err) {
    console.error('[auto-fund-poly-deposit] recordAuditEvent failed', err);
  }
}

function clobAllowanceBalanceToRawString(ba: unknown): string {
  if (!ba || typeof ba !== 'object') return '';
  const b = (ba as { balance?: unknown }).balance;
  if (b == null) return '';
  if (typeof b === 'string') return b;
  if (typeof b === 'number') return Number.isFinite(b) ? String(b) : '';
  return String(b);
}

function parseClobBalanceRawToShares(raw: string): number {
  const s = raw.trim();
  if (!s) return 0;
  try {
    return Math.floor(Number(ethers.utils.formatUnits(s, 6)) * 1_000_000) / 1_000_000;
  } catch {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (Number.isInteger(n) && n >= 1_000) return Math.floor(n) / 1_000_000;
    return Math.floor(n * 1_000_000) / 1_000_000;
  }
}

async function readClobConditionalAvailableShares(
  client: ClobClient,
  tokenID: string
): Promise<number | null> {
  const anyClient = client as unknown as {
    getBalanceAllowance?: (params: { asset_type: AssetType; token_id?: string }) => Promise<unknown>;
  };
  if (typeof anyClient.getBalanceAllowance !== 'function') return null;
  try {
    const allowance = await anyClient.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenID,
    });
    const shares = parseClobBalanceRawToShares(clobAllowanceBalanceToRawString(allowance));
    return shares > 0 ? shares : 0;
  } catch {
    return null;
  }
}

function roundDownShares(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * 1_000_000) / 1_000_000;
}

function normalizeClobTokenId(tokenID: string): string {
  return tokenID.trim().toLowerCase();
}

function isClobBalanceAllowanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('not enough balance / allowance');
}

function normalizeDepositCacheKey(deposit: string): string {
  const trimmed = deposit.trim();
  if (!trimmed) return '';
  try {
    return ethers.utils.getAddress(trimmed).toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

async function isSellPrepPersistentCached(params: {
  walletId: number;
  depositAddress: string;
}): Promise<boolean> {
  const ttlMs = CONFIG.polyDepositSellPrepDbCacheMs;
  if (!(ttlMs > 0)) return false;

  const depositKey = normalizeDepositCacheKey(params.depositAddress);
  if (!depositKey) return false;

  const wallet = await (prisma as any).wallet.findUnique({
    where: { id: params.walletId },
    select: {
      polymarketSellPrepReadyAt: true,
      polymarketSellPrepDeposit: true,
    },
  });
  const readyAt = wallet?.polymarketSellPrepReadyAt;
  const storedDeposit = normalizeDepositCacheKey(wallet?.polymarketSellPrepDeposit ?? '');
  if (
    !(readyAt instanceof Date) ||
    storedDeposit !== depositKey ||
    Date.now() - readyAt.getTime() >= ttlMs
  ) {
    return false;
  }

  markSellApprovalsPrepCached(params.depositAddress);
  return true;
}

async function markSellPrepPersistentCached(params: {
  walletId: number;
  depositAddress: string;
}): Promise<void> {
  const depositKey = normalizeDepositCacheKey(params.depositAddress);
  if (!depositKey) return;

  await (prisma as any).wallet.updateMany({
    where: { id: params.walletId },
    data: {
      polymarketSellPrepReadyAt: new Date(),
      polymarketSellPrepDeposit: depositKey,
    },
  });
}

async function invalidateSellPrepPersistentCache(params: {
  walletId?: number;
  depositAddress?: string;
  reason: string;
}): Promise<void> {
  if (params.depositAddress) {
    invalidateSellApprovalsPrepCache(params.depositAddress);
  }
  if (!params.walletId) return;

  await (prisma as any).wallet.updateMany({
    where: { id: params.walletId },
    data: {
      polymarketSellPrepReadyAt: null,
      polymarketSellPrepDeposit: null,
    },
  });
  if (CONFIG.clobDebugUserTrace) {
    console.warn('[clob-user-order] invalidated persistent sell prep cache', {
      walletId: params.walletId,
      deposit: params.depositAddress ?? null,
      reason: params.reason,
    });
  }
}

function clobErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isClobMarketNoMatchError(error: unknown): boolean {
  return clobErrorMessage(error).trim().toLowerCase() === 'no match';
}

/** CLOB 报余额不足且 active orders 已占满 conditional 余额（常见于重复点「平仓」或跟卖挂单未撤） */
function isClobBalanceLockedByActiveOrders(error: unknown): boolean {
  if (!isClobBalanceAllowanceError(error)) return false;
  const message = clobErrorMessage(error);
  const balanceMatch = message.match(/balance:\s*(\d+)/i);
  const activeMatch = message.match(/sum of active orders:\s*(\d+)/i);
  if (!balanceMatch || !activeMatch) return false;
  try {
    const balance = BigInt(balanceMatch[1]);
    const active = BigInt(activeMatch[1]);
    return active > 0n && balance <= active;
  } catch {
    return false;
  }
}

type ClobOpenOrderRow = {
  id?: string;
  side?: string;
  asset_id?: string;
};

/**
 * 撤销同一 outcome token 上未成交的 SELL 挂单，释放 CLOB 侧 conditional 可用余额。
 * 平仓/跟卖前调用，避免 balance == sum of active orders 导致新卖单被拒。
 */
async function cancelOpenSellOrdersForToken(
  client: ClobClient,
  tokenID: string,
  meta: {
    scope: 'platform' | 'user';
    userId?: number;
    expectedAddress?: string;
    stage: 'before_sell' | 'retry_after_balance_error';
  }
): Promise<string[]> {
  let orders: unknown;
  try {
    orders = await client.getOpenOrders({ asset_id: tokenID } as OpenOrderParams, true);
  } catch {
    orders = await client.getOpenOrders(undefined, true);
  }
  const normalized = Array.isArray(orders) ? orders : [];
  const tokenKey = normalizeClobTokenId(tokenID);
  const sellOrderIds = normalized
    .filter((row): row is ClobOpenOrderRow => row != null && typeof row === 'object')
    .filter(
      (row) =>
        row.side === 'SELL' &&
        typeof row.asset_id === 'string' &&
        normalizeClobTokenId(row.asset_id) === tokenKey &&
        typeof row.id === 'string'
    )
    .map((row) => row.id as string);

  if (sellOrderIds.length === 0) {
    return [];
  }

  const cancelled: string[] = [];
  for (const orderId of sellOrderIds) {
    try {
      await client.cancelOrder({ orderID: orderId });
      cancelled.push(orderId);
    } catch (err) {
      if (CONFIG.clobDebugUserTrace) {
        console.warn('[clob-sell-debug] failed to cancel open SELL order', {
          ...meta,
          tokenID,
          orderId,
          error: clobErrorMessage(err),
        });
      }
    }
  }

  if (cancelled.length > 0) {
    if (CONFIG.clobDebugUserTrace) {
      console.info('[clob-sell-debug] cancelled open SELL orders to free conditional balance', {
        ...meta,
        tokenID,
        cancelledCount: cancelled.length,
        cancelledOrderIds: cancelled,
      });
    }
  }

  return cancelled;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveNegRiskForOrder(
  client: ClobClient,
  params: CreateOrderParams
): Promise<boolean> {
  if (params.negRisk !== undefined) {
    return params.negRisk;
  }

  return client.getNegRisk(params.tokenID);
}

async function logCollateralDebug(
  signer: ethers.Signer,
  spenders: string[],
  requiredAmount: ethers.BigNumber,
  meta: {
    scope: 'platform' | 'user';
    side: 'BUY' | 'SELL';
    tokenID: string;
    negRisk: boolean;
    userId?: number;
    expectedAddress?: string;
  }
) {
  if (!CONFIG.clobDebugUserTrace) return;
  try {
    const address = await signer.getAddress();
    const collateralErc20 = new ethers.Contract(PUSD_TOKEN, ERC20_ABI, signer);
    const [balance, allowances] = await Promise.all([
      collateralErc20.balanceOf(address),
      Promise.all(
        spenders.map(async (spender) => {
          const allowance = await collateralErc20.allowance(address, spender);
          return [spender, allowance] as const;
        })
      ),
    ]);
    const allowanceEntries = Object.fromEntries(
      allowances.map(([spender, allowance]) => [
        spender,
        {
          raw: allowance.toString(),
          pusd: ethers.utils.formatUnits(allowance, 6),
          sufficient: allowance.gte(requiredAmount),
        },
      ])
    );

    console.log('[clob-buy-debug]', {
      ...meta,
      address,
      collateralToken: PUSD_TOKEN,
      spenders,
      requiredAmountRaw: requiredAmount.toString(),
      requiredAmountPusd: ethers.utils.formatUnits(requiredAmount, 6),
      balanceRaw: balance.toString(),
      balancePusd: ethers.utils.formatUnits(balance, 6),
      allowances: allowanceEntries,
    });
  } catch (error) {
    console.warn('[clob-buy-debug] failed to inspect balance/allowance', {
      ...meta,
      spenders,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function logClobBalanceAllowance(
  client: ClobClient,
  meta: {
    scope: 'platform' | 'user';
    side: 'BUY' | 'SELL';
    tokenID: string;
    negRisk: boolean;
    stage: 'before_update' | 'after_update' | 'after_retry_update';
    userId?: number;
    expectedAddress?: string;
  }
) {
  if (!CONFIG.clobDebugUserTrace) return;
  try {
    const anyClient = client as unknown as {
      getBalanceAllowance?: (params: { asset_type: AssetType; token_id?: string }) => Promise<unknown>;
      getBalanceAllowances?: () => Promise<unknown>;
    };

    if (typeof anyClient.getBalanceAllowance === 'function') {
      const allowance = await anyClient.getBalanceAllowance(
        meta.side === 'BUY'
          ? { asset_type: AssetType.COLLATERAL }
          : { asset_type: AssetType.CONDITIONAL, token_id: meta.tokenID }
      );
      console.log('[clob-l2-balance-allowance]', { ...meta, allowance });
      return;
    }

    if (typeof anyClient.getBalanceAllowances === 'function') {
      const allowances = await anyClient.getBalanceAllowances();
      console.log('[clob-l2-balance-allowance]', { ...meta, allowances });
      return;
    }

    console.log('[clob-l2-balance-allowance]', {
      ...meta,
      supported: false,
      message: 'client does not expose getBalanceAllowance/getBalanceAllowances',
    });
  } catch (error) {
    console.warn('[clob-l2-balance-allowance] inspect failed', {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function logConditionalDebug(
  signer: ethers.Signer,
  tokenID: string,
  operators: string[],
  meta: {
    scope: 'platform' | 'user';
    side: 'BUY' | 'SELL';
    tokenID: string;
    negRisk: boolean;
    userId?: number;
    expectedAddress?: string;
    stage: 'before_update' | 'after_update' | 'after_retry_update';
  }
) {
  if (!CONFIG.clobDebugUserTrace) return;
  try {
    const owner = await signer.getAddress();
    const ctf = new ethers.Contract(CTF_CONTRACT, ERC1155_ABI, signer);
    const [balance, approvals] = await Promise.all([
      ctf.balanceOf(owner, tokenID),
      Promise.all(
        operators.map(async (operator) => {
          const approved = await ctf.isApprovedForAll(owner, operator);
          return [operator, approved] as const;
        })
      ),
    ]);

    console.log('[clob-sell-debug]', {
      ...meta,
      owner,
      balanceRaw: balance.toString(),
      balanceShares: ethers.utils.formatUnits(balance, 6),
      approvals: Object.fromEntries(approvals),
    });
  } catch (error) {
    console.warn('[clob-sell-debug] failed to inspect conditional balance/approvals', {
      ...meta,
      operators,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function logOpenOrdersDebug(
  client: ClobClient,
  meta: {
    scope: 'platform' | 'user';
    side: 'BUY' | 'SELL';
    tokenID: string;
    negRisk: boolean;
    stage: 'before_update' | 'after_update' | 'after_retry_update';
    userId?: number;
    expectedAddress?: string;
  }
) {
  if (!CONFIG.clobDebugUserTrace) return;
  try {
    const orders = await client.getOpenOrders(undefined, true);
    const normalized = Array.isArray(orders) ? orders : [];
    const buyOrders = normalized.filter(
      (order) => order && typeof order === 'object' && (order as { side?: string }).side === 'BUY'
    );

    console.log('[clob-open-orders-debug]', {
      ...meta,
      totalOpenOrders: normalized.length,
      totalBuyOpenOrders: buyOrders.length,
      sample: normalized.slice(0, 5).map((order) => ({
        id: typeof order?.id === 'string' ? order.id : null,
        side: typeof order?.side === 'string' ? order.side : null,
        asset_id: typeof order?.asset_id === 'string' ? order.asset_id : null,
        price: typeof order?.price === 'string' ? order.price : null,
        original_size: typeof order?.original_size === 'string' ? order.original_size : null,
        size_matched: typeof order?.size_matched === 'string' ? order.size_matched : null,
        status: typeof order?.status === 'string' ? order.status : null,
      })),
    });
  } catch (error) {
    console.warn('[clob-open-orders-debug] inspect failed', {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildCreateOrderRequestLog(
  params: CreateOrderParams,
  options: Partial<CreateOrderOptions>,
  orderType: OrderType.GTC | OrderType.GTD | OrderType.FAK,
  meta: {
    scope: 'platform' | 'user';
    side: 'BUY' | 'SELL';
    tokenID: string;
    negRisk: boolean;
    stage: 'first_attempt' | 'retry_attempt';
    userId?: number;
    expectedAddress?: string;
  }
) {
  const normalizedSide = params.side === 'BUY' ? Side.BUY : Side.SELL;
  const payload = {
    tokenID: params.tokenID,
    price: params.price,
    size: params.size,
    side: normalizedSide,
  };

  return {
    ...meta,
    orderType,
    options: Object.keys(options).length ? options : undefined,
    payload,
    estimatedMakerAmountRaw:
      normalizedSide === Side.BUY ? estimateBuyMakerAmount(params).toString() : undefined,
    estimatedMakerAmountUsdc:
      normalizedSide === Side.BUY
        ? ethers.utils.formatUnits(estimateBuyMakerAmount(params), 6)
        : undefined,
  };
}

async function createAndPostOrderSplit(
  client: ClobClient,
  params: CreateOrderParams,
  options: Partial<CreateOrderOptions>,
  orderType: OrderType.GTC | OrderType.GTD | OrderType.FAK,
  timingOut?: ClobSignPostTiming
) {
  if (params.side === 'BUY' && orderType === OrderType.FAK) {
    const amount = quantizeMarketBuyAmountUsd(params);
    const marketOrder = {
      tokenID: params.tokenID,
      amount,
      price: params.price,
      side: Side.BUY,
      orderType,
    };
    const createOpts = Object.keys(options).length ? options : undefined;
    const signPostStart = Date.now();
    const posted = await client.createAndPostMarketOrder(
      marketOrder as any,
      createOpts,
      orderType
    );
    if (timingOut) {
      timingOut.signMs += Date.now() - signPostStart;
    }
    return posted;
  }

  const userOrder = {
    tokenID: params.tokenID,
    price: params.price,
    size: params.size,
    side: params.side === 'BUY' ? Side.BUY : Side.SELL,
  };
  const createOpts = Object.keys(options).length ? options : undefined;
  const signStart = Date.now();
  const order = await client.createOrder(userOrder, createOpts);
  if (timingOut) {
    timingOut.signMs += Date.now() - signStart;
  }
  const postStart = Date.now();
  const posted = await client.postOrder(order, orderType);
  if (timingOut) {
    timingOut.clobPostMs += Date.now() - postStart;
  }
  return posted;
}

async function postOrderWithBalanceAllowanceRetry(
  client: ClobClient,
  params: CreateOrderParams,
  options: Partial<CreateOrderOptions>,
  orderType: OrderType.GTC | OrderType.GTD | OrderType.FAK,
  meta: {
    scope: 'platform' | 'user';
    side: 'BUY' | 'SELL';
    tokenID: string;
    negRisk: boolean;
    userId?: number;
    expectedAddress?: string;
    walletId?: number;
    depositAddress?: string;
    refreshSellPrep?: () => Promise<void>;
  },
  timingOut?: ClobSignPostTiming
) {
  if (CONFIG.clobDebugUserTrace) {
    console.log(
      '[clob-order-request]',
      buildCreateOrderRequestLog(params, options, orderType, { ...meta, stage: 'first_attempt' })
    );
  }

  try {
    return await createAndPostOrderSplit(client, params, options, orderType, timingOut);
  } catch (error) {
    if (!isClobBalanceAllowanceError(error)) {
      throw error;
    }

    if (meta.side === 'BUY') {
      if (CONFIG.clobDebugUserTrace) {
        console.warn('[clob-buy-debug] balance/allowance rejected by CLOB, refreshing allowance and retrying once', {
          ...meta,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await logClobBalanceAllowance(client, { ...meta, stage: 'after_update' });
      await logOpenOrdersDebug(client, { ...meta, stage: 'after_update' });
      await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      await sleep(400);
      await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      await sleep(2000);
      await logClobBalanceAllowance(client, { ...meta, stage: 'after_retry_update' });
      await logOpenOrdersDebug(client, { ...meta, stage: 'after_retry_update' });
    } else {
      if (CONFIG.clobDebugUserTrace) {
        console.warn('[clob-sell-debug] balance/allowance rejected by CLOB, refreshing conditional allowance and retrying once', {
          ...meta,
          error: clobErrorMessage(error),
          balanceLockedByActiveOrders: isClobBalanceLockedByActiveOrders(error),
        });
      }
      if (isClobBalanceLockedByActiveOrders(error)) {
        await cancelOpenSellOrdersForToken(client, params.tokenID, {
          scope: meta.scope,
          userId: meta.userId,
          expectedAddress: meta.expectedAddress,
          stage: 'retry_after_balance_error',
        });
        await sleep(500);
      }
      await logClobBalanceAllowance(client, { ...meta, stage: 'after_update' });
      await logOpenOrdersDebug(client, { ...meta, stage: 'after_update' });
      await client.updateBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: params.tokenID,
      });
      await sleep(750);
      await logClobBalanceAllowance(client, { ...meta, stage: 'after_retry_update' });
      await logOpenOrdersDebug(client, { ...meta, stage: 'after_retry_update' });
    }
    if (CONFIG.clobDebugUserTrace) {
      console.log(
        '[clob-order-request]',
        buildCreateOrderRequestLog(params, options, orderType, { ...meta, stage: 'retry_attempt' })
      );
    }

    if (timingOut) {
      timingOut.retried = true;
    }
    return createAndPostOrderSplit(client, params, options, orderType, timingOut);
  }
}

async function createAndPostSellMarketClose(
  client: ClobClient,
  params: CreateOrderParams,
  options: Partial<CreateOrderOptions>,
  timingOut?: ClobSignPostTiming
) {
  const marketOrder = {
    tokenID: params.tokenID,
    amount: params.size,
    price: POLYMARKET_MARKET_SELL_MIN_PRICE,
    side: Side.SELL,
    orderType: OrderType.FAK,
  };
  const createOpts = Object.keys(options).length ? options : undefined;
  const postStart = Date.now();
  const posted = await (client as unknown as {
    createAndPostMarketOrder: (
      order: typeof marketOrder,
      options?: Partial<CreateOrderOptions>,
      orderType?: OrderType.FAK
    ) => Promise<unknown>;
  }).createAndPostMarketOrder(marketOrder, createOpts, OrderType.FAK);
  if (timingOut) {
    timingOut.clobPostMs += Date.now() - postStart;
  }
  return posted;
}

async function postSellMarketCloseWithRetry(
  client: ClobClient,
  params: CreateOrderParams,
  options: Partial<CreateOrderOptions>,
  meta: {
    scope: 'platform' | 'user';
    side: 'BUY' | 'SELL';
    tokenID: string;
    negRisk: boolean;
    userId?: number;
    expectedAddress?: string;
    walletId?: number;
    depositAddress?: string;
    refreshSellPrep?: () => Promise<void>;
  },
  timingOut?: ClobSignPostTiming
) {
  if (CONFIG.clobDebugUserTrace) {
    console.log('[clob-sell-market-close]', {
      ...meta,
      amount: params.size,
      orderType: OrderType.FAK,
      stage: 'first_attempt',
    });
  }

  try {
    return await createAndPostSellMarketClose(client, params, options, timingOut);
  } catch (error) {
    if (isClobMarketNoMatchError(error)) {
      throw createConflictError('卖出未成交：当前盘口没有可立即成交的买单，FAK 已取消未成交部分，请稍后重试。', {
        reasonCode: 'CLOB_MARKET_SELL_NOT_FILLED',
      });
    }
    if (!isClobBalanceAllowanceError(error)) {
      throw error;
    }
    if (CONFIG.clobDebugUserTrace) {
      console.warn('[clob-sell-market-close] balance/allowance rejected, refreshing conditional allowance and retrying once', {
        ...meta,
        error: clobErrorMessage(error),
        balanceLockedByActiveOrders: isClobBalanceLockedByActiveOrders(error),
      });
    }
    await invalidateSellPrepPersistentCache({
      walletId: meta.walletId,
      depositAddress: meta.depositAddress,
      reason: 'clob_balance_allowance_rejected',
    });
    if (isClobBalanceLockedByActiveOrders(error)) {
      await cancelOpenSellOrdersForToken(client, params.tokenID, {
        scope: meta.scope,
        userId: meta.userId,
        expectedAddress: meta.expectedAddress,
        stage: 'retry_after_balance_error',
      });
      await sleep(500);
    }
    if (meta.refreshSellPrep) {
      await meta.refreshSellPrep();
    }
    await client.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: params.tokenID,
    });
    await sleep(750);
    if (timingOut) {
      timingOut.retried = true;
    }
    if (CONFIG.clobDebugUserTrace) {
      console.log('[clob-sell-market-close]', {
        ...meta,
        amount: params.size,
        orderType: OrderType.FAK,
        stage: 'retry_attempt',
      });
    }
    try {
      return await createAndPostSellMarketClose(client, params, options, timingOut);
    } catch (retryError) {
      if (isClobMarketNoMatchError(retryError)) {
        throw createConflictError('卖出未成交：当前盘口没有可立即成交的买单，FAK 已取消未成交部分，请稍后重试。', {
          reasonCode: 'CLOB_MARKET_SELL_NOT_FILLED',
        });
      }
      throw retryError;
    }
  }
}

function getClobPostFailureMessage(result: unknown): string | null {
  if (result == null || typeof result !== 'object') {
    return null;
  }
  const row = result as {
    success?: unknown;
    errorMsg?: unknown;
    error?: unknown;
    message?: unknown;
    status?: unknown;
  };
  if (row.success !== false) {
    return null;
  }
  const msg =
    (typeof row.errorMsg === 'string' && row.errorMsg.trim()) ||
    (typeof row.error === 'string' && row.error.trim()) ||
    (typeof row.message === 'string' && row.message.trim()) ||
    (typeof row.status === 'string' && row.status.trim());
  return msg || 'Polymarket CLOB rejected the order.';
}

/**
 * Create and post a limit order. tickSize/negRisk can come from Gamma market or be fetched by the client.
 */
export async function createAndPostOrder(params: CreateOrderParams) {
  const platformGasUserId = CONFIG.platformGasUserId;
  if (platformGasUserId == null) {
    throw new Error(
      'PLATFORM_GAS_USER_ID is not configured: set env to a User id whose gasBalance funds platform orders'
    );
  }
  const estimatedNotional =
    params.side === 'BUY' && params.marketBuyAmountUsd != null
      ? Math.max(0, params.marketBuyAmountUsd)
      : Math.max(0, params.price * params.size);
  await assertSufficientGasForTradeOrder(platformGasUserId, estimatedNotional);

  const guard = new TradingGuardService();
  await guard.assertAllowed({
    source: 'PLATFORM_ORDER',
    side: params.side,
    orderPrice: params.price,
    notionalUsd: estimatedNotional,
    tokenId: params.tokenID,
  });
  const client = await getClobClient();
  const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
  const orderType =
    params.orderType === 'GTD'
      ? OrderType.GTD
      : params.orderType === 'FAK'
        ? OrderType.FAK
        : OrderType.GTC;
  const options: Partial<CreateOrderOptions> = {};
  if (params.tickSize) options.tickSize = params.tickSize as CreateOrderOptions['tickSize'];
  const negRisk = await resolveNegRiskForOrder(client, params);
  options.negRisk = negRisk;

  if (side === Side.BUY) {
    const baseSigner = (client as any).signer as ethers.Signer;
    const signer = baseSigner.provider ? baseSigner : baseSigner.connect(getRpcProvider());
    const requiredAmount = estimateBuyMakerAmount(params);
    const collateralSpenders = getCollateralSpenders(negRisk);
    if (!usesPolymarketDepositWalletFlow()) {
      await logCollateralDebug(signer, collateralSpenders, requiredAmount, {
        scope: 'platform',
        side: 'BUY',
        tokenID: params.tokenID,
        negRisk,
      });
    }
    await logClobBalanceAllowance(client, {
      scope: 'platform',
      side: 'BUY',
      tokenID: params.tokenID,
      negRisk,
      stage: 'before_update',
    });
    await logOpenOrdersDebug(client, {
      scope: 'platform',
      side: 'BUY',
      tokenID: params.tokenID,
      negRisk,
      stage: 'before_update',
    });
    if (!usesPolymarketDepositWalletFlow()) {
      await ensureAllowances(signer, requiredAmount, collateralSpenders);
    }
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } else {
    const baseSigner = (client as any).signer as ethers.Signer;
    const signer = baseSigner.provider ? baseSigner : baseSigner.connect(getRpcProvider());
    const conditionalOperators = getConditionalOperators(negRisk);
    if (!usesPolymarketDepositWalletFlow()) {
      await logConditionalDebug(signer, params.tokenID, conditionalOperators, {
        scope: 'platform',
        side: 'SELL',
        tokenID: params.tokenID,
        negRisk,
        stage: 'before_update',
      });
      await ensureConditionalSellApprovals(signer, conditionalOperators);
    }
    await cancelOpenSellOrdersForToken(client, params.tokenID, {
      scope: 'platform',
      stage: 'before_sell',
    });
    await client.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: params.tokenID,
    });
  }

  const result = await postOrderWithBalanceAllowanceRetry(client, params, options, orderType, {
    scope: 'platform',
    side: params.side,
    tokenID: params.tokenID,
    negRisk,
  });

  if (result?.success !== false) {
    try {
      await deductGasForTradeOrder({
        userId: platformGasUserId,
        notionalUsd: estimatedNotional,
        polymarketOrderId: result?.orderID != null ? String(result.orderID) : undefined,
      });
    } catch (err) {
      const gasCost = computeOrderGasCost(estimatedNotional);
      console.error('[order-gas] platform order gas deduct failed after CLOB success', {
        userId: platformGasUserId,
        orderID: result?.orderID,
        gasCost: gasCost.toString(),
        err,
      });
    }
  }

  return result;
}

export async function createAndPostOrderForUser(
  userId: number,
  params: CreateOrderParams,
  expectedAddress?: string,
  timingMeta?: CreateAndPostOrderTimingMeta
) {
  return runUserOrderSerialized(userId, async () => {
  const t0 = Date.now();
  let t1 = t0;
  let t3 = t0;
  let t5 = t0;
  let t6 = t0;
  const timingSource = timingMeta?.source ?? 'USER_ORDER';
  const clobTiming: ClobSignPostTiming = { signMs: 0, clobPostMs: 0, retried: false };
  let orderError: string | undefined;
  let depositPrepCached = false;

  try {
  const estimatedNotional =
    params.side === 'BUY' && params.marketBuyAmountUsd != null
      ? Math.max(0, params.marketBuyAmountUsd)
      : Math.max(0, params.price * params.size);
  const guard = new TradingGuardService();
  const isCopyDispatchOrder = timingMeta?.source === 'COPY_DISPATCH';
  const isCopySellOrder = isCopyDispatchOrder && params.side === 'SELL';
  if (!isCopySellOrder) {
    await assertSufficientGasForTradeOrder(userId, estimatedNotional);
  }
  const [bundle, orderCtx] = await Promise.all([
    getOrCreateUserClobBundle(userId, expectedAddress),
    getExecutionWalletForUser(userId, expectedAddress),
    guard.assertAllowed({
      source: 'USER_ORDER',
      userId,
      side: params.side,
      expectedAddress,
      orderPrice: params.price,
      notionalUsd: estimatedNotional,
      tokenId: params.tokenID,
    }),
    ensurePolymarketDepositCollateralAutoFund(userId, params, expectedAddress),
  ]);
  t1 = Date.now();
  const { client, ethersSigner: baseEthersSigner, usesDepositFlow } = bundle;
  const depositAddr = (orderCtx.polymarketFunderAddress ?? '').trim();
  const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
  const orderType =
    params.orderType === 'GTD'
      ? OrderType.GTD
      : params.orderType === 'FAK'
        ? OrderType.FAK
        : OrderType.GTC;
  const options: Partial<CreateOrderOptions> = {};
  if (params.tickSize) options.tickSize = params.tickSize as CreateOrderOptions['tickSize'];

  userClobTrace('O1_order_context', {
    userId,
    requestExpectedAddress: expectedAddress ?? null,
    executionAddress: orderCtx.address,
    depositFunderFromDb: depositAddr || null,
    usesDepositFlow,
    sameCustodialAndDeposit:
      depositAddr.length > 0 && depositAddr.toLowerCase() === orderCtx.address.toLowerCase(),
  });
  if (usesDepositFlow && depositAddr) {
    try {
      const usdc = await getUsdcBalance(depositAddr as `0x${string}`);
      const pusd = await getPusdBalance(depositAddr as `0x${string}`);
      userClobTrace('O2_deposit_chain_balances', {
        deposit: depositAddr,
        depositUsdcEBalance: usdc.formatted,
        depositPusdBalance: pusd.formatted,
        depositUsdcERaw: usdc.raw.toString(),
        depositPusdRaw: pusd.raw.toString(),
        usdcEToken: USDC_E_TOKEN,
        pUsdToken: PUSD_TOKEN,
        collateralTokenUsedForClob: PUSD_TOKEN,
      });
    } catch (e) {
      userClobTrace('O2_deposit_chain_balances_failed', {
        deposit: depositAddr,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  let clobCollateralSynced = false;
  const ctx = orderCtx;
  const dep = (ctx.polymarketFunderAddress ?? '').trim();
  const separateDeposit =
    usesDepositFlow && dep.length > 0 && dep.toLowerCase() !== ctx.address.toLowerCase();

  const depositPrepPromise = (async (): Promise<{ clobCollateralSynced: boolean; cached: boolean }> => {
    if (!separateDeposit) {
      return { clobCollateralSynced: false, cached: false };
    }
    if (side === Side.BUY) {
      const pusdReady = await ensureDepositPusdReady({
        userId,
        walletId: ctx.walletId,
        executionAddress: ctx.address,
        depositAddress: dep,
        requiredPusdAmountRaw: BigInt(estimateBuyMakerAmount(params).toString()),
        clobClient: client,
      });
      const cached = pusdReady.relayerWalletCreateState === 'CACHED';
      if (!cached && CONFIG.clobDebugUserTrace) {
        console.info('[clob-user-order] deposit pUSD ready', {
          userId,
          deposit: dep,
          wrapRequired: pusdReady.wrapRequired,
          wrapTxId: pusdReady.wrapTxId ?? null,
          wrapTxHash: pusdReady.wrapTxHash ?? null,
          onchainDeployed: pusdReady.onchainDeployed,
          relayerWalletCreateState: pusdReady.relayerWalletCreateState,
          clobCollateralSynced: pusdReady.clobCollateralSynced,
        });
      }
      userClobTrace('O2b_deposit_pusd_ready', {
        userId,
        deposit: dep,
        wrapRequired: pusdReady.wrapRequired,
        wrapTxId: pusdReady.wrapTxId ?? null,
        wrapTxHash: pusdReady.wrapTxHash ?? null,
        onchainDeployed: pusdReady.onchainDeployed,
        relayerWalletCreateState: pusdReady.relayerWalletCreateState,
        clobCollateralSynced: pusdReady.clobCollateralSynced,
      });
      return { clobCollateralSynced: pusdReady.clobCollateralSynced, cached };
    }
    if (!isPolymarketRelayerBuilderConfigured()) {
      throw createConflictError(
        'Polymarket deposit 钱包需在链上代签 pUSD 与 CTF 授权；请配置 POLYMARKET_BUILDER_API_KEY、POLYMARKET_BUILDER_SECRET、POLYMARKET_BUILDER_PASSPHRASE（及 POLYMARKET_RELAYER_URL）。',
        { reasonCode: 'POLYMARKET_RELAYER_NOT_CONFIGURED' }
      );
    }
    if (isSellApprovalsPrepCached(dep, CONFIG.polyDepositSellPrepCacheMs)) {
      return { clobCollateralSynced: false, cached: true };
    }
    if (
      await isSellPrepPersistentCached({
        walletId: ctx.walletId,
        depositAddress: dep,
      })
    ) {
      userClobTrace('O2b_deposit_relayer_batch_db_cache_hit', {
        userId,
        walletId: ctx.walletId,
        deposit: dep,
      });
      return { clobCollateralSynced: false, cached: true };
    }
    const relayerResult = await ensurePolymarketDepositTradingApprovalsViaRelayer({
      userId,
      custodialAddress: ctx.address,
      depositAddress: dep,
    });
    const cached = relayerResult.relayerWalletCreateState === 'CACHED';
    if (!cached && CONFIG.clobDebugUserTrace) {
      console.info('[clob-user-order] deposit relayer approvals', {
        userId,
        deposit: dep,
        ran: relayerResult.ran,
        callCount: relayerResult.callCount,
        txHash: relayerResult.transactionHash ?? null,
        depositWalletRelayerConfirmed: relayerResult.depositWalletRelayerConfirmed,
        onchainDeployed: relayerResult.onchainDeployed,
        relayerWalletCreateState: relayerResult.relayerWalletCreateState,
      });
    }
    userClobTrace('O2b_deposit_relayer_batch', {
      userId,
      deposit: dep,
      ran: relayerResult.ran,
      callCount: relayerResult.callCount,
      txHash: relayerResult.transactionHash ?? null,
      depositWalletRelayerConfirmed: relayerResult.depositWalletRelayerConfirmed,
      onchainDeployed: relayerResult.onchainDeployed,
      relayerWalletCreateState: relayerResult.relayerWalletCreateState,
    });
    await markSellPrepPersistentCached({
      walletId: ctx.walletId,
      depositAddress: dep,
    });
    return { clobCollateralSynced: false, cached };
  })();

  const [negRisk, depositPrep] = await Promise.all([
    resolveNegRiskForOrder(client, params),
    depositPrepPromise,
  ]);
  options.negRisk = negRisk;
  clobCollateralSynced = depositPrep.clobCollateralSynced;
  depositPrepCached = depositPrep.cached;

  await assertSufficientCollateralForTradeOrder(
    userId,
    params,
    expectedAddress,
    clobCollateralSynced
  );

  if (side === Side.BUY) {
    await traceClobCollateralSnapshot('O3_clob_collateral_before_updateBalanceAllowance', client, {
      userId,
      tokenID: params.tokenID,
    });
    const signer = baseEthersSigner.provider ? baseEthersSigner : baseEthersSigner.connect(getRpcProvider());
    const requiredAmount = estimateBuyMakerAmount(params);
    const collateralSpenders = getCollateralSpenders(negRisk);
    if (!usesDepositFlow) {
      await logCollateralDebug(signer, collateralSpenders, requiredAmount, {
        scope: 'user',
        userId,
        expectedAddress,
        side: 'BUY',
        tokenID: params.tokenID,
        negRisk,
      });
    }
    await logClobBalanceAllowance(client, {
      scope: 'user',
      userId,
      expectedAddress,
      side: 'BUY',
      tokenID: params.tokenID,
      negRisk,
      stage: 'before_update',
    });
    await logOpenOrdersDebug(client, {
      scope: 'user',
      userId,
      expectedAddress,
      side: 'BUY',
      tokenID: params.tokenID,
      negRisk,
      stage: 'before_update',
    });
    if (!usesDepositFlow) {
      await ensureAllowances(signer, requiredAmount, collateralSpenders);
    }
    if (!clobCollateralSynced) {
      await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      await traceClobCollateralSnapshot('O4_clob_collateral_after_first_updateBalanceAllowance', client, {
        userId,
      });
    } else {
      userClobTrace('O4_skip_redundant_collateral_sync', { userId });
    }
  } else {
    const signer = baseEthersSigner.provider ? baseEthersSigner : baseEthersSigner.connect(getRpcProvider());
    const conditionalOperators = getConditionalOperators(negRisk);
    if (!usesDepositFlow) {
      await logConditionalDebug(signer, params.tokenID, conditionalOperators, {
        scope: 'user',
        userId,
        expectedAddress,
        side: 'SELL',
        tokenID: params.tokenID,
        negRisk,
        stage: 'before_update',
      });
      await ensureConditionalSellApprovals(signer, conditionalOperators);
    }
    await cancelOpenSellOrdersForToken(client, params.tokenID, {
      scope: 'user',
      userId,
      expectedAddress,
      stage: 'before_sell',
    });
    await client.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: params.tokenID,
    });
    await sleep(250);
  }

  t3 = Date.now();
  const useMarketSellClose = params.side === 'SELL';
  let orderParams = params;
  if (useMarketSellClose) {
    const available = await readClobConditionalAvailableShares(client, params.tokenID);
    if (available != null) {
      const capped = roundDownShares(Math.min(params.size, available));
      if (!(capped > 0)) {
        throw createConflictError(
          '该 outcome 份额暂无可用余额（可能已被未成交卖单占用）。请稍后重试；若持续失败请撤销同 token 的未成交卖单后再平仓。',
          { reasonCode: 'CLOB_CONDITIONAL_UNAVAILABLE' }
        );
      }
      if (capped + 1e-6 < params.size) {
        if (CONFIG.clobDebugUserTrace) {
          console.info('[clob-sell-market-close] capped requested size to CLOB available conditional balance', {
            userId,
            tokenID: params.tokenID,
            requestedSize: params.size,
            availableSize: capped,
          });
        }
      }
      orderParams = { ...params, size: capped };
    }
  }
  const posted = useMarketSellClose
    ? await postSellMarketCloseWithRetry(
        client,
        orderParams,
        options,
        {
          scope: 'user',
          userId,
          expectedAddress,
          walletId: ctx.walletId,
          depositAddress: dep || undefined,
          side: params.side,
          tokenID: params.tokenID,
          negRisk,
          refreshSellPrep: separateDeposit && dep
            ? async () => {
                const relayerResult = await ensurePolymarketDepositTradingApprovalsViaRelayer({
                  userId,
                  custodialAddress: ctx.address,
                  depositAddress: dep,
                });
                await markSellPrepPersistentCached({
                  walletId: ctx.walletId,
                  depositAddress: dep,
                });
                if (CONFIG.clobDebugUserTrace) {
                  console.info('[clob-user-order] refreshed sell prep after CLOB rejection', {
                    userId,
                    walletId: ctx.walletId,
                    deposit: dep,
                    ran: relayerResult.ran,
                    callCount: relayerResult.callCount,
                    relayerWalletCreateState: relayerResult.relayerWalletCreateState,
                  });
                }
              }
            : undefined,
        },
        clobTiming
      )
    : await postOrderWithBalanceAllowanceRetry(
        client,
        params,
        options,
        orderType,
        {
          scope: 'user',
          userId,
          expectedAddress,
          side: params.side,
          tokenID: params.tokenID,
          negRisk,
        },
        clobTiming
      );
  const postFailure = getClobPostFailureMessage(posted);
  if (postFailure) {
    throw createConflictError(postFailure, { reasonCode: 'CLOB_POST_FAILED' });
  }
  const result = (await reconcilePostOrderFill(client, posted, params.side, params.tokenID)) as any;
  const fillSummary = getClobOrderFillSummary(result, params.side);
  if (useMarketSellClose && !fillSummary.filled) {
    throw createConflictError('卖出未成交：当前盘口没有可立即成交的买单，FAK 已取消未成交部分，请稍后重试。', {
      reasonCode: 'CLOB_MARKET_SELL_NOT_FILLED',
      orderID: result?.orderID != null ? String(result.orderID) : undefined,
      status: result?.status != null ? String(result.status) : undefined,
    });
  }
  t5 = Date.now();
  if (result?.success !== false) {
    try {
      await deductGasForTradeOrder({
        userId,
        notionalUsd: estimatedNotional,
        polymarketOrderId: result?.orderID != null ? String(result.orderID) : undefined,
        allowNegativeBalance: isCopySellOrder,
      });
      if (isCopySellOrder) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { gasBalance: true },
        } as any);
        const gasBalance = (user as any)?.gasBalance as { lessThan?: (n: number) => boolean } | undefined;
        if (gasBalance?.lessThan?.(0)) {
          await markUserCopyTradingFundingWarning({
            userId,
            errorCode: COPY_GAS_INSUFFICIENT_ERROR_CODE,
            errorMsg:
              '平台 Gas 已不足，已允许本次平仓完成并扣为负值；买单已跳过，有持仓时仍可跟卖，请充值 Gas 后恢复买入。',
          });
        }
      }
    } catch (err) {
      const gasCost = computeOrderGasCost(estimatedNotional);
      console.error('[order-gas] user order gas deduct failed after CLOB success', {
        userId,
        orderID: result?.orderID,
        gasCost: gasCost.toString(),
        err,
      });
    }
    const txHashes = Array.isArray(result?.transactionsHashes)
      ? result.transactionsHashes.map(String).filter(Boolean)
      : [];
    await recordAutomationAction({
      userId,
      action: params.side,
      expectedAddress,
      notionalUsd: estimatedNotional > 0 ? estimatedNotional : undefined,
      txHash: txHashes[0],
      referenceId: result?.orderID ? String(result.orderID) : undefined,
    });
  }
  await recordAuditEvent({
    actorType: 'USER_ORDER',
    actorId: String(userId),
    userId,
    action: 'TRADE_ORDER_SUBMITTED',
    targetType: 'TradeOrder',
    targetId: result?.orderID ? String(result.orderID) : params.tokenID,
    result: result?.success === false ? 'failed' : 'allowed',
    metadata: {
      side: params.side,
      tokenId: params.tokenID,
      price: params.price,
      size: params.size,
      notionalUsd: estimatedNotional,
      expectedAddress: expectedAddress ?? null,
      status: result?.status ?? null,
      transactionsHashes: result?.transactionsHashes ?? [],
    },
  });
  t6 = Date.now();
  return result;
  } catch (e) {
    orderError = e instanceof Error ? e.message : String(e);
    t6 = Date.now();
    throw e;
  } finally {
    const prepEndMs = t3 > t1 ? t3 : t6;
    logOrderTiming({
      source: timingSource,
      userId,
      side: params.side,
      tokenID: params.tokenID,
      copyTradeRowId: timingMeta?.copyTradeRowId ?? null,
      leaderTradeId: timingMeta?.leaderTradeId ?? null,
      authAndDbMs: t1 - t0,
      buildOrderMs: prepEndMs - t1,
      signMs: clobTiming.signMs,
      clobPostMs: clobTiming.clobPostMs,
      clobRetried: clobTiming.retried,
      depositPrepCached,
      saveDbMs: t5 >= t3 ? t6 - t5 : 0,
      totalMs: t6 - t0,
      success: orderError == null,
      error: orderError ?? null,
    });
  }
  });
}

/**
 * Cancel a single order by ID.
 */
export async function cancelOrder(orderId: string) {
  const client = await getClobClient();
  return client.cancelOrder({ orderID: orderId });
}

/**
 * Get open orders (optional filters: market condition ID, asset_id).
 */
export async function getOpenOrders(params?: OpenOrderParams) {
  const client = await getClobClient();
  return client.getOpenOrders(params, true);
}

/**
 * Get trade history (optional filters: market, asset_id, before, after).
 */
export async function getTrades(params?: TradeParams) {
  const client = await getClobClient();
  return client.getTrades(params, true);
}

export async function getOpenOrdersForUser(
  userId: number,
  params?: OpenOrderParams,
  expectedAddress?: string
) {
  const client = await getClobClientForUser(userId, expectedAddress);
  return client.getOpenOrders(params, true);
}

export async function getTradesForUser(
  userId: number,
  params?: TradeParams,
  expectedAddress?: string
) {
  const client = await getClobClientForUser(userId, expectedAddress);
  return client.getTrades(params, true);
}

export async function cancelOrderForUser(orderId: string, userId: number, expectedAddress?: string) {
  const client = await getClobClientForUser(userId, expectedAddress);
  const result = await client.cancelOrder({ orderID: orderId });
  await recordAutomationAction({
    userId,
    action: 'CANCEL_ORDER',
    expectedAddress,
    referenceId: orderId,
  });
  return result;
}
