import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';

type DecimalLike = Prisma.Decimal | number | string;
type PrismaClientLike = Prisma.TransactionClient | typeof prisma;

export const BILLING_ENTRY_TYPE = {
  GAS_RECHARGE: 'GAS_RECHARGE',
  GAS_SPEND: 'GAS_SPEND',
  PACKAGE_ORDER_CREATED: 'PACKAGE_ORDER_CREATED',
  PACKAGE_ORDER_CONFIRMED: 'PACKAGE_ORDER_CONFIRMED',
  PACKAGE_ORDER_FULFILLED: 'PACKAGE_ORDER_FULFILLED',
  AFFILIATE_TIER_ORDER_CREATED: 'AFFILIATE_TIER_ORDER_CREATED',
  AFFILIATE_TIER_ORDER_CONFIRMED: 'AFFILIATE_TIER_ORDER_CONFIRMED',
  AFFILIATE_TIER_ACTIVATED: 'AFFILIATE_TIER_ACTIVATED',
  AFFILIATE_TIER_BONUS_FROM_GAS_PACKAGE: 'AFFILIATE_TIER_BONUS_FROM_GAS_PACKAGE',
  COMMISSION_SETTLED: 'COMMISSION_SETTLED',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
  /** 支付网关回调入账站内 USDC.e（跟单/商城账本） */
  PAYMENT_TOPUP: 'PAYMENT_TOPUP',
  /** Share to X 每日 GAS 奖励 */
  SHARE_TO_X_GAS: 'SHARE_TO_X_GAS',
} as const;

function toDecimal(value: DecimalLike): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(value);
}

export async function appendBillingLedgerEntry(
  input: {
    userId: number;
    entryType: string;
    sourceType: string;
    amount: DecimalLike;
    sourceOrderId?: string | null;
    balanceAfter?: DecimalLike | null;
    currency?: string;
    ruleVersion?: string | null;
    note?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
  client: PrismaClientLike = prisma
) {
  return client.billingLedger.create({
    data: {
      userId: input.userId,
      entryType: input.entryType,
      sourceType: input.sourceType,
      sourceOrderId: input.sourceOrderId ?? null,
      amount: toDecimal(input.amount),
      balanceAfter: input.balanceAfter == null ? null : toDecimal(input.balanceAfter),
      currency: input.currency ?? 'USD',
      ruleVersion: input.ruleVersion ?? null,
      note: input.note ?? null,
      metadata: input.metadata ?? undefined,
    },
  });
}
