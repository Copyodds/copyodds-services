import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import {
  AFFILIATE_TIER_RATES,
  computeOrderGasCost,
  GAS_EXCHANGE_RATE,
  MAX_COMMISSION_LEVEL,
} from '../../config/gas';
import { appendBillingLedgerEntry, BILLING_ENTRY_TYPE } from '../ledger/billingLedger';
import {
  CUSTODY_USDC_SYMBOL,
  getPolymarketFunderAddressForUser,
  resolveCustodyTreasuryAddress,
} from '../custody/custody';
import { createConflictError } from '../../utils/appError';
import { parseUnits } from 'viem';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from '../custody/userWalletLedger';
import { resumeUserCopyTradingPausedForGas } from '../../copyTrading/services/copyFundingMonitor';
import { goTreasuryPayoutUsdce } from '../walletApi/goWalletClient';

type DecimalLike = Prisma.Decimal | number | string;
type PrismaClientLike = Prisma.TransactionClient | typeof prisma;
type AffiliateUplineUser = { id: number; affiliateTier: number | null };
type CommissionPlanItem = {
  toUserId: number;
  level: number;
  commissionAmount: Prisma.Decimal;
  tierAtTheTime: number | null;
  rateAtTheTime: Prisma.Decimal;
};

export const COMMISSION_RULE_VERSION = 'affiliate_v1';
export const COMMISSION_SOURCE_TYPE = {
  GAS_RECHARGE: 'GAS_RECHARGE',
  MALL_ORDER: 'MALL_ORDER',
  AFFILIATE_TIER_ORDER: 'AFFILIATE_TIER_ORDER',
} as const;

type MallOrderCommissionLink =
  | { orderId: number; affiliateTierOrderId?: undefined }
  | { affiliateTierOrderId: number; orderId?: undefined };

function mallOrderCommissionCreateData(
  link: MallOrderCommissionLink,
  row: {
    fromUserId: number;
    toUserId: number;
    level: number;
    commissionAmount: Prisma.Decimal;
    settlementStatus: string;
    sourceType: string;
    sourceOrderId: string;
    ruleVersion: string;
    tierAtTheTime: number | null;
    rateAtTheTime: Prisma.Decimal;
    settledAt: Date;
    claimedAt?: Date;
  },
) {
  return {
    orderId: link.orderId ?? null,
    affiliateTierOrderId: link.affiliateTierOrderId ?? null,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    level: row.level,
    commissionAmount: row.commissionAmount,
    settlementStatus: row.settlementStatus,
    sourceType: row.sourceType,
    sourceOrderId: row.sourceOrderId,
    ruleVersion: row.ruleVersion,
    tierAtTheTime: row.tierAtTheTime,
    rateAtTheTime: row.rateAtTheTime,
    settledAt: row.settledAt,
    ...(row.claimedAt != null ? { claimedAt: row.claimedAt } : {}),
  };
}

/** Polymarket deposit 支付拆单：上级 deposit + 国库（与 Gas 套餐购买一致）。 */
export async function buildPolymarketDepositCommissionTransferLegs(options: {
  buyerUserId: number;
  distributableAmount: DecimalLike;
  amountUnits: bigint;
  treasuryAddress: string;
}): Promise<{
  transferLegs: { to: string; amountWei: bigint }[];
  uplineDestinations: Record<number, string>;
}> {
  const commissionPlanPreview = await resolveCommissionPlanForUser(
    options.buyerUserId,
    options.distributableAmount,
    prisma,
  );
  const uplineDestinations: Record<number, string> = {};
  const transferLegs: { to: string; amountWei: bigint }[] = [];
  let sumPaidToUplineDepositsWei = 0n;
  for (const item of commissionPlanPreview.items) {
    const commWei = parseUnits(item.commissionAmount.toFixed(6), 6);
    if (commWei <= 0n) {
      continue;
    }
    const uplineDeposit = await getPolymarketFunderAddressForUser(item.toUserId);
    if (uplineDeposit?.trim()) {
      uplineDestinations[item.toUserId] = uplineDeposit;
      transferLegs.push({ to: uplineDeposit, amountWei: commWei });
      sumPaidToUplineDepositsWei += commWei;
    }
  }
  const treasuryWei = options.amountUnits - sumPaidToUplineDepositsWei;
  if (treasuryWei < 0n) {
    throw createConflictError('分佣金额舍入异常，超过订单支付金额', {
      reasonCode: 'COMMISSION_WEI_OVERFLOW',
    });
  }
  if (treasuryWei > 0n) {
    transferLegs.push({ to: options.treasuryAddress, amountWei: treasuryWei });
  }
  let sumLegs = 0n;
  for (const leg of transferLegs) {
    sumLegs += leg.amountWei;
  }
  if (sumLegs !== options.amountUnits) {
    throw new Error('internal: Polymarket purchase split legs do not sum to payment wei');
  }
  return { transferLegs, uplineDestinations };
}

