import { ethers } from 'ethers';
import { isAddress, recoverMessageAddress } from 'viem';
import { prisma } from '../../db';
import { decryptPolymarketSecret, encryptPolymarketSecret } from '../../utils/polymarketCredentialCrypto';
import { CONFIG } from '../../config/env';
import { Chain, ClobClient, SignatureTypeV2, type ApiKeyCreds } from '@polymarket/clob-client-v2';
import { ensureAuthorizationOwnerAddress, getExecutionWalletForUser } from './automationSession';
import {
  resolvePolymarketDepositWalletAddress,
  shouldCorrectStoredDepositFunderMisassignedUups,
} from './polymarketDepositWalletDerive';
import { exchangeClobL1ApiKeyCreateOrDerive } from './polymarketClobL1ApiKey';

export const POLYMARKET_AUTH_MESSAGE = 'Authorize Polymarket Trading on MirrorCopy';

function authClobTrace(step: string, payload: Record<string, unknown>) {
  if (!CONFIG.clobDebugUserTrace) return;
  console.log('[clob-user-trace]', { step, ts: new Date().toISOString(), ...payload });
}

function maskApiKeyPreview(key: string | undefined): string {
  const t = (key ?? '').trim();
  if (!t) return '(empty)';
  if (t.length <= 12) return `${t.slice(0, 4)}…`;
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

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

/** 写入或更新某交易钱包的 CLOB 凭证（加密 secret / passphrase） */
export async function upsertClobApiCredentialsForWallet(params: {
  userId: number;
  walletId: number;
  creds: ApiKeyCreds;
}): Promise<void> {
  const apiKey = params.creds.key?.trim() ?? '';
  const apiSecret = params.creds.secret?.trim() ?? '';
  const passphrase = params.creds.passphrase?.trim() ?? '';
  if (!apiKey || !apiSecret || !passphrase) {
    throw new Error('Missing api credentials');
  }
  const encSecret = encryptPolymarketSecret(apiSecret);
  const encPass = encryptPolymarketSecret(passphrase);
  await prisma.apiCredential.upsert({
    where: { walletId: params.walletId },
    update: {
      userId: params.userId,
      apiKey,
      apiSecret: encSecret,
      passphrase: encPass,
    },
    create: {
      userId: params.userId,
      walletId: params.walletId,
      apiKey,
      apiSecret: encSecret,
      passphrase: encPass,
    },
  });
}

/** 库中存在且解密成功则返回明文凭证（不做本地过期判断） */
export async function getDecryptedClobCredsForWalletIfValid(walletId: number): Promise<ApiKeyCreds | null> {
  const row = await prisma.apiCredential.findUnique({
    where: { walletId },
  });
  if (!row) return null;
  try {
    return {
      key: row.apiKey,
      secret: decryptPolymarketSecret(row.apiSecret),
      passphrase: decryptPolymarketSecret(row.passphrase),
    };
  } catch {
    return null;
  }
}

/**
 * 运维/脚本：对已有 CLOB 凭证但缺 funder 的托管钱包补写推导出的 deposit wallet 地址（与 ensure 同源）。
 */
export async function syncCustodialPolymarketDepositFunderIfEmpty(params: {
  userId: number;
  walletId: number;
  ownerAddress: string;
}): Promise<void> {
  return ensureCustodialDepositFunderAfterClobUpsert(params);
}

/** 写入 CLOB 凭证后：补全/纠正 POLY_1271 funder（与 resolvePolymarketDepositWalletAddress 一致）。 */
async function ensureCustodialDepositFunderAfterClobUpsert(params: {
  userId: number;
  walletId: number;
  ownerAddress: string;
}): Promise<void> {
  const row = await prisma.wallet.findFirst({
    where: { id: params.walletId, userId: params.userId, type: 'CUSTODIAL' } as any,
    select: { id: true, polymarketFunderAddress: true },
  });
  if (!row) {
    return;
  }
  try {
    const resolved = ethers.utils.getAddress(
      await resolvePolymarketDepositWalletAddress(params.ownerAddress, CONFIG.chainId),
    );
    const stored = (row.polymarketFunderAddress ?? '').toString().trim();
    if (!stored) {
      await prisma.wallet.update({
        where: { id: row.id },
        data: { polymarketFunderAddress: resolved },
      });
      const { invalidateUserClobClientCache } = await import('./polymarketClob.js');
      invalidateUserClobClientCache(params.userId, params.ownerAddress);
      return;
    }
    if (stored.toLowerCase() === resolved.toLowerCase()) {
      return;
    }
    const shouldCorrect = await shouldCorrectStoredDepositFunderMisassignedUups({
      ownerAddress: params.ownerAddress,
      chainId: CONFIG.chainId,
      storedDeposit: stored,
    });
    if (!shouldCorrect) {
      return;
    }
    await prisma.wallet.update({
      where: { id: row.id },
      data: { polymarketFunderAddress: resolved },
    });
    const { invalidateUserClobClientCache } = await import('./polymarketClob.js');
    invalidateUserClobClientCache(params.userId, params.ownerAddress);
    console.warn('[polymarket] corrected deposit funder UUPS→resolved active wallet', {
      userId: params.userId,
      walletId: params.walletId,
      from: stored,
      to: resolved,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[polymarket] auto deposit funder skipped', {
      userId: params.userId,
      walletId: params.walletId,
      msg,
    });
  }
}

async function verifyAuthSignature(params: { address: string; signature: string }) {
  const address = params.address.trim();
  if (!isAddress(address)) {
    throw new Error('Invalid address');
  }
  const sig = params.signature.trim() as `0x${string}`;
  if (!sig.startsWith('0x')) {
    throw new Error('Invalid signature');
  }

  const recovered = await recoverMessageAddress({
    message: POLYMARKET_AUTH_MESSAGE,
    signature: sig,
  });
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error('Signature verification failed');
  }

  return { address, sig };
}

