import { prisma } from '../../db';
import { createCustodialWalletForUser, getCustodialExecutionWallet } from './custody';
import {
  POLYMARKET_AUTH_MESSAGE,
  deriveAndUpsertPolymarketCredentialForUser,
  getPolymarketCredentialStatus,
} from '../polymarket/polymarketAuth';
import {
  buildCustodialDepositFundingReadyMessage,
  evaluateCustodialDepositFundingReady,
} from './custodialDepositFundingReady';
import { createAppError, createConflictError } from '../../utils/appError';
import { Code } from '../../utils/response';
import { relayerThrownMessage } from '../polymarket/polymarketRelayerDeposit';

export type CustodialOpenPolymarketSummary = {
  bound: boolean;
  authError?: string;
  walletAddress?: string;
  /** POLY_1271 funder：由托管 owner 推导的 Polymarket deposit wallet（开通/授权成功后自动写入） */
  polymarketFunderAddress?: string | null;
  /** Builder+Relayer 配置齐全时尝试 WALLET-CREATE + 预授权批次 */
  relayerDepositProvisioned?: boolean;
  relayerProvisionError?: string;
};

export type RunCustodialWalletOpenOptions = {
  /** 注册/登录：Relayer 未就绪或链上未部署时抛错，禁止进入可充值状态 */
  strict?: boolean;
};

/**
 * 与 POST /api/custody/open 同源：确保存在托管钱包并绑定 Polymarket + WALLET-CREATE。
 */
export async function runCustodialWalletOpenWorkflow(
  userId: number,
  opts?: RunCustodialWalletOpenOptions,
): Promise<{
  address: string;
  created: boolean;
  wallet: { id: number; address: string };
  polymarketResult: CustodialOpenPolymarketSummary;
  depositFundingReady: boolean;
}> {
  const strict = opts?.strict === true;
  const existing = await (prisma as any).userCustodialKey.findFirst({
    where: { userId },
  });

  const wallet = existing
    ? await (prisma as any).wallet.findUnique({ where: { id: existing.walletId } })
    : (await createCustodialWalletForUser(userId)).wallet;

  const address = (wallet as any)?.address as string | undefined;
  if (!address) {
    throw new Error('Custodial wallet address is missing');
  }

  let polymarketResult: CustodialOpenPolymarketSummary = { bound: false };
  try {
    const execution = await getCustodialExecutionWallet(userId, address);
    const signature = await execution.signer.signMessage(POLYMARKET_AUTH_MESSAGE);
    await deriveAndUpsertPolymarketCredentialForUser({
      userId,
      address: execution.address,
      signature,
    });
    const status = await getPolymarketCredentialStatus(userId, address).catch(() => ({ bound: false as const }));
    polymarketResult = status;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    polymarketResult = { bound: false, authError: msg };
    if (strict) {
      throw createConflictError(`Polymarket 授权失败: ${msg}`, {
        reasonCode: 'CUSTODY_OPEN_POLYMARKET_AUTH_FAILED',
      });
    }
  }

  try {
    const wf = await prisma.wallet.findFirst({
      where: { userId, address, type: 'CUSTODIAL' } as any,
      select: { polymarketFunderAddress: true },
    });
    if (wf?.polymarketFunderAddress) {
      polymarketResult = { ...polymarketResult, polymarketFunderAddress: wf.polymarketFunderAddress };
    }
  } catch {
    /* ignore */
  }

  const funder = (polymarketResult.polymarketFunderAddress ?? '').trim();
  if (polymarketResult.bound && funder && funder.toLowerCase() !== address.toLowerCase()) {
    try {
      const {
        isPolymarketRelayerBuilderConfigured,
        ensurePolymarketDepositTradingApprovalsViaRelayer,
        depositWalletHasOnChainCode,
      } = await import('../polymarket/polymarketRelayerDeposit.js');
      if (isPolymarketRelayerBuilderConfigured()) {
        console.info('[custody-open] relayer deposit provision start', { userId, custodial: address, deposit: funder });
        const provision = await ensurePolymarketDepositTradingApprovalsViaRelayer({
          userId,
          custodialAddress: address,
          depositAddress: funder,
        });
        console.info('[custody-open] relayer deposit provision done', { userId, deposit: funder, provision });
        if (provision.depositWalletRelayerConfirmed === false) {
          throw new Error(
            `Polymarket deposit relayer 注册未确认（onchainDeployed=${provision.onchainDeployed}, state=${provision.relayerWalletCreateState}）`,
          );
        }
        const onchain = await depositWalletHasOnChainCode(funder);
        if (!onchain) {
          throw new Error(
            'Polymarket deposit 智能合约尚未在链上部署（WALLET-CREATE 未完成），请勿向充值地址转账',
          );
        }
        polymarketResult = { ...polymarketResult, relayerDepositProvisioned: true };
        try {
          const { invalidateUserClobClientCache, getClobClientForUser } = await import(
            '../polymarket/polymarketClob.js'
          );
          const { AssetType } = await import('@polymarket/clob-client-v2');
          invalidateUserClobClientCache(userId, address);
          const clob = await getClobClientForUser(userId, address);
          await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        } catch (e) {
          console.warn('[custody] CLOB collateral refresh after relayer skipped', e);
        }
      }
    } catch (relayerErr) {
      const msg = relayerErr instanceof Error ? relayerErr.message : String(relayerErr);
      console.warn('[custody] relayer deposit provision failed', { userId, msg, strict });
      polymarketResult = { ...polymarketResult, relayerProvisionError: msg };
      if (strict) {
        throw createAppError({
          code: Code.POLYMARKET_DEPOSIT_NOT_AVAILABLE,
          httpStatus: 503,
          message: msg,
          details: { reasonCode: 'CUSTODY_OPEN_RELAYER_PROVISION_FAILED' },
        });
      }
    }
  }

  const readyCheck = await evaluateCustodialDepositFundingReady(userId, {
    address,
    polymarketResult,
  });
  if (strict && !readyCheck.ready) {
    throw createAppError({
      code: Code.POLYMARKET_DEPOSIT_NOT_AVAILABLE,
      httpStatus: 503,
      message: buildCustodialDepositFundingReadyMessage(readyCheck),
      details: { reasonCode: 'CUSTODY_DEPOSIT_FUNDING_NOT_READY', depositFundingReady: readyCheck },
    });
  }

  return {
    address,
    created: !existing,
    wallet: { id: (wallet as any).id as number, address },
    polymarketResult,
    depositFundingReady: readyCheck.ready,
  };
}

