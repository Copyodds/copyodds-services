import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { scheduleTryAutoWrapPolymarketDepositUsdce } from '../polymarket/polymarketDepositAutoWrap';

export type PrismaClientLike = Prisma.TransactionClient | typeof prisma;

export const WALLET_LEDGER_RAIL = {
  ONCHAIN_USDC: 'ONCHAIN_USDC',
  INTERNAL_USDC_E: 'INTERNAL_USDC_E',
  GAS_POINTS: 'GAS_POINTS',
} as const;

export const WALLET_LEDGER_DIRECTION = {
  CREDIT: 'CREDIT',
  DEBIT: 'DEBIT',
  LOCK: 'LOCK',
  UNLOCK: 'UNLOCK',
} as const;

/** 稳定 category 字符串，与产品/筛选一致 */
export const WALLET_LEDGER_CATEGORY = {
  CHAIN_DEPOSIT: 'CHAIN_DEPOSIT',
  CHAIN_WITHDRAW: 'CHAIN_WITHDRAW',
  PAYMENT_TOPUP: 'PAYMENT_TOPUP',
  CUSTODY_CREDIT: 'CUSTODY_CREDIT',
  PACKAGE_PURCHASE: 'PACKAGE_PURCHASE',
  PACKAGE_FULFILL_GAS: 'PACKAGE_FULFILL_GAS',
  AFFILIATE_TIER_ACTIVATION_PURCHASE: 'AFFILIATE_TIER_ACTIVATION_PURCHASE',
  GAS_RECHARGE: 'GAS_RECHARGE',
  SHARE_TO_X_GAS: 'SHARE_TO_X_GAS',
  GAS_SPEND: 'GAS_SPEND',
  COMMISSION_GAS: 'COMMISSION_GAS',
  COMMISSION_INTERNAL_USD: 'COMMISSION_INTERNAL_USD',
  COMMISSION_ONCHAIN_USDC: 'COMMISSION_ONCHAIN_USDC',
  COPY_RESERVE: 'COPY_RESERVE',
  COPY_RELEASE: 'COPY_RELEASE',
  /** 托管地址 → Polymarket deposit（POLY_1271）链上 USDC.e 划转 */
  POLYMARKET_DEPOSIT: 'POLYMARKET_DEPOSIT',
  /** Polymarket deposit → 托管地址（relayer WALLET batch USDC.e transfer） */
  POLYMARKET_DEPOSIT_RETURN: 'POLYMARKET_DEPOSIT_RETURN',
  /** Polymarket deposit → 用户指定地址（relayer WALLET batch USDC.e transfer） */
  POLYMARKET_DEPOSIT_EXTERNAL: 'POLYMARKET_DEPOSIT_EXTERNAL',
  /** 外部地址直接链上 USDC.e 转入 Polymarket 保证金地址（非托管地址划出；与 POLYMARKET_DEPOSIT 互斥展示） */
  POLYMARKET_FUNDER_CHAIN_DEPOSIT: 'POLYMARKET_FUNDER_CHAIN_DEPOSIT',
  POLYMARKET_REDEEM: 'POLYMARKET_REDEEM',
} as const;

export type AppendUserWalletLedgerInput = {
  userId: number;
  occurredAt?: Date;
  rail: string;
  direction: string;
  amount: Prisma.Decimal | number | string;
  symbol?: string;
  category: string;
  refType?: string | null;
  refId?: string | null;
  idempotencyKey?: string | null;
  balanceAfter?: Prisma.Decimal | number | string | null;
  metadata?: Prisma.InputJsonValue;
};

function toDecimal(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/**
 * Append-only 流水；若提供 idempotencyKey 且已存在则跳过（返回已有行）。
 */
export async function appendUserWalletLedger(
  input: AppendUserWalletLedgerInput,
  client: PrismaClientLike = prisma,
): Promise<{ created: boolean; id: string }> {
  const shouldScheduleAutoWrap = (category: string) =>
    category === WALLET_LEDGER_CATEGORY.POLYMARKET_DEPOSIT ||
    category === WALLET_LEDGER_CATEGORY.POLYMARKET_FUNDER_CHAIN_DEPOSIT ||
    category === WALLET_LEDGER_CATEGORY.POLYMARKET_REDEEM;

  if (input.idempotencyKey) {
    const existing = await client.userWalletLedger.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      return { created: false, id: existing.id };
    }
  }

  const row = await client.userWalletLedger.create({
    data: {
      userId: input.userId,
      occurredAt: input.occurredAt ?? new Date(),
      rail: input.rail,
      direction: input.direction,
      amount: toDecimal(input.amount),
      symbol: input.symbol ?? 'USDC.e',
      category: input.category,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      balanceAfter: input.balanceAfter == null ? null : toDecimal(input.balanceAfter),
      metadata: input.metadata ?? undefined,
    },
    select: { id: true },
  });
  if (shouldScheduleAutoWrap(input.category)) {
    scheduleTryAutoWrapPolymarketDepositUsdce(
      input.userId,
      `wallet_ledger:${input.category}:${input.refType ?? ''}:${input.refId ?? ''}`,
    );
  }
  return { created: true, id: row.id };
}
