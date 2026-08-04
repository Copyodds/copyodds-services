import { randomUUID } from 'node:crypto';
import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';
import { Code, success, fail } from '../utils/response';
import { prisma } from '../db';
import { jwtAuth } from '../middlewares/jwtAuth';
import { requireUserTradePermission } from '../middlewares/requireUserTradePermission';
import { requireStepUp } from '../middlewares/requireStepUp';
import { STEP_UP_PURPOSE } from '../lib/stepUpTypes';
import { recordWithdrawApproved } from '../services/audit/stepUpAudit';
import { CONFIG } from '../config/env';
import {
  getCustodialWalletForUser,
  getCustodialWalletPublicInfo,
  getCustodialExecutionWallet,
  generateWalletForUser,
} from '../services/custody/custody';
import { enqueueCustodialWalletOpen } from '../services/custody/custodialWalletOpen';
import {
  buildCustodialDepositFundingReadyMessage,
  evaluateCustodialDepositFundingReady,
} from '../services/custody/custodialDepositFundingReady';
import {
  getOnChainUsdcBalanceForCustodialUser,
  invalidateOnChainUsdcBalanceCacheForCustodialUser,
} from '../services/custody/custodyOnChainBalance';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from '../services/custody/userWalletLedger';
import {
  isInternalPolymarketCollateralUsdcSender,
  isPolymarketCtfRedeemSender,
  publicClient,
  USDC_E_ADDRESS,
} from '../services/polymarket/web3';
import { encodeFunctionData, parseUnits, toHex, type Address } from 'viem';
import { goSignTransaction } from '../services/walletApi/goWalletClient';
import {
  POLYMARKET_AUTH_MESSAGE,
  deriveAndUpsertPolymarketCredentialForUser,
  getPolymarketCredentialStatus,
  upsertPolymarketCredential,
} from '../services/polymarket/polymarketAuth';
import { fundPolymarketDepositFromCustody } from '../services/custody/fundPolymarketDepositService';
import { getCustodialEoaDepositStatus, tryCustodialEoaDepositForward } from '../services/custody/custodialEoaDepositForward';
import { scheduleTryAutoWrapPolymarketDepositUsdce } from '../services/polymarket/polymarketDepositAutoWrap';
import {
  getPolymarketDepositUsdcBalance,
  isPolymarketDepositWithdrawConfigured,
  withdrawPolymarketDepositToCustody,
} from '../services/polymarket/polymarketDepositWithdraw';
import {
  getPolymarketDepositWithdrawPreview,
  withdrawPolymarketDepositToAddressV2,
} from '../services/polymarket/polymarketDepositWithdrawV2';
import { trySyncPolymarketFunderDepositsForUser } from '../services/polymarket/polymarketFunderLedgerSync';
import { trySyncCustodyDepositsForUser } from '../services/custody/custodyWalletLedgerSync';
import {
  assertGoTotpEnabledForUser,
  normalizeWithdrawAuthorizationInput,
} from '../services/auth/totpService';
import {
  getPolymarketBridgeDepositInfoForUser,
  getPolymarketBridgeDepositStatusForUser,
  getPolymarketBridgeSupportedAssetsCached,
  isPolymarketBridgeDepositEnabled,
} from '../services/polymarket/polymarketBridgeDepositService';
import { isAppError } from '../utils/appError';

/**
 * 交易流水（custody 面板）：保证金链上流水 + Gas 套餐 / 点数充值与消耗 / 分享领奖
 */
const WALLET_LEDGER_POLYMARKET_DEPOSIT_SCOPE = [
  WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT,
  WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT_RETURN,
  WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT_EXTERNAL,
  WALLET_LEDGER_CATEGORY.POLYMARKET_FUNDER_CHAIN_DEPOSIT,
  WALLET_LEDGER_CATEGORY.POLYMARKET_REDEEM,
  WALLET_LEDGER_CATEGORY.PACKAGE_PURCHASE,
  WALLET_LEDGER_CATEGORY.PACKAGE_FULFILL_GAS,
  WALLET_LEDGER_CATEGORY.GAS_RECHARGE,
  WALLET_LEDGER_CATEGORY.SHARE_TO_X_GAS,
  WALLET_LEDGER_CATEGORY.GAS_SPEND,
] as const;

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

const router = Router();

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');

router.post('/open', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const userId = req.user.userId;

    const { address, created, wallet, polymarketResult, depositFundingReady } =
      await enqueueCustodialWalletOpen(userId, { strict: true });

    const readyCheck = await evaluateCustodialDepositFundingReady(userId, {
      address,
      polymarketResult,
    });
    if (!depositFundingReady || !readyCheck.ready) {
      fail(res, Code.POLYMARKET_DEPOSIT_NOT_AVAILABLE, buildCustodialDepositFundingReadyMessage(readyCheck), 503, {
        details: {
          address,
          created,
          polymarket: polymarketResult,
          depositFundingReady: readyCheck,
        },
      });
      return;
    }

    const meta = await prisma.wallet.findUnique({
      where: { id: wallet.id },
      select: { signingProvider: true, walletIndex: true } as any,
    });

    success(res, {
      address,
      created,
      signingProvider: (meta as any)?.signingProvider ?? 'GO_REMOTE',
      walletIndex: (meta as any)?.walletIndex ?? null,
      polymarket: polymarketResult,
      depositFundingReady: true,
    });
  } catch (err) {
    next(err);
  }
});