type CustodialOpenWorkflowResult = Awaited<ReturnType<typeof runCustodialWalletOpenWorkflow>>;

/** 同用户并发 open 去重（注册后台 + POST /custody/open 共用） */
const openInFlight = new Map<number, Promise<CustodialOpenWorkflowResult>>();

export function enqueueCustodialWalletOpen(
  userId: number,
  opts?: RunCustodialWalletOpenOptions,
): Promise<CustodialOpenWorkflowResult> {
  const existing = openInFlight.get(userId);
  if (existing) {
    return existing;
  }
  const job = runCustodialWalletOpenWorkflow(userId, opts).finally(() => {
    openInFlight.delete(userId);
  });
  openInFlight.set(userId, job);
  return job;
}

export type AuthSessionCustodySnapshot = {
  depositFundingReady: boolean;
  depositFundingMessage: string;
  depositFundingBlockReasons: string[];
  custodyAddress?: string;
  depositAddress?: string;
  polymarket?: CustodialOpenPolymarketSummary;
  /** 后台正在补齐 open（含 Relayer）；前端可轮询 GET /api/custody/deposit-funding-ready */
  provisioning: boolean;
  openError?: string;
};

/**
 * 注册/登录：立即返回当前就绪快照并签发会话；未就绪时后台尽力 open，不阻塞 HTTP。
 * 充值仍由 depositFundingReady 闸门拦截。
 */
export async function attemptCustodialOpenForAuthSession(
  userId: number,
): Promise<AuthSessionCustodySnapshot> {
  let ready;
  try {
    ready = await evaluateCustodialDepositFundingReady(userId);
  } catch {
    ready = {
      ready: false,
      reasons: ['no_custodial_wallet'],
      relayerConfigured: false,
    };
  }

  const provisioning = !ready.ready;
  if (provisioning) {
    void enqueueCustodialWalletOpen(userId, { strict: false })
      .then((open) => {
        console.info('[custody] background auth-session open finished', {
          userId,
          depositFundingReady: open.depositFundingReady,
          address: open.address,
        });
      })
      .catch((e) => {
        console.warn('[custody] background auth-session open failed (session already issued)', {
          userId,
          msg: relayerThrownMessage(e),
        });
      });
  }

  return {
    depositFundingReady: ready.ready,
    depositFundingMessage: buildCustodialDepositFundingReadyMessage(ready),
    depositFundingBlockReasons: ready.reasons,
    custodyAddress: ready.custodyAddress,
    depositAddress: ready.depositAddress,
    polymarket: ready.polymarket,
    provisioning,
  };
}

/**
 * 注册：同步 strict open（仅用于显式运维/脚本；鉴权流程请用 attemptCustodialOpenForAuthSession）。
 */
export async function provisionCustodialWalletAfterRegister(userId: number) {
  return enqueueCustodialWalletOpen(userId, { strict: true });
}

/** 后台 fire-and-forget open（与注册/登录路径一致，非 strict） */
export function tryProvisionCustodialWalletAfterRegister(userId: number): void {
  void enqueueCustodialWalletOpen(userId, { strict: false }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[custody] post-register provision failed (user can open later)', { userId, message });
  });
}