/** GasBalanceLog.type / billing source for trade order fee */
export const GAS_BALANCE_LOG_TYPE_ORDER = 'SPEND_FOR_ORDER';
export const BILLING_SOURCE_TRADE_ORDER = 'TRADE_ORDER';
/** GasBalanceLog.type / billing source for manual redeem fee */
export const GAS_BALANCE_LOG_TYPE_REDEEM = 'SPEND_FOR_REDEEM';
export const BILLING_SOURCE_MANUAL_REDEEM = 'MANUAL_REDEEM';

export const MALL_COMMISSION_ENTRY_TYPE = {
  SETTLEMENT: 'SETTLEMENT',
  REVERSAL: 'REVERSAL',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;

export const REFERRAL_BIND_SOURCE = {
  REGISTER: 'REGISTER',
  LEGACY: 'LEGACY',
} as const;

export const REFERRAL_BIND_STATUS = {
  SUCCESS: 'SUCCESS',
  INVALID_INVITE_CODE: 'INVALID_INVITE_CODE',
  INVALID_REFERRER_CHAIN: 'INVALID_REFERRER_CHAIN',
} as const;
export class ReferralBindingError extends Error {
  constructor(
    public readonly status: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReferralBindingError';
  }
}

import { normalizeInviteCode } from '../../lib/inviteCode';
import { applyAffiliateTierAutoUpgradeCascade } from '../affiliate/affiliateTierAutoUpgrade';

export { normalizeInviteCode };

function toDecimal(value: DecimalLike): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(value);
}

export async function getAffiliateUplineUsers(
  userId: number,
  client: PrismaClientLike = prisma,
): Promise<AffiliateUplineUser[]> {
  const uplineUsers: AffiliateUplineUser[] = [];
  let currentUserId: number | null = userId;

  for (let level = 1; level <= MAX_COMMISSION_LEVEL && currentUserId != null; level += 1) {
    const currentUser: { referrerId: number | null } | null = await (client as any).user.findUnique({
      where: { id: currentUserId },
      select: {
        referrerId: true,
      },
    });

    currentUserId = currentUser?.referrerId ?? null;
    if (currentUserId == null) {
      break;
    }

    const upline = await (client as any).user.findUnique({
      where: { id: currentUserId },
      select: {
        id: true,
        affiliateTier: true,
      },
    });

    if (!upline) {
      break;
    }

    uplineUsers.push({
      id: upline.id,
      affiliateTier: upline.affiliateTier ?? null,
    });
  }

  return uplineUsers;
}

export function buildDifferentialCommissionPlan(
  uplineUsers: AffiliateUplineUser[],
  distributableAmount: DecimalLike,
): {
  items: CommissionPlanItem[];
  totalCommissionAmount: Prisma.Decimal;
} {
  const distributable = toDecimal(distributableAmount);
  const tierRates: number[] = uplineUsers.map((u) => (u.affiliateTier ? AFFILIATE_TIER_RATES[u.affiliateTier] ?? 0 : 0));

  let maxRateBelow = 0;
  let totalCommissionAmount = new Prisma.Decimal(0);
  const items: CommissionPlanItem[] = [];

  for (let idx = 0; idx < uplineUsers.length; idx += 1) {
    const targetRate = tierRates[idx] ?? 0;
    const effectiveRate = Math.max(0, targetRate - maxRateBelow);
    maxRateBelow = Math.max(maxRateBelow, targetRate);

    if (effectiveRate <= 0) {
      continue;
    }

    const commissionAmount = distributable.mul(effectiveRate);
    if (commissionAmount.lte(0)) {
      continue;
    }

    items.push({
      toUserId: uplineUsers[idx].id,
      level: idx + 1,
      commissionAmount,
      tierAtTheTime: uplineUsers[idx].affiliateTier,
      rateAtTheTime: new Prisma.Decimal(targetRate),
    });
    totalCommissionAmount = totalCommissionAmount.plus(commissionAmount);
  }

  return {
    items,
    totalCommissionAmount,
  };
}