/** 充值前置：deposit WALLET-CREATE 链上已部署且 Relayer 已注册 */
router.get('/deposit-funding-ready', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const readyCheck = await evaluateCustodialDepositFundingReady(req.user.userId);
    success(res, {
      message: buildCustodialDepositFundingReadyMessage(readyCheck),
      ...readyCheck,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 手动（重）授权 Polymarket CLOB 凭证。
 * 适用于 POST /open 成功但 Polymarket 自动授权失败的场景。
 */
router.post('/authorize-polymarket', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const userId = req.user.userId;

    // Ensure custodial wallet exists
    let walletAddress: string;
    try {
      const w = await getCustodialWalletForUser(userId);
      walletAddress = w.address;
    } catch {
      fail(res, Code.NOT_FOUND, 'Custodial wallet not found. Open a wallet first via POST /api/custody/open.', 404);
      return;
    }

    try {
      const execution = await getCustodialExecutionWallet(userId, walletAddress);
      const signature = await execution.signer.signMessage(POLYMARKET_AUTH_MESSAGE);
      await deriveAndUpsertPolymarketCredentialForUser({
        userId,
        address: execution.address,
        signature,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      req.log?.warn({ err: e, userId }, 'authorize-polymarket failed');
      fail(res, Code.DEPENDENCY_UNAVAILABLE, `Polymarket authorization failed: ${msg}`, 503);
      return;
    }

    const polymarket = await getPolymarketCredentialStatus(userId, walletAddress).catch(() => ({
      bound: false as const,
    }));
    if (!polymarket.bound) {
      fail(res, Code.DEPENDENCY_UNAVAILABLE, 'Polymarket authorization did not complete successfully', 503);
      return;
    }

    success(res, { polymarket });
  } catch (err) {
    next(err);
  }
});

const authorizePolymarketManualSchema = z.object({
  apiKey: z.string().trim().min(1),
  apiSecret: z.string().trim().min(1),
  passphrase: z.string().trim().min(1),
});

/**
 * 托管用户粘贴 Polymarket CLOB L2 凭证（须为该托管地址在 Polymarket 侧派生的 key）。
 * 服务端用 Go 托管签名 POLYMARKET_AUTH_MESSAGE，无需浏览器对托管地址签名。
 */
router.post('/authorize-polymarket-manual', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const userId = req.user.userId;
    const parsed = authorizePolymarketManualSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, { details: parsed.error.issues });
      return;
    }

    let walletAddress: string;
    try {
      const w = await getCustodialWalletForUser(userId);
      walletAddress = w.address;
    } catch {
      fail(res, Code.NOT_FOUND, 'Custodial wallet not found. Open a wallet first via POST /api/custody/open.', 404);
      return;
    }

    try {
      const execution = await getCustodialExecutionWallet(userId, walletAddress);
      const signature = await execution.signer.signMessage(POLYMARKET_AUTH_MESSAGE);
      await upsertPolymarketCredential({
        userId,
        address: execution.address,
        signature,
        apiKey: parsed.data.apiKey,
        apiSecret: parsed.data.apiSecret,
        passphrase: parsed.data.passphrase,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      req.log?.warn({ err: e, userId }, 'authorize-polymarket-manual failed');
      fail(res, Code.DEPENDENCY_UNAVAILABLE, `Polymarket manual credentials failed: ${msg}`, 503);
      return;
    }

    const polymarket = await getPolymarketCredentialStatus(userId, walletAddress).catch(() => ({
      bound: false as const,
    }));
    if (!polymarket.bound) {
      fail(res, Code.DEPENDENCY_UNAVAILABLE, 'Polymarket credentials were not stored successfully', 503);
      return;
    }

    success(res, { polymarket, apiKey: parsed.data.apiKey });
  } catch (err) {
    next(err);
  }
});

/** Polymarket deposit（POLY_1271 funder）：对用户口径为 USDC；含链上分项；404 表示无独立 deposit */
router.get('/polymarket-deposit-usdc-balance', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const wrapParam = typeof req.query.wrap === 'string' ? req.query.wrap.trim() : '';
    const wrapRequested = wrapParam === '1' || wrapParam.toLowerCase() === 'true';
    try {
      await trySyncCustodyDepositsForUser(req.user.userId);
    } catch (e) {
      console.error('[custody] polymarket-deposit-usdc-balance EOA sync failed', e);
    }
    try {
      const forward = await tryCustodialEoaDepositForward(req.user.userId);
      if (forward.attempted) {
        console.info('[custody] polymarket-deposit-usdc-balance forward', {
          userId: req.user.userId,
          ...forward,
        });
        // 转发完成后始终排自动 wrap（不依赖前端 wrap=1）
        if (forward.completed) {
          scheduleTryAutoWrapPolymarketDepositUsdce(
            req.user.userId,
            wrapRequested
              ? 'balance_poll:eoa_forward_complete+wrap'
              : 'balance_poll:eoa_forward_complete',
          );
        }
      }
    } catch (e) {
      console.error('[custody] polymarket-deposit-usdc-balance forward failed', e);
    }
    if (wrapRequested) {
      scheduleTryAutoWrapPolymarketDepositUsdce(req.user.userId, 'balance_poll:wrap_requested');
    }
    const data = await getPolymarketDepositUsdcBalance(req.user.userId, { readOnly: !wrapRequested });
    if (!data) {
      fail(res, Code.NOT_FOUND, 'No Polymarket deposit wallet for this user', 404);
      return;
    }
    // 钱包页普通轮询也会带上 USDC.e 分项：发现待 wrap 余额时后台自动 wrap
    if (
      !wrapRequested &&
      CONFIG.autoWrapPolymarketDepositUsdce &&
      data.usdcE?.raw &&
      data.usdcE.raw !== '0'
    ) {
      scheduleTryAutoWrapPolymarketDepositUsdce(req.user.userId, 'balance_poll:usdce_pending');
    }
    success(res, {
      ...data,
      relayerConfigured: isPolymarketDepositWithdrawConfigured(),
      bridge: isPolymarketBridgeDepositEnabled()
        ? {
            enabled: true,
            unifiedEoaDeposit: true,
            eoaNativeUsdcAutoForwardToBridge: CONFIG.polymarketBridgeEoaNativeForward,
            eoaUsdtAutoForwardToBridge: CONFIG.polymarketBridgeEoaNativeForward,
            depositAddressesPath: '/api/custody/polymarket-bridge/deposit-addresses',
            depositStatusPath: '/api/custody/polymarket-bridge/deposit-status',
            eoaDepositStatusPath: '/api/custody/eoa-deposit-status',
            docsUrl: 'https://docs.polymarket.com/cn/trading/bridge/deposit',
            directDepositUsdceOnly: true,
            usdcETokenAddress: USDC_E_ADDRESS,
          }
        : { enabled: false },
    });
  } catch (err) {
    next(err);
  }
});