export async function upsertPolymarketCredential(params: {
  userId: number;
  address: string;
  signature: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}): Promise<{ apiKey: string }> {
  const { address } = await verifyAuthSignature({
    address: params.address,
    signature: params.signature,
  });
  await ensureAuthorizationOwnerAddress(params.userId, address);
  const { walletId } = await getExecutionWalletForUser(params.userId, params.address);

  const creds: ApiKeyCreds = {
    key: params.apiKey.trim(),
    secret: params.apiSecret.trim(),
    passphrase: params.passphrase.trim(),
  };
  await upsertClobApiCredentialsForWallet({ userId: params.userId, walletId, creds });
  await ensureCustodialDepositFunderAfterClobUpsert({
    userId: params.userId,
    walletId,
    ownerAddress: address,
  });
  const { invalidateUserClobClientCache } = await import('./polymarketClob.js');
  invalidateUserClobClientCache(params.userId, address);
  return { apiKey: creds.key };
}

function hasPolyCreds(): boolean {
  return !!(CONFIG.polyApiKey && CONFIG.polySecret && CONFIG.polyPassphrase);
}

function getCredsFromEnv(): ApiKeyCreds {
  return {
    key: CONFIG.polyApiKey,
    secret: CONFIG.polySecret,
    passphrase: CONFIG.polyPassphrase,
  };
}