export async function resolveCommissionPlanForUser(
  userId: number,
  distributableAmount: DecimalLike,
  client: PrismaClientLike = prisma,
): Promise<{
  items: CommissionPlanItem[];
  totalCommissionAmount: Prisma.Decimal;
}> {
  const uplineUsers = await getAffiliateUplineUsers(userId, client);
  return buildDifferentialCommissionPlan(uplineUsers, distributableAmount);
}

export async function createReferralBindingAudit(
  data: {
    userId?: number | null;
    referrerId?: number | null;
    targetEmail?: string | null;
    inviteCodeRaw?: string | null;
    inviteCodeNormalized?: string | null;
    bindSource: string;
    bindStatus: string;
    failureReason?: string | null;
    referralPathSnapshot?: string | null;
    boundAt?: Date | null;
  },
  client: PrismaClientLike = prisma,
) {
  return (client as any).referralBindingAudit.create({
    data: {
      userId: data.userId ?? null,
      referrerId: data.referrerId ?? null,
      targetEmail: data.targetEmail ?? null,
      inviteCodeRaw: data.inviteCodeRaw ?? null,
      inviteCodeNormalized: data.inviteCodeNormalized ?? null,
      bindSource: data.bindSource,
      bindStatus: data.bindStatus,
      failureReason: data.failureReason ?? null,
      referralPathSnapshot: data.referralPathSnapshot ?? null,
      boundAt: data.boundAt ?? null,
    },
  });
}

async function buildReferralPathForReferrer(
  referrerId: number,
  client: PrismaClientLike = prisma,
): Promise<string> {
  const visited = new Set<number>();
  const pathIds: number[] = [];
  let currentId: number | null = referrerId;

  while (currentId != null) {
    if (visited.has(currentId)) {
      throw new ReferralBindingError(
        REFERRAL_BIND_STATUS.INVALID_REFERRER_CHAIN,
        'Invite code points to an invalid referral chain',
      );
    }
    visited.add(currentId);

    const currentUser: { id: number; referrerId: number | null } | null = await (client as any).user.findUnique({
      where: { id: currentId },
      select: {
        id: true,
        referrerId: true,
      },
    });

    if (!currentUser) {
      throw new ReferralBindingError(
        REFERRAL_BIND_STATUS.INVALID_REFERRER_CHAIN,
        'Invite code points to an invalid referral chain',
      );
    }

    pathIds.push(currentUser.id);
    currentId = currentUser.referrerId ?? null;
  }

  return pathIds.reverse().join('>');
}

export async function resolveReferralBindingByInviteCode(
  inviteCode: string,
  client: PrismaClientLike = prisma,
): Promise<{
  normalizedInviteCode: string;
  referrerId: number;
  referralPath: string;
}> {
  const normalizedInviteCode = normalizeInviteCode(inviteCode);
  if (!normalizedInviteCode) {
    throw new ReferralBindingError(
      REFERRAL_BIND_STATUS.INVALID_INVITE_CODE,
      'Invite code is invalid',
    );
  }

  const referrer = await (client as any).user.findUnique({
    where: { inviteCode: normalizedInviteCode },
    select: { id: true },
  });

  if (!referrer) {
    throw new ReferralBindingError(
      REFERRAL_BIND_STATUS.INVALID_INVITE_CODE,
      'Invite code is invalid',
    );
  }

  const referralPath = await buildReferralPathForReferrer(referrer.id, client);

  return {
    normalizedInviteCode,
    referrerId: referrer.id,
    referralPath,
  };
}