/** Polymarket 官方 Bridge：为用户 deposit wallet 生成桥接充值地址（原生 USDC / 跨链推荐路径） */
router.get('/polymarket-bridge/deposit-addresses', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const refreshParam = typeof req.query.refresh === 'string' ? req.query.refresh.trim() : '';
    const refresh = refreshParam === '1' || refreshParam.toLowerCase() === 'true';
    const info = await getPolymarketBridgeDepositInfoForUser(req.user.userId, { refresh });
    success(res, info);
  } catch (err) {
    if (isAppError(err)) {
      fail(res, err.code, err.message, err.httpStatus);
      return;
    }
    next(err);
  }
});

/** Polymarket Bridge 充值进度（默认查 EVM 桥接地址；?type=svm|btc|tvm） */
router.get('/polymarket-bridge/deposit-status', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const typeRaw = typeof req.query.type === 'string' ? req.query.type.trim().toLowerCase() : 'evm';
    const bridgeAddressType =
      typeRaw === 'svm' || typeRaw === 'btc' || typeRaw === 'tvm' ? typeRaw : 'evm';
    const status = await getPolymarketBridgeDepositStatusForUser(req.user.userId, bridgeAddressType);
    success(res, status);
  } catch (err) {
    if (isAppError(err)) {
      fail(res, err.code, err.message, err.httpStatus);
      return;
    }
    next(err);
  }
});

/** Polymarket Bridge 支持的链与代币（含最低充值额） */
router.get('/polymarket-bridge/supported-assets', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    if (!isPolymarketBridgeDepositEnabled()) {
      fail(res, Code.NOT_FOUND, 'Polymarket Bridge 充值未启用', 404);
      return;
    }
    const { assets, cachedAt } = await getPolymarketBridgeSupportedAssetsCached();
    success(res, { assets, cachedAt });
  } catch (err) {
    if (isAppError(err)) {
      fail(res, err.code, err.message, err.httpStatus);
      return;
    }
    next(err);
  }
});

/** EOA 充值归集状态：供前端展示「处理中」等。 */
router.get('/eoa-deposit-status', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    try {
      await tryCustodialEoaDepositForward(req.user.userId);
    } catch (e) {
      console.error('[custody] eoa-deposit-status forward failed', e);
    }
    const status = await getCustodialEoaDepositStatus(req.user.userId);
    success(res, status);
  } catch (err) {
    if (isAppError(err) && err.httpStatus === 404) {
      fail(res, Code.NOT_FOUND, err.message, 404);
      return;
    }
    next(err);
  }
});

/** Polymarket deposit 提现预览：可提上限、阻塞原因（挂单/持仓/在途/relayer 未配置等） */
router.get('/withdraw-polymarket-deposit-preview', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const preview = await getPolymarketDepositWithdrawPreview(req.user.userId);
    if (!preview) {
      fail(res, Code.NOT_FOUND, 'No Polymarket deposit wallet for this user', 404);
      return;
    }
    success(res, preview);
  } catch (err) {
    next(err);
  }
});

