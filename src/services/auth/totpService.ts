import type { Request } from 'express';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { normalizeInviteCode } from '../../lib/inviteCode';
import { createAppError } from '../../utils/appError';
import { Code } from '../../utils/response';
import { isEmailProviderConfigured } from '../email/emailSender';
import {
  goTotpConfirm,
  goTotpDisable,
  goTotpSetup,
  goTotpStatus,
  goTotpVerifyWithdraw,
  isGoWalletCustodyConfigured,
  type GoTotpIdentity,
  type GoWithdrawIntent,
} from '../walletApi/goWalletClient';
import {
  recordTotpDisabled,
  recordTotpEnabled,
  recordTotpSetupStarted,
  recordTotpVerifyFailed,
  recordTotpVerifySuccess,
} from '../audit/totpAudit';
import { STEP_UP_PURPOSE } from '../../lib/stepUpTypes';

export type TwoFactorStatus = {
  totpEnabled: boolean;
  passkeyEnabled: boolean;
  emailOtpAvailable: boolean;
  preferredMethod: 'totp' | 'passkey' | 'email_otp';
};

export type WithdrawAuthorizationInput = {
  to: string;
  amount: string;
  idempotencyKey: string;
};

function goUnavailable(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return createAppError({
    code: Code.DEPENDENCY_UNAVAILABLE,
    httpStatus: 503,
    message: 'Authenticator service is unavailable',
    details: { reasonCode: 'GO_WALLET_TOTP_UNAVAILABLE', cause: message.slice(0, 300) },
  });
}

function assertGoConfigured(): void {
  if (!isGoWalletCustodyConfigured()) {
    throw goUnavailable('GO_WALLET_* is not configured');
  }
}

/**
 * TOTP identity only needs refer_code + walletIndex (+ optional funder).
 * Do not load wallet_password here — that breaks status/setup when the password
 * row is still an old encrypted derivation credential pending data backfill.
 */
async function getUserIdentity(userId: number): Promise<{
  identity: GoTotpIdentity;
  accountLabel: string;
  depositWallet: string | null;
}> {
  assertGoConfigured();
  const [user, wallets] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, username: true, inviteCode: true },
    }),
    prisma.wallet.findMany({
      where: { userId, type: 'CUSTODIAL' } as any,
      orderBy: { createdAt: 'asc' },
      select: {
        walletIndex: true,
        signingProvider: true,
        polymarketFunderAddress: true,
      },
    }),
  ]);
  if (!user) {
    throw createAppError({
      code: Code.NOT_FOUND,
      httpStatus: 404,
      message: 'User not found',
    });
  }
  const wallet =
    wallets.find((w) => (w.polymarketFunderAddress ?? '').trim().length > 0) ?? wallets[0];
  if (!wallet) {
    throw createAppError({
      code: Code.STATE_CONFLICT,
      httpStatus: 409,
      message: 'Open a custodial wallet first',
    });
  }
  if (String(wallet.signingProvider ?? '') !== 'GO_REMOTE') {
    throw goUnavailable('Custodial wallet is not GO_REMOTE');
  }
  if (wallet.walletIndex == null || !Number.isFinite(Number(wallet.walletIndex))) {
    throw goUnavailable('GO_REMOTE wallet is missing walletIndex');
  }
  const referCode = normalizeInviteCode(user.inviteCode);
  if (!referCode) {
    throw goUnavailable('User invite code is missing for wallet refer_code');
  }
  const depositWallet = (wallet.polymarketFunderAddress ?? '').trim();
  return {
    identity: {
      refer_code: referCode,
      walletIndex: Number(wallet.walletIndex),
    },
    accountLabel: user.email?.trim().toLowerCase() || user.username,
    depositWallet: depositWallet ? getAddress(depositWallet) : null,
  };
}

async function callGo<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw goUnavailable(error);
  }
}