export async function spendGasBalance(options: {
  userId: number;
  gasAmount: DecimalLike;
  relatedActionId?: string;
  balanceLogType?: string;
  billingSourceType?: string;
  billingNote?: string;
  allowNegativeBalance?: boolean;
}) {
  const gasAmount = toDecimal(options.gasAmount);
  const balanceLogType = options.balanceLogType ?? 'SPEND_FOR_GAS';
  const billingSourceType = options.billingSourceType ?? 'GAS_BALANCE';
  const billingNote = options.billingNote ?? 'Gas balance spent';

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: options.userId },
    } as any);

    if (!user) {
      throw new Error('User not found');
    }

    const currentGasBalance = (user as any).gasBalance as Prisma.Decimal | undefined;
    if (!options.allowNegativeBalance && (!currentGasBalance || currentGasBalance.lessThan(gasAmount))) {
      throw new Error('Insufficient gas balance');
    }

    const updated = await (tx as any).user.update({
      where: { id: (user as any).id },
      data: {
        gasBalance: {
          decrement: gasAmount,
        },
      },
    });

    await (tx as any).gasBalanceLog.create({
      data: {
        userId: (updated as any).id,
        change: gasAmount.negated(),
        type: balanceLogType,
        sourceType: billingSourceType,
        relatedActionId: options.relatedActionId,
      },
    });

    await appendBillingLedgerEntry(
      {
        userId: (updated as any).id,
        entryType: BILLING_ENTRY_TYPE.GAS_SPEND,
        sourceType: billingSourceType,
        sourceOrderId: options.relatedActionId ?? null,
        amount: gasAmount.negated(),
        balanceAfter: (updated as any).gasBalance,
        currency: 'GAS',
        note: billingNote,
      },
      tx as Prisma.TransactionClient
    );

    const spendKey = options.relatedActionId ?? randomUUID();
    await appendUserWalletLedger(
      {
        userId: (updated as any).id,
        rail: WALLET_LEDGER_RAIL.GAS_POINTS,
        direction: WALLET_LEDGER_DIRECTION.DEBIT,
        amount: gasAmount,
        symbol: 'GAS',
        category: WALLET_LEDGER_CATEGORY.GAS_SPEND,
        refType: billingSourceType,
        refId: options.relatedActionId ?? null,
        idempotencyKey: `wallet-gas-spend-${spendKey}`,
        balanceAfter: (updated as any).gasBalance,
        metadata: { balanceLogType, note: billingNote },
      },
      tx,
    );

    return updated;
  });
}

/**
 * 下单前校验 Gas 是否足够；返回本单将扣除的 Gas（可能为 0）。
 */
export async function assertSufficientGasForTradeOrder(
  userId: number,
  notionalUsd: DecimalLike
): Promise<Prisma.Decimal> {
  const cost = computeOrderGasCost(notionalUsd);
  if (cost.lte(0)) {
    return cost;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { gasBalance: true },
  } as any);

  if (!user) {
    throw new Error('User not found');
  }

  const bal = (user as any).gasBalance as Prisma.Decimal | undefined;
  if (!bal || bal.lessThan(cost)) {
    throw new Error(`Insufficient gas balance: need ${cost.toString()} gas for this order`);
  }

  return cost;
}

/** 下单成功后扣 Gas；notional 仅用于计算扣费金额 */
export async function deductGasForTradeOrder(options: {
  userId: number;
  notionalUsd: DecimalLike;
  polymarketOrderId?: string;
  allowNegativeBalance?: boolean;
}) {
  const gasAmount = computeOrderGasCost(options.notionalUsd);
  if (gasAmount.lte(0)) {
    return null;
  }

  return spendGasBalance({
    userId: options.userId,
    gasAmount,
    relatedActionId: options.polymarketOrderId,
    balanceLogType: GAS_BALANCE_LOG_TYPE_ORDER,
    billingSourceType: BILLING_SOURCE_TRADE_ORDER,
    billingNote: 'Gas spent for trade order',
    allowNegativeBalance: options.allowNegativeBalance,
  });
}

/** 手动赎回计费基数：优先 currentValue，否则 size × curPrice。 */
export function resolveManualRedeemNotionalUsd(position: {
  currentValue?: number;
  size?: number;
  curPrice?: number;
} | null | undefined): number {
  if (!position) return 0;
  const fromValue = Number(position.currentValue);
  if (Number.isFinite(fromValue) && fromValue > 0) return fromValue;
  const size = Number(position.size ?? 0);
  const price = Number(position.curPrice ?? 1);
  if (size > 0 && Number.isFinite(price) && price > 0) return size * price;
  return 0;
}

export async function assertSufficientGasForManualRedeem(
  userId: number,
  notionalUsd: DecimalLike
): Promise<Prisma.Decimal> {
  return assertSufficientGasForTradeOrder(userId, notionalUsd);
}

