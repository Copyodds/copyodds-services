import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { SHARE_TO_X_GAS_REWARD } from '../../config/gas';
import { appendBillingLedgerEntry, BILLING_ENTRY_TYPE } from '../ledger/billingLedger';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from '../custody/userWalletLedger';
import { createAppError, createValidationError } from '../../utils/appError';
import { Code } from '../../utils/response';
import { resumeUserCopyTradingPausedForGas } from '../../copyTrading/services/copyFundingMonitor';
import { utcClaimDate } from './shareToXDate';

export { utcClaimDate } from './shareToXDate';

export const SHARE_TO_X_SOURCE_TYPE = 'SHARE_TO_X';
export const SHARE_TO_X_BALANCE_LOG_TYPE = 'SHARE_TO_X';

function normalizeOptionalWallet(wallet: string | null | undefined): string | null {
  if (wallet == null) return null;
  const trimmed = wallet.trim();
  if (!trimmed) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw createValidationError({ field: 'wallet' }, 'Invalid wallet address');
  }
  return trimmed.toLowerCase();
}

export async function getShareToXStatus(userId: number, at = new Date()) {
  const claimDate = utcClaimDate(at);
  const existing = await prisma.shareToXGasClaim.findUnique({
    where: {
      userId_claimDate: { userId, claimDate },
    },
    select: { id: true, gasAmount: true, createdAt: true },
  });

  return {
    claimedToday: existing != null,
    rewardGas: SHARE_TO_X_GAS_REWARD,
    claimDate: claimDate.toISOString().slice(0, 10),
    claimId: existing?.id ?? null,
    claimedAt: existing?.createdAt?.toISOString() ?? null,
  };
}

export async function claimShareToXGas(options: {
  userId: number;
  wallet?: string | null;
  at?: Date;
}) {
  const at = options.at ?? new Date();
  const claimDate = utcClaimDate(at);
  const wallet = normalizeOptionalWallet(options.wallet);
  const gasAmount = new Prisma.Decimal(SHARE_TO_X_GAS_REWARD);
  const claimId = randomUUID();

  let result: {
    claimId: string;
    gasAmount: Prisma.Decimal;
    gasBalance: Prisma.Decimal;
    claimDate: Date;
  };

  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.shareToXGasClaim.create({
        data: {
          id: claimId,
          userId: options.userId,
          wallet,
          gasAmount,
          claimDate,
        },
      });

      const updatedUser = await tx.user.update({
        where: { id: options.userId },
        data: {
          gasBalance: { increment: gasAmount },
        },
        select: { gasBalance: true },
      });

      await tx.gasBalanceLog.create({
        data: {
          userId: options.userId,
          change: gasAmount,
          type: SHARE_TO_X_BALANCE_LOG_TYPE,
          sourceType: SHARE_TO_X_SOURCE_TYPE,
          sourceOrderId: claimId,
        },
      });

      await appendBillingLedgerEntry(
        {
          userId: options.userId,
          entryType: BILLING_ENTRY_TYPE.SHARE_TO_X_GAS,
          sourceType: SHARE_TO_X_SOURCE_TYPE,
          sourceOrderId: claimId,
          amount: gasAmount,
          balanceAfter: updatedUser.gasBalance,
          currency: 'GAS',
          note: 'Share to X daily GAS reward',
          metadata: {
            wallet,
            claimDate: claimDate.toISOString().slice(0, 10),
          },
        },
        tx,
      );

      await appendUserWalletLedger(
        {
          userId: options.userId,
          rail: WALLET_LEDGER_RAIL.GAS_POINTS,
          direction: WALLET_LEDGER_DIRECTION.CREDIT,
          amount: gasAmount,
          symbol: 'GAS',
          category: WALLET_LEDGER_CATEGORY.SHARE_TO_X_GAS,
          refType: 'ShareToXGasClaim',
          refId: claimId,
          idempotencyKey: `share-to-x-${claimId}`,
          balanceAfter: updatedUser.gasBalance,
          metadata: {
            wallet,
            claimDate: claimDate.toISOString().slice(0, 10),
          },
        },
        tx,
      );

      return {
        claimId,
        gasAmount,
        gasBalance: updatedUser.gasBalance,
        claimDate,
      };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw createAppError({
        code: Code.SHARE_TO_X_ALREADY_CLAIMED,
        httpStatus: 409,
        message: 'Share to X GAS already claimed today',
        details: {
          errorCode: 'share_to_x_already_claimed',
          reasonCode: 'share_to_x_already_claimed',
        },
      });
    }
    throw err;
  }

  try {
    await resumeUserCopyTradingPausedForGas({ userId: options.userId });
  } catch (err) {
    console.warn('[share-to-x] resume copy trading after gas credit failed', err);
  }

  return {
    claimId: result.claimId,
    gasAmount: result.gasAmount.toString(),
    gasBalance: result.gasBalance.toString(),
    claimDate: result.claimDate.toISOString().slice(0, 10),
    rewardGas: SHARE_TO_X_GAS_REWARD,
  };
}