export function normalizeWithdrawAuthorizationInput(
  input: WithdrawAuthorizationInput,
): WithdrawAuthorizationInput {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw createAppError({
      code: Code.VALIDATION_FAILED,
      httpStatus: 400,
      message: 'idempotencyKey is required',
    });
  }
  let amount: string;
  try {
    const amountInput = input.amount.trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(amountInput)) {
      throw new Error('invalid decimal precision');
    }
    const amountRaw = parseUnits(amountInput, 6);
    if (amountRaw <= 0n) throw new Error('non-positive');
    amount = formatUnits(amountRaw, 6);
  } catch {
    throw createAppError({
      code: Code.VALIDATION_FAILED,
      httpStatus: 400,
      message: 'Invalid amount',
    });
  }
  let to: string;
  try {
    to = getAddress(input.to.trim());
  } catch {
    throw createAppError({
      code: Code.VALIDATION_FAILED,
      httpStatus: 400,
      message: 'Invalid withdrawal address',
    });
  }
  return { to, amount, idempotencyKey };
}

export async function buildGoWithdrawIntent(
  userId: number,
  input: WithdrawAuthorizationInput,
): Promise<GoWithdrawIntent> {
  const normalized = normalizeWithdrawAuthorizationInput(input);
  const { identity, depositWallet } = await getUserIdentity(userId);
  if (!depositWallet) {
    throw createAppError({
      code: Code.STATE_CONFLICT,
      httpStatus: 409,
      message: 'Polymarket deposit wallet is not configured',
    });
  }
  return {
    ...identity,
    network: 'Polygon',
    depositWallet,
    asset: 'USDC.e',
    ...normalized,
  };
}

export async function getTwoFactorStatus(userId: number): Promise<TwoFactorStatus> {
  const [{ identity }, user, passkeyCount] = await Promise.all([
    getUserIdentity(userId),
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    }),
    prisma.passkeyCredential.count({ where: { userId } }),
  ]);
  if (!user) {
    throw createAppError({ code: Code.NOT_FOUND, httpStatus: 404, message: 'User not found' });
  }
  const { totpEnabled } = await callGo(() => goTotpStatus(identity));
  const passkeyEnabled = passkeyCount > 0;
  const emailOtpAvailable =
    Boolean(user.email && user.emailVerified) && isEmailProviderConfigured();
  return {
    totpEnabled,
    passkeyEnabled,
    emailOtpAvailable,
    preferredMethod: totpEnabled ? 'totp' : passkeyEnabled ? 'passkey' : 'email_otp',
  };
}

export async function assertGoTotpEnabledForUser(userId: number): Promise<void> {
  const { identity } = await getUserIdentity(userId);
  const { totpEnabled } = await callGo(() => goTotpStatus(identity));
  if (!totpEnabled) {
    throw createAppError({
      code: Code.TOTP_NOT_ENABLED,
      httpStatus: 403,
      message: 'Authenticator is not enabled',
    });
  }
}

export async function setupTotp(
  userId: number,
  req?: Request,
): Promise<{ otpauthUrl: string; manualEntryKey: string; expiresIn: number }> {
  const { identity, accountLabel } = await getUserIdentity(userId);
  const result = await callGo(() =>
    goTotpSetup({ ...identity, accountLabel, issuer: CONFIG.totpIssuer }),
  );
  await recordTotpSetupStarted({ userId, req });
  return result;
}

export async function confirmTotp(
  userId: number,
  code: string,
  _ip: string,
  req?: Request,
): Promise<{ totpEnabled: boolean }> {
  const { identity } = await getUserIdentity(userId);
  const result = await callGo(() => goTotpConfirm({ ...identity, code }));
  await recordTotpEnabled({ userId, req });
  return result;
}

export async function verifyTotpForWithdraw(
  userId: number,
  code: string,
  input: WithdrawAuthorizationInput,
  _ip: string,
  req?: Request,
): Promise<{ authorization: string; expiresIn?: number }> {
  const intent = await buildGoWithdrawIntent(userId, input);
  try {
    const result = await callGo(() => goTotpVerifyWithdraw({ ...intent, code }));
    await recordTotpVerifySuccess({ userId, purpose: STEP_UP_PURPOSE.WITHDRAW, req });
    return result;
  } catch (error) {
    await recordTotpVerifyFailed({
      userId,
      purpose: STEP_UP_PURPOSE.WITHDRAW,
      reasonCode: 'GO_TOTP_VERIFY_FAILED',
      req,
    }).catch(() => undefined);
    throw error;
  }
}

export async function disableTotp(
  userId: number,
  code: string,
  _ip: string,
  req?: Request,
): Promise<{ totpEnabled: boolean }> {
  const { identity } = await getUserIdentity(userId);
  const result = await callGo(() => goTotpDisable({ ...identity, code }));
  await recordTotpDisabled({ userId, req });
  return result;
}