/** 手动赎回成功后扣 Gas；费率与 CLOB 下单相同（名义 × 0.5% × 100）。 */
export async function deductGasForManualRedeem(options: {
  userId: number;
  notionalUsd: DecimalLike;
  txHash?: string;
}) {
  const gasAmount = computeOrderGasCost(options.notionalUsd);
  if (gasAmount.lte(0)) {
    return null;
  }

  return spendGasBalance({
    userId: options.userId,
    gasAmount,
    relatedActionId: options.txHash,
    balanceLogType: GAS_BALANCE_LOG_TYPE_REDEEM,
    billingSourceType: BILLING_SOURCE_MANUAL_REDEEM,
    billingNote: 'Gas spent for manual redeem',
  });
}

export async function bindReferrerIfNeeded(
  user: any,
  referrerId?: number,
  bindSource: string = REFERRAL_BIND_SOURCE.LEGACY,
) {
  if (!referrerId || user.referrerId) {
    return user;
  }

  if (referrerId === user.id) {
    return user;
  }

  let referralPath: string;
  try {
    referralPath = await buildReferralPathForReferrer(referrerId);
  } catch (error) {
    if (error instanceof ReferralBindingError) {
      return user;
    }
    throw error;
  }

  const boundAt = new Date();

  const updated = await (prisma as any).user.update({
    where: { id: user.id },
    data: {
      referrerId,
      referralPath,
      referrerBoundAt: boundAt,
      referrerBindSource: bindSource,
      referrerLockedAt: boundAt,
    },
  });

  await applyAffiliateTierAutoUpgradeCascade(referrerId);
  return updated;
}

export async function bindReferrerByInviteCodeIfNeeded(
  user: any,
  inviteCode?: string,
  bindSource: string = REFERRAL_BIND_SOURCE.REGISTER,
) {
  const normalizedInviteCode = normalizeInviteCode(inviteCode);
  if (!normalizedInviteCode || user.referrerId) {
    return user;
  }

  let binding: Awaited<ReturnType<typeof resolveReferralBindingByInviteCode>>;
  try {
    binding = await resolveReferralBindingByInviteCode(normalizedInviteCode);
  } catch (error) {
    if (error instanceof ReferralBindingError) {
      return user;
    }
    throw error;
  }

  if (binding.referrerId === user.id) {
    return user;
  }

  return bindReferrerIfNeeded(user, binding.referrerId, bindSource);
}

export async function creditMallCommissionAccount(
  options: {
    userId: number;
    amount: DecimalLike;
    sourceType: string;
    sourceOrderId: string;
    entryType?: string;
    ruleVersion?: string;
    relatedCommissionId?: number;
    note?: string;
  },
  client: PrismaClientLike = prisma,
) {
  const amount = toDecimal(options.amount);
  const updatedAccount = await (client as any).mallCommissionAccount.upsert({
    where: { userId: options.userId },
    update: {
      availableBalance: {
        increment: amount,
      },
      totalEarned: {
        increment: amount,
      },
      totalSettled: {
        increment: amount,
      },
    },
    create: {
      userId: options.userId,
      availableBalance: amount,
      totalEarned: amount,
      totalSettled: amount,
      totalReversed: new Prisma.Decimal(0),
    },
  });

  await (client as any).mallCommissionLedger.create({
    data: {
      accountUserId: options.userId,
      userId: options.userId,
      change: amount,
      balanceAfter: updatedAccount.availableBalance,
      entryType: options.entryType ?? MALL_COMMISSION_ENTRY_TYPE.SETTLEMENT,
      sourceType: options.sourceType,
      sourceOrderId: options.sourceOrderId,
      ruleVersion: options.ruleVersion ?? COMMISSION_RULE_VERSION,
      relatedCommissionId: options.relatedCommissionId,
      note: options.note,
    },
  });

  await appendBillingLedgerEntry(
    {
      userId: options.userId,
      entryType: BILLING_ENTRY_TYPE.COMMISSION_SETTLED,
      sourceType: options.sourceType,
      sourceOrderId: options.sourceOrderId,
      amount,
      balanceAfter: updatedAccount.availableBalance,
      currency: 'USD',
      ruleVersion: options.ruleVersion ?? COMMISSION_RULE_VERSION,
      note: options.note,
      metadata:
        options.relatedCommissionId != null
          ? { relatedCommissionId: options.relatedCommissionId }
          : undefined,
    },
    client
  );

  return updatedAccount;
}