export async function deriveAndUpsertPolymarketCredentialForUser(params: {
  userId: number;
  address: string;
  signature: string;
}): Promise<{ apiKey: string }> {
  const { address } = await verifyAuthSignature({ address: params.address, signature: params.signature });
  await ensureAuthorizationOwnerAddress(params.userId, address);

  const executionCtx = await getExecutionWalletForUser(params.userId, params.address);
  const { walletClient, walletId } = executionCtx;
  authClobTrace('B0_auth_derive_start', {
    userId: params.userId,
    verifiedOwner: address,
    executionAddress: executionCtx.address,
    walletId,
    clobHost: CONFIG.clobHost,
    usingPlatformPolyEnvCreds: hasPolyCreds(),
  });

  let creds: ApiKeyCreds;
  if (hasPolyCreds()) {
    creds = getCredsFromEnv();
  } else {
    let depositAddr = (executionCtx.polymarketFunderAddress ?? '').trim();
    if (!depositAddr) {
      depositAddr = ethers.utils.getAddress(
        await resolvePolymarketDepositWalletAddress(executionCtx.address, CONFIG.chainId),
      );
    }
    const usesDepositFlow =
      Boolean(depositAddr) && depositAddr.toLowerCase() !== executionCtx.address.toLowerCase();
    /**
     * 与 polymarketClob.getOrCreateUserClobBundle 一致：createOrDeriveApiKey 使用 viem walletClient。
     * 使用 ethers GoRemoteEthersSigner 时，EIP-712 编码/签名与 viem 路径可能不一致，CLOB 会 400「Could not create api key」。
     */
    const baseTemp = {
      host: CONFIG.clobHost,
      chain: CONFIG.chainId as Chain,
      signer: walletClient as any,
      useServerTime: true,
      retryOnError: true,
      throwOnError: true,
    };
    const tempClient = new ClobClient(
      usesDepositFlow
        ? {
            ...baseTemp,
            signatureType: SignatureTypeV2.POLY_1271,
            funderAddress: ethers.utils.getAddress(depositAddr),
          }
        : baseTemp
    );
    authClobTrace('B1_auth_exchange_l1_input', {
      userId: params.userId,
      usesDepositFlow,
      depositAddrResolved: usesDepositFlow ? ethers.utils.getAddress(depositAddr) : null,
      executionAddress: executionCtx.address,
    });
    creds = await exchangeClobL1ApiKeyCreateOrDerive(tempClient);
    authClobTrace('B2_auth_exchange_l1_ok', { userId: params.userId, maskApiKey: maskApiKeyPreview(creds.key) });
  }
  assertNonEmptyCreds(creds);

  await upsertClobApiCredentialsForWallet({ userId: params.userId, walletId, creds });
  await ensureCustodialDepositFunderAfterClobUpsert({
    userId: params.userId,
    walletId,
    ownerAddress: address,
  });
  const { invalidateUserClobClientCache } = await import('./polymarketClob.js');
  /** 清除该用户全部 CLOB bundle（含历史上以 deposit 为 addrKey 的旧缓存）。 */
  invalidateUserClobClientCache(params.userId);
  authClobTrace('B3_auth_invalidate_all_user_clob_cache', { userId: params.userId });
  return { apiKey: creds.key ?? '' };
}

export async function getPolymarketCredentialStatus(
  userId: number,
  expectedAddress?: string
): Promise<{
  bound: boolean;
  walletAddress?: string;
  polymarketFunderAddress?: string | null;
}> {
  const execution = await getExecutionWalletForUser(userId, expectedAddress).catch(() => null);
  const row = execution
    ? await prisma.apiCredential.findUnique({
        where: { walletId: execution.walletId },
        select: { apiKey: true },
      })
    : await prisma.apiCredential.findFirst({
        where: { userId },
        select: {
          apiKey: true,
          wallet: { select: { id: true, address: true, polymarketFunderAddress: true } },
        },
        orderBy: { updatedAt: 'desc' },
      } as any);
  if (!row) return { bound: false };

  const walletAddress = execution?.address ?? (row as any).wallet?.address;
  let polymarketFunderAddress: string | null | undefined;
  if (execution) {
    const w = await prisma.wallet.findUnique({
      where: { id: execution.walletId },
      select: { polymarketFunderAddress: true },
    });
    polymarketFunderAddress = w?.polymarketFunderAddress ?? null;
  } else {
    polymarketFunderAddress = (row as any).wallet?.polymarketFunderAddress ?? null;
  }

  return {
    bound: true,
    walletAddress,
    polymarketFunderAddress,
  };
}