const withdrawPolymarketDepositSchema = z.object({
  amount: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

/**
 * 将 Polymarket deposit 内 USDC.e 划回托管地址（Polymarket relayer WALLET batch）。
 * 需 POLYMARKET_BUILDER_API_KEY / SECRET / PASSPHRASE（及可选 POLYMARKET_RELAYER_URL）。
 */
router.post('/withdraw-polymarket-deposit', jwtAuth, (_req, res) => {
  fail(res, Code.STATE_CONFLICT, 'This legacy withdrawal route is disabled', 410, {
    reasonCode: 'LEGACY_WITHDRAW_DISABLED',
  });
});

const withdrawPolymarketDepositV2Schema = z.object({
  to: addressSchema,
  amount: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(200),
  authorization: z.string().trim().min(1),
});

/**
 * Polymarket deposit USDC.e → 用户指定地址（relayer batch + 风控）。
 */
router.post('/withdraw-polymarket-deposit-v2', jwtAuth, requireUserTradePermission, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = withdrawPolymarketDepositV2Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, { details: parsed.error.issues });
      return;
    }
    try {
      const intent = normalizeWithdrawAuthorizationInput({
        to: parsed.data.to,
        amount: parsed.data.amount,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      await assertGoTotpEnabledForUser(req.user.userId);
      const result = await withdrawPolymarketDepositToAddressV2({
        userId: req.user.userId,
        ...intent,
        authorization: parsed.data.authorization,
      });
      await recordWithdrawApproved({
        userId: req.user.userId,
        method: 'totp',
        endpoint: 'withdraw-polymarket-deposit-v2',
        req,
        metadata: { idempotencyKey: intent.idempotencyKey, to: intent.to },
      }).catch(() => undefined);
      success(res, result);
    } catch (e) {
      if (isAppError(e)) {
        next(e);
        return;
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

function encodeWalletLedgerCursor(row: { occurredAt: Date; id: string }): string {
  return `${row.occurredAt.toISOString()}__${row.id}`;
}

function decodeWalletLedgerCursor(raw: string): { occurredAt: Date; id: string } | null {
  const idx = raw.lastIndexOf('__');
  if (idx <= 0) return null;
  const occurredAt = new Date(raw.slice(0, idx));
  const id = raw.slice(idx + 2);
  if (!id || Number.isNaN(occurredAt.getTime())) return null;
  return { occurredAt, id };
}

function getMetadataTxHash(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as any;
  const txHash = m?.txHash;
  return typeof txHash === 'string' && txHash.trim() ? txHash : null;
}

function getMetadataFromAddress(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as any;
  const fromAddress = m?.fromAddress ?? m?.from;
  return typeof fromAddress === 'string' && fromAddress.trim() ? fromAddress : null;
}

function displayWalletLedgerCategory(e: {
  category: string;
  rail: string;
  direction: string;
  metadata: unknown;
}): string {
  if (
    e.category === WALLET_LEDGER_CATEGORY.POLYMARKET_FUNDER_CHAIN_DEPOSIT &&
    e.rail === WALLET_LEDGER_RAIL.ONCHAIN_USDC &&
    e.direction === WALLET_LEDGER_DIRECTION.CREDIT &&
    isPolymarketCtfRedeemSender(getMetadataFromAddress(e.metadata))
  ) {
    return WALLET_LEDGER_CATEGORY.POLYMARKET_REDEEM;
  }
  return e.category;
}

type WalletLedgerDbRow = Awaited<ReturnType<typeof prisma.userWalletLedger.findMany>>[number];

const WALLET_LEDGER_BATCH_SIZE = 80;
const WALLET_LEDGER_MAX_RAW_SCAN = 2000;

function noteWalletLedgerDedupMarkers(
  rows: WalletLedgerDbRow[],
  seenCommissionTx: Set<string>,
  seenInternalBusinessTx: Set<string>
): void {
  for (const r of rows) {
    const txh = getMetadataTxHash(r.metadata);
    if (!txh) continue;
    if (
      r.rail === WALLET_LEDGER_RAIL.ONCHAIN_USDC &&
      r.direction === WALLET_LEDGER_DIRECTION.CREDIT &&
      r.category === WALLET_LEDGER_CATEGORY.COMMISSION_ONCHAIN_USDC
    ) {
      seenCommissionTx.add(txh);
    }
    if (
      r.rail === WALLET_LEDGER_RAIL.ONCHAIN_USDC &&
      (r.category === WALLET_LEDGER_CATEGORY.PACKAGE_PURCHASE ||
        r.category === WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT_RETURN ||
        r.category === WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT_EXTERNAL)
    ) {
      seenInternalBusinessTx.add(txh);
    }
  }
}

function shouldHideWalletLedgerRow(
  r: WalletLedgerDbRow,
  seenCommissionTx: Set<string>,
  seenInternalBusinessTx: Set<string>
): boolean {
  const txh = getMetadataTxHash(r.metadata);
  const fromAddr = getMetadataFromAddress(r.metadata);
  return (
    r.rail === WALLET_LEDGER_RAIL.ONCHAIN_USDC &&
    r.direction === WALLET_LEDGER_DIRECTION.CREDIT &&
    ((r.category === WALLET_LEDGER_CATEGORY.CHAIN_DEPOSIT &&
      !!txh &&
      (seenCommissionTx.has(txh) || seenInternalBusinessTx.has(txh))) ||
      ((r.category === WALLET_LEDGER_CATEGORY.POLYMARKET_FUNDER_CHAIN_DEPOSIT ||
        r.category === WALLET_LEDGER_CATEGORY.POLYMARKET_REDEEM) &&
        (isInternalPolymarketCollateralUsdcSender(fromAddr) ||
          (!!txh && seenInternalBusinessTx.has(txh)))))
  );
}

async function fetchFilteredWalletLedgerRows(params: {
  baseWhere: Prisma.UserWalletLedgerWhereInput;
  stopAfterVisible?: number;
}): Promise<{ filtered: WalletLedgerDbRow[]; truncated: boolean }> {
  const filtered: WalletLedgerDbRow[] = [];
  const seenCommissionTx = new Set<string>();
  const seenInternalBusinessTx = new Set<string>();
  let cursorForNextPage: { occurredAt: Date; id: string } | null = null;
  let rawScanned = 0;
  let truncated = false;

  for (let guard = 0; guard < 50; guard += 1) {
    const pageWhere: Prisma.UserWalletLedgerWhereInput = {
      ...params.baseWhere,
      ...(cursorForNextPage
        ? {
            OR: [
              { occurredAt: { lt: cursorForNextPage.occurredAt } },
              {
                AND: [
                  { occurredAt: cursorForNextPage.occurredAt },
                  { id: { lt: cursorForNextPage.id } },
                ],
              },
            ],
          }
        : {}),
    };

    const rows = await prisma.userWalletLedger.findMany({
      where: pageWhere,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: WALLET_LEDGER_BATCH_SIZE,
    });
    rawScanned += rows.length;

    if (rows.length === 0) {
      break;
    }

    noteWalletLedgerDedupMarkers(rows, seenCommissionTx, seenInternalBusinessTx);

    for (const r of rows) {
      if (!shouldHideWalletLedgerRow(r, seenCommissionTx, seenInternalBusinessTx)) {
        filtered.push(r);
        if (params.stopAfterVisible != null && filtered.length > params.stopAfterVisible) {
          break;
        }
      }
    }

    const last = rows[rows.length - 1]!;
    cursorForNextPage = { occurredAt: last.occurredAt, id: last.id };

    if (params.stopAfterVisible != null && filtered.length > params.stopAfterVisible) {
      break;
    }
    if (rows.length < WALLET_LEDGER_BATCH_SIZE) {
      break;
    }
    if (rawScanned >= WALLET_LEDGER_MAX_RAW_SCAN) {
      truncated = true;
      break;
    }
  }

  return { filtered, truncated };
}

function mapWalletLedgerEntries(items: WalletLedgerDbRow[]) {
  return items.map((e) => ({
    id: e.id,
    occurredAt: e.occurredAt.toISOString(),
    rail: e.rail,
    direction: e.direction,
    amount: e.amount.toString(),
    symbol: e.symbol,
    category: displayWalletLedgerCategory(e),
    refType: e.refType,
    refId: e.refId,
  }));
}

/** 统一钱包流水（UserWalletLedger） */
router.get('/wallet-ledger', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const userId = req.user.userId;
    const take = Math.min(50, Math.max(1, Number(req.query.take ?? 20)));
    const rail =
      typeof req.query.rail === 'string' && req.query.rail.trim()
        ? req.query.rail.trim()
        : undefined;
    const categoryParam =
      typeof req.query.category === 'string' && req.query.category.trim()
        ? req.query.category.trim()
        : undefined;
    if (
      categoryParam &&
      !(WALLET_LEDGER_POLYMARKET_DEPOSIT_SCOPE as readonly string[]).includes(categoryParam)
    ) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid category for Polymarket deposit ledger', 400);
      return;
    }
    const cursorRaw =
      typeof req.query.cursor === 'string' ? req.query.cursor.trim() : '';
    const decoded = cursorRaw ? decodeWalletLedgerCursor(cursorRaw) : null;
    if (cursorRaw && !decoded) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid cursor', 400);
      return;
    }
    const offsetRaw =
      typeof req.query.offset === 'string' ? req.query.offset.trim() : '';
    const offset =
      offsetRaw && /^\d+$/.test(offsetRaw) ? Math.max(0, parseInt(offsetRaw, 10)) : 0;
    const useOffsetPagination = !cursorRaw;
    if (cursorRaw && offsetRaw) {
      fail(res, Code.VALIDATION_FAILED, 'Use either cursor or offset pagination, not both', 400);
      return;
    }

    const syncParam = req.query.sync;
    const syncOnQuery =
      syncParam === undefined || syncParam === 'true' || syncParam === '1';
    // GAS_POINTS / INTERNAL_USDC_E are DB-only; skip Polygon getLogs on first page.
    const needsOnChainLedgerSync =
      !rail || rail === WALLET_LEDGER_RAIL.ONCHAIN_USDC;
    const syncFirstPage =
      (useOffsetPagination && offset === 0) || (!useOffsetPagination && !decoded);
    if (syncFirstPage && syncOnQuery && needsOnChainLedgerSync) {
      try {
        await trySyncPolymarketFunderDepositsForUser(userId);
      } catch (e) {
        console.error('[custody] wallet-ledger polymarket funder sync failed', e);
      }
      try {
        await trySyncCustodyDepositsForUser(userId);
      } catch (e) {
        console.error('[custody] wallet-ledger custodial EOA sync failed', e);
      }
    }

    const baseWhere: Prisma.UserWalletLedgerWhereInput = {
      userId,
      ...(rail ? { rail } : {}),
      category: categoryParam
        ? categoryParam
        : { in: [...WALLET_LEDGER_POLYMARKET_DEPOSIT_SCOPE] },
      ...(rail ? {} : { rail: { not: WALLET_LEDGER_RAIL.INTERNAL_USDC_E } }),
    };

    if (useOffsetPagination) {
      const { filtered, truncated } = await fetchFilteredWalletLedgerRows({
        baseWhere,
      });
      const items = filtered.slice(offset, offset + take);
      const total = truncated
        ? Math.max(filtered.length, offset + items.length + (items.length === take ? 1 : 0))
        : filtered.length;
      const hasMore = offset + items.length < filtered.length || truncated;

      success(res, {
        entries: mapWalletLedgerEntries(items),
        nextCursor: null,
        total,
        hasMore,
        truncated,
      });
      return;
    }

    const where: Prisma.UserWalletLedgerWhereInput = {
      ...baseWhere,
      ...(decoded
        ? {
            OR: [
              { occurredAt: { lt: decoded.occurredAt } },
              {
                AND: [{ occurredAt: decoded.occurredAt }, { id: { lt: decoded.id } }],
              },
            ],
          }
        : {}),
    };

    const filtered: WalletLedgerDbRow[] = [];
    let hasMore = false;
    let lastFetchedRows: WalletLedgerDbRow[] = [];
    let cursorForNextPage: { occurredAt: Date; id: string } | null = decoded;
    const seenCommissionTx = new Set<string>();
    const seenInternalBusinessTx = new Set<string>();

    for (let guard = 0; guard < 10 && filtered.length <= take; guard += 1) {
      const pageWhere: Prisma.UserWalletLedgerWhereInput = {
        ...where,
        ...(cursorForNextPage
          ? {
              OR: [
                { occurredAt: { lt: cursorForNextPage.occurredAt } },
                {
                  AND: [
                    { occurredAt: cursorForNextPage.occurredAt },
                    { id: { lt: cursorForNextPage.id } },
                  ],
                },
              ],
            }
          : {}),
      };

      const rows = await prisma.userWalletLedger.findMany({
        where: pageWhere,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: take + 25,
      });
      lastFetchedRows = rows;

      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      noteWalletLedgerDedupMarkers(rows, seenCommissionTx, seenInternalBusinessTx);

      for (const r of rows) {
        if (!shouldHideWalletLedgerRow(r, seenCommissionTx, seenInternalBusinessTx)) {
          filtered.push(r);
          if (filtered.length > take) break;
        }
      }

      const last = rows[rows.length - 1]!;
      cursorForNextPage = { occurredAt: last.occurredAt, id: last.id };
      hasMore = rows.length >= take + 25;
    }

    const items = filtered.slice(0, take);
    const lastItem = items[items.length - 1];
    const lastIdxInBatch =
      lastItem != null ? lastFetchedRows.findIndex((r) => r.id === lastItem.id) : -1;
    const hasRemainderInBatch =
      items.length === take &&
      lastIdxInBatch >= 0 &&
      lastIdxInBatch < lastFetchedRows.length - 1;
    const hasNextPage =
      items.length === take && (filtered.length > take || hasMore || hasRemainderInBatch);
    const nextCursor = hasNextPage && lastItem
      ? encodeWalletLedgerCursor({
          occurredAt: lastItem.occurredAt,
          id: lastItem.id,
        })
      : null;

    success(res, {
      entries: mapWalletLedgerEntries(items),
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/deposits', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const take = Math.min(50, Math.max(1, Number(req.query.take ?? 20)));
    const cursorId = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : '';
    const rows = await prisma.custodyChainDeposit.findMany({
      where: { userId: req.user.userId },
      orderBy: { confirmedAt: 'desc' },
      take: take + 1,
      ...(cursorId
        ? {
            cursor: { id: cursorId },
            skip: 1,
          }
        : {}),
    });
    const hasMore = rows.length > take;
    const deposits = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? deposits[deposits.length - 1]?.id ?? null : null;
    success(res, {
      deposits: deposits.map((d) => ({
        id: d.id,
        txHash: d.txHash,
        logIndex: d.logIndex,
        fromAddress: d.fromAddress,
        toAddress: d.toAddress,
        amountRaw: d.amountRaw,
        blockNumber: d.blockNumber.toString(),
        confirmedAt: d.confirmedAt.toISOString(),
      })),
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/on-chain-balance', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const userId = req.user.userId;
    try {
      const data = await getOnChainUsdcBalanceForCustodialUser(userId);
      if (!data) {
        fail(res, Code.STATE_CONFLICT, 'Open a custodial wallet first (POST /api/custody/open).', 409);
        return;
      }
      success(res, data);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'RPC or balance read failed';
      fail(res, Code.DEPENDENCY_UNAVAILABLE, message, 503);
    }
  } catch (err) {
    next(err);
  }
});

const withdrawSchema = z.object({
  to: addressSchema,
  /** 人类可读 USDC（6 decimals），例如 "12.34" */
  amount: z.string().trim().min(1),
  /** 幂等键：网络抖动/前端重试时必须复用同一个 key，避免重复广播 */
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

/** 将托管地址上的 USDC.e 划转到 Polymarket deposit（POLY_1271）；amount 省略则划转当前链上全部余额 */
const fundPolymarketDepositSchema = z.object({
  amount: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

function isMissingCustodyWithdrawTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { code?: unknown; message?: unknown };
  if (anyErr.code === 'P2021') return true;
  const msg = typeof anyErr.message === 'string' ? anyErr.message : '';
  return msg.includes('CustodyWithdrawRequest') && msg.includes('does not exist');
}

/**
 * 链上提现：从当前用户的托管地址转出 USDC.e 到指定地址。
 * 注意：该操作只影响链上余额。
 */
router.post('/withdraw', jwtAuth, (_req, res) => {
  fail(res, Code.STATE_CONFLICT, 'Direct custodial EOA withdrawal is disabled', 410, {
    reasonCode: 'DIRECT_EOA_WITHDRAW_DISABLED',
  });
});
/* Legacy direct-EAO implementation intentionally retained as commented history.
    const parsed = withdrawSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, { details: parsed.error.issues });
      return;
    }

    const userId = req.user.userId;
    const to = parsed.data.to as `0x${string}`;
    const amountStr = parsed.data.amount;
    const idempotencyKey =
      parsed.data.idempotencyKey ??
      (typeof req.header('x-idempotency-key') === 'string' ? req.header('x-idempotency-key')!.trim() : '') ??
      '';
    let amountUnits: bigint;
    try {
      amountUnits = parseUnits(amountStr, 6);
    } catch {
      fail(res, Code.VALIDATION_FAILED, 'Invalid amount', 400);
      return;
    }
    if (amountUnits <= 0n) {
      fail(res, Code.VALIDATION_FAILED, 'amount must be > 0', 400);
      return;
    }

    // Resolve custodial signer
    const bundle = await getCustodialWalletForUser(userId);
    const { address: from, signingProvider, walletIndex, referCode } = bundle;

    // Idempotency guard: if a withdraw request with the same key exists, return it instead of broadcasting again.
    // If client didn't supply one, we generate and return it so the caller can safely retry.
    const effectiveIdempotencyKey = idempotencyKey || randomUUID();
    const existing = await (prisma as any).custodyWithdrawRequest?.findUnique?.({
      where: { userId_idempotencyKey: { userId, idempotencyKey: effectiveIdempotencyKey } },
    });
    if (existing) {
      if (existing.status === 'FAILED') {
        fail(res, Code.STATE_CONFLICT, 'Withdraw request previously failed; use a new idempotencyKey to retry', 409, {
          idempotencyKey: effectiveIdempotencyKey,
          error: existing.error ?? null,
        });
        return;
      }
      await recordWithdrawApproved({
        userId,
        method: req.stepUp!.method,
        endpoint: 'withdraw',
        req,
        metadata: { idempotencyKey: effectiveIdempotencyKey, replayed: true },
      }).catch(() => undefined);
      success(res, {
        idempotencyKey: effectiveIdempotencyKey,
        status: existing.status,
        from: existing.fromAddress,
        to: existing.toAddress,
        amount: amountStr,
        token: 'USDC.e',
        txHash: existing.txHash ?? null,
      });
      return;
    }

    // Create pending request first so network timeouts won't cause duplicate broadcasts on retry.
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

    // Check native token balance for gas (Polygon: MATIC). Without it, estimateGas/writeContract will fail.
    // We keep it simple: require a small safety threshold.
    try {
      const native = await publicClient.getBalance({ address: from as `0x${string}` });
      const minGas = 2_000_000_000_000_000n; // 0.002 MATIC (safety floor for ERC20 transfer)
      if (native < minGas) {
        await (prisma as any).custodyWithdrawRequest.update({
          where: { id: withdrawReq.id },
          data: { status: 'FAILED', error: 'Insufficient native token balance for gas' },
        });
        fail(res, Code.STATE_CONFLICT, 'Insufficient native token balance for gas', 409, {
          from,
          nativeBalanceWei: native.toString(),
          requiredMinWei: minGas.toString(),
          idempotencyKey: effectiveIdempotencyKey,
        });
        return;
      }
    } catch {
      // ignore: balance read failure should not block broadcast (RPC flaky)
    }

    // Basic on-chain balance check (best-effort)
    try {
      const raw = await publicClient.readContract({
        address: USDC_E_ADDRESS,
        abi: [{ inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' }] as const,
        functionName: 'balanceOf',
        args: [from as `0x${string}`],
      });
      if (raw < amountUnits) {
        await (prisma as any).custodyWithdrawRequest.update({
          where: { id: withdrawReq.id },
          data: { status: 'FAILED', error: 'Insufficient on-chain USDC balance' },
        });
        fail(res, Code.STATE_CONFLICT, 'Insufficient on-chain USDC balance', 409, {
          from,
          requested: amountUnits.toString(),
          available: raw.toString(),
          idempotencyKey: effectiveIdempotencyKey,
        });
        return;
      }
    } catch {
      // ignore: RPC read failure should not block broadcast
    }

    let txHash: `0x${string}`;
    try {
      if (signingProvider !== 'GO_REMOTE' || walletIndex == null || !referCode) {
        await (prisma as any).custodyWithdrawRequest.update({
          where: { id: withdrawReq.id },
          data: { status: 'FAILED', error: 'Custodial withdraw requires GO_REMOTE wallet with walletIndex' },
        });
        fail(res, Code.STATE_CONFLICT, 'Withdraw requires Go custodial wallet', 409, {
          signingProvider,
          walletIndex,
          idempotencyKey: effectiveIdempotencyKey,
        });
        return;
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
        to: USDC_E_ADDRESS,
        data: data as `0x${string}`,
      });
      const feeHints = await publicClient.estimateFeesPerGas().catch(() => null);
      const chainId = CONFIG.chainId || 137;
      let out: Awaited<ReturnType<typeof goSignTransaction>>;
      if (feeHints?.maxFeePerGas != null && feeHints.maxPriorityFeePerGas != null) {
        out = await goSignTransaction({
          refer_code: referCode,
          walletIndex: Number(walletIndex),
          chainId,
          to: USDC_E_ADDRESS,
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
          chainId,
          to: USDC_E_ADDRESS,
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
      txHash = await publicClient.sendRawTransaction({
        serializedTransaction: out.rawTxHex as `0x${string}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const lowered = msg.toLowerCase();
      const isInsufficient =
        lowered.includes('insufficient funds') ||
        lowered.includes('exceeds the balance of the account') ||
        lowered.includes('insufficient') && lowered.includes('balance');
      if (isInsufficient) {
        await (prisma as any).custodyWithdrawRequest.update({
          where: { id: withdrawReq.id },
          data: { status: 'FAILED', error: msg },
        });
        fail(res, Code.STATE_CONFLICT, 'Insufficient funds (token balance or gas fee)', 409, {
          from,
          to,
          amountRaw: amountUnits.toString(),
          error: msg,
          idempotencyKey: effectiveIdempotencyKey,
        });
        return;
      }
      await (prisma as any).custodyWithdrawRequest.update({
        where: { id: withdrawReq.id },
        data: { status: 'FAILED', error: msg },
      });
      throw e;
    }

    await (prisma as any).custodyWithdrawRequest.update({
      where: { id: withdrawReq.id },
      data: { status: 'BROADCASTED', txHash: String(txHash), error: null },
    });

    // Record a unified ledger row for UI display (best-effort; no DB balanceAfter for onchain rail)
    const idem = `chain-wd-req-${withdrawReq.id}`;
    await appendUserWalletLedger({
      userId,
      rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
      direction: WALLET_LEDGER_DIRECTION.DEBIT,
      amount: new Prisma.Decimal(amountUnits.toString()).div(1_000_000),
      symbol: 'USDC',
      category: WALLET_LEDGER_CATEGORY.CHAIN_WITHDRAW,
      refType: 'ONCHAIN_TX',
      refId: String(txHash),
      idempotencyKey: idem,
      metadata: {
        withdrawRequestId: withdrawReq.id,
        idempotencyKey: effectiveIdempotencyKey,
        txHash,
        from,
        to,
        amountRaw: amountUnits.toString(),
      },
    });

    // 提现广播后立即清掉短缓存，避免后台/前台继续看到旧链上余额。
    invalidateOnChainUsdcBalanceCacheForCustodialUser(userId);

    await recordWithdrawApproved({
      userId,
      method: req.stepUp!.method,
      endpoint: 'withdraw',
      req,
      metadata: { idempotencyKey: effectiveIdempotencyKey, txHash: String(txHash) },
    }).catch(() => undefined);

    success(res, {
      idempotencyKey: effectiveIdempotencyKey,
      status: 'BROADCASTED',
      from,
      to,
      amount: amountStr,
      token: 'USDC.e',
      txHash,
    });
  } catch (err) {
    if (isMissingCustodyWithdrawTableError(err)) {
      fail(
        res,
        Code.DEPENDENCY_UNAVAILABLE,
        'Withdraw storage table is missing. Run Prisma migrations before using /api/custody/withdraw.',
        503,
      );
      return;
    }
    next(err);
  }
});
*/

/**
 * 一键将托管地址 USDC.e 划转到 Polymarket deposit（与手动转两笔相比：用户只须向托管充一次，再点此接口）。
 * amount 省略时划转链上全部 USDC.e（仍需托管地址有 MATIC 付 gas）。
 */
router.post('/fund-polymarket-deposit', jwtAuth, requireUserTradePermission, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = fundPolymarketDepositSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, { details: parsed.error.issues });
      return;
    }

    const userId = req.user.userId;
    const idempotencyKey =
      parsed.data.idempotencyKey ??
      (typeof req.header('x-idempotency-key') === 'string' ? req.header('x-idempotency-key')!.trim() : '') ??
      '';

    let amountWei: bigint | undefined;
    if (parsed.data.amount?.trim()) {
      try {
        amountWei = parseUnits(parsed.data.amount.trim(), 6);
      } catch {
        fail(res, Code.VALIDATION_FAILED, 'Invalid amount', 400);
        return;
      }
      if (amountWei <= 0n) {
        fail(res, Code.VALIDATION_FAILED, 'amount must be > 0', 400);
        return;
      }
    }

    try {
      const result = await fundPolymarketDepositFromCustody({
        userId,
        amountWei,
        idempotencyKey: idempotencyKey || undefined,
        waitForReceipt: false,
        fundSource: 'manual_api',
      });
      success(res, {
        idempotencyKey: result.idempotencyKey,
        status: result.status,
        from: result.from,
        to: result.to,
        polymarketDeposit: result.polymarketDeposit,
        amount: result.amount || null,
        token: result.token,
        txHash: result.txHash,
      });
    } catch (err) {
      if (isAppError(err)) {
        next(err);
        return;
      }
      throw err;
    }
  } catch (err) {
    if (isMissingCustodyWithdrawTableError(err)) {
      fail(
        res,
        Code.DEPENDENCY_UNAVAILABLE,
        'Withdraw storage table is missing. Run Prisma migrations before using this endpoint.',
        503,
      );
      return;
    }
    next(err);
  }
});

router.get('/wallet', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const info = await getCustodialWalletPublicInfo(req.user.userId);
    if (!info) {
      fail(res, Code.NOT_FOUND, 'Custodial wallet not found', 404);
      return;
    }
    success(res, {
      address: info.address,
      signingProvider: info.signingProvider,
      walletIndex: info.walletIndex,
    });
  } catch (err) {
    next(err);
  }
});

// 生成新的 Go 托管钱包（无私钥返回）
router.post('/generate-wallet', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const userId = req.user.userId;
    const { address, created } = await generateWalletForUser(userId);
    success(res, {
      address,
      created,
      signingProvider: 'GO_REMOTE' as const,
    });
  } catch (err) {
    next(err);
  }
});

export const custodyRouter = router;