export async function settleMallOrderCommissions(
  options: {
    buyerUserId: number;
    distributableAmount: DecimalLike;
    sourceOrderId: string;
    sourceType?: string;
    ruleVersion?: string;
  } & MallOrderCommissionLink,
  client: PrismaClientLike = prisma,
) {
  const sourceType = options.sourceType ?? COMMISSION_SOURCE_TYPE.MALL_ORDER;
  const sourceOrderId = options.sourceOrderId;
  const ruleVersion = options.ruleVersion ?? COMMISSION_RULE_VERSION;
  const plan = await resolveCommissionPlanForUser(options.buyerUserId, options.distributableAmount, client);
  const settledAt = new Date();
  const link: MallOrderCommissionLink =
    options.affiliateTierOrderId != null
      ? { affiliateTierOrderId: options.affiliateTierOrderId }
      : { orderId: options.orderId! };

  for (const item of plan.items) {
    await (client as any).mallOrderCommission.create({
      data: mallOrderCommissionCreateData(link, {
        fromUserId: options.buyerUserId,
        toUserId: item.toUserId,
        level: item.level,
        commissionAmount: item.commissionAmount,
        settlementStatus: 'SETTLED',
        sourceType,
        sourceOrderId,
        ruleVersion,
        tierAtTheTime: item.tierAtTheTime,
        rateAtTheTime: item.rateAtTheTime,
        settledAt,
      }),
    });
  }

  return plan;
}

/**
 * 领取待领 MallOrderCommission：国库热钱包（Go wallet POST /treasury/payout-usdce）
 * 将合计 USDC.e 打到用户 Polymarket DepositWallet，再标记 claimedAt 并记账。
 */
export async function claimAffiliateCommissions(options: {
  toUserId: number;
  fromUserId?: number;
}): Promise<{
  claimedMallTotal: Prisma.Decimal;
  mallCommissionCount: number;
  destinationAddress: string;
  txHashes: string[];
}> {
  const { toUserId, fromUserId } = options;
  const fromFilter =
    fromUserId != null && Number.isFinite(fromUserId)
      ? { fromUserId: Math.floor(fromUserId) }
      : {};
  const destinationAddress = await getPolymarketFunderAddressForUser(toUserId);
  if (!destinationAddress) {
    throw new Error('Polymarket DepositWallet not found for user');
  }
  // 先解析国库，避免预占 claimedAt 后因配置错误卡住待领记录
  const treasuryAddress = await resolveCustodyTreasuryAddress();

  const mallRows = await (prisma as any).mallOrderCommission.findMany({
    where: {
      toUserId,
      claimedAt: null as any,
      ...fromFilter,
    },
    orderBy: { id: 'asc' },
  });

  let claimedMallTotal = new Prisma.Decimal(0);
  for (const row of mallRows as any[]) {
    claimedMallTotal = claimedMallTotal.plus(row.commissionAmount as Prisma.Decimal);
  }
  if (mallRows.length === 0 || claimedMallTotal.lte(0)) {
    return {
      claimedMallTotal,
      mallCommissionCount: 0,
      destinationAddress,
      txHashes: [],
    };
  }

  const claimIds = (mallRows as any[]).map((row) => row.id as number);
  const claimedAt = new Date();
  const reserved = await (prisma as any).mallOrderCommission.updateMany({
    where: { id: { in: claimIds }, claimedAt: null },
    data: { claimedAt },
  });
  if (reserved.count !== claimIds.length) {
    throw new Error('CONCURRENT_CLAIM_MALL_COMMISSION');
  }

  const amountText = claimedMallTotal.toFixed(6);
  const amountUnits = parseUnits(amountText, 6);

  let txHash: string;
  try {
    const payout = await goTreasuryPayoutUsdce({
      to: destinationAddress,
      amount: amountUnits.toString(),
    });
    txHash = payout.hash;
  } catch (err) {
    await (prisma as any).mallOrderCommission.updateMany({
      where: { id: { in: claimIds }, claimedAt },
      data: { claimedAt: null },
    });
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    for (const row of mallRows as any[]) {
      await appendBillingLedgerEntry(
        {
          userId: row.toUserId,
          entryType: BILLING_ENTRY_TYPE.COMMISSION_SETTLED,
          sourceType: row.sourceType ?? COMMISSION_SOURCE_TYPE.MALL_ORDER,
          sourceOrderId: row.sourceOrderId,
          amount: row.commissionAmount,
          currency: 'USD',
          ruleVersion: row.ruleVersion ?? COMMISSION_RULE_VERSION,
          note: `Affiliate commission paid on-chain (commission id ${row.id})`,
          metadata: {
            relatedCommissionId: row.id,
            destination: destinationAddress,
            txHash,
            payoutSource: treasuryAddress,
            paymentPath: 'TREASURY_PAYOUT',
          },
        },
        tx as Prisma.TransactionClient,
      );

      await appendUserWalletLedger(
        {
          userId: row.toUserId,
          rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
          direction: WALLET_LEDGER_DIRECTION.CREDIT,
          amount: row.commissionAmount,
          symbol: CUSTODY_USDC_SYMBOL,
          category: WALLET_LEDGER_CATEGORY.COMMISSION_ONCHAIN_USDC,
          refType: 'MallOrderCommission',
          refId: String(row.id),
          idempotencyKey: `wallet-commission-mall-onchain-${row.id}`,
          metadata: {
            sourceOrderId: row.sourceOrderId,
            destination: destinationAddress,
            txHash,
            payoutSource: treasuryAddress,
            paymentPath: 'TREASURY_PAYOUT',
          },
        },
        tx,
      );
    }

    return {
      claimedMallTotal,
      mallCommissionCount: mallRows.length,
      destinationAddress,
      txHashes: [String(txHash)],
    };
  });
}

export async function createGasRechargeWithCommissions(options: {
  userId: number;
  amountPaid: DecimalLike;
}) {
  const amountPaid = toDecimal(options.amountPaid);
  const gasPurchasedGross = amountPaid.mul(GAS_EXCHANGE_RATE);

  const order = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: options.userId },
    } as any);

    if (!user) {
      throw new Error('User not found');
    }

    // Gas 直充不产生联盟分佣；分佣仅来自商城套餐订单支付的 USD（见 settleMallOrderCommissions）
    const gasNetToUser = gasPurchasedGross;

    const order = await (tx as any).gasOrder.create({
      data: {
        userId: (user as any).id,
        amountPaid,
        gasPurchasedGross,
        gasNetToUser,
        commissionTotal: new Prisma.Decimal(0),
        sourceType: COMMISSION_SOURCE_TYPE.GAS_RECHARGE,
        commissionRuleVersion: COMMISSION_RULE_VERSION,
        status: 'SUCCESS',
      },
    });

    // 用户到账
    await (tx as any).user.update({
      where: { id: (user as any).id },
      data: {
        gasBalance: {
          increment: gasNetToUser,
        },
      },
    });

    await (tx as any).gasBalanceLog.create({
      data: {
        userId: (user as any).id,
        change: gasNetToUser,
        type: 'RECHARGE_NET',
        sourceType: COMMISSION_SOURCE_TYPE.GAS_RECHARGE,
        sourceOrderId: String(order.id),
        ruleVersion: COMMISSION_RULE_VERSION,
        relatedOrderId: order.id,
      },
    });

    const updatedUser = await (tx as any).user.findUnique({
      where: { id: (user as any).id },
      select: { gasBalance: true },
    });

    await appendBillingLedgerEntry(
      {
        userId: (user as any).id,
        entryType: BILLING_ENTRY_TYPE.GAS_RECHARGE,
        sourceType: COMMISSION_SOURCE_TYPE.GAS_RECHARGE,
        sourceOrderId: String(order.id),
        amount: gasNetToUser,
        balanceAfter: updatedUser?.gasBalance ?? null,
        currency: 'GAS',
        ruleVersion: COMMISSION_RULE_VERSION,
        note: 'Net gas credited after recharge',
      },
      tx as Prisma.TransactionClient
    );

    await appendUserWalletLedger(
      {
        userId: (user as any).id,
        rail: WALLET_LEDGER_RAIL.GAS_POINTS,
        direction: WALLET_LEDGER_DIRECTION.CREDIT,
        amount: gasNetToUser,
        symbol: 'GAS',
        category: WALLET_LEDGER_CATEGORY.GAS_RECHARGE,
        refType: 'GasOrder',
        refId: String(order.id),
        idempotencyKey: `wallet-gas-recharge-${order.id}`,
        balanceAfter: updatedUser?.gasBalance ?? null,
        metadata: { amountPaid: amountPaid.toString() },
      },
      tx,
    );

    const distributableUsdc = amountPaid;

    // 记录本单可分成 USDC，方便报表
    await (tx as any).gasOrder.update({
      where: { id: order.id },
      data: {
        distributableUsdc,
        sourceOrderId: String(order.id),
      },
    });

    return order;
  });

  await resumeUserCopyTradingPausedForGas({ userId: options.userId });

  return order;
}
