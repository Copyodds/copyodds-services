import { Prisma } from '../generated/prisma/client';

/** 每 1 USDC 对应多少 Gas 点数（充值与下单折算共用） */
export const GAS_EXCHANGE_RATE = 100;

/** Share to X 每日首次领取奖励（GAS 点数） */
export const SHARE_TO_X_GAS_REWARD = 100;

/** 下单按名义金额收取的比例（0.5%） */
export const ORDER_NOTIONAL_FEE_RATE = 0.005;

type DecimalLike = Prisma.Decimal | number | string;

/**
 * 下单需扣除的 Gas：名义 USDC × 手续费比例 × 每 USDC 的 Gas 数。
 * 例：100 USDC 名义 → 0.5 USDC 等价 → 50 Gas。
 */
export function computeOrderGasCost(notionalUsd: DecimalLike): Prisma.Decimal {
  const n =
    notionalUsd instanceof Prisma.Decimal ? notionalUsd : new Prisma.Decimal(notionalUsd);
  if (n.lte(0)) {
    return new Prisma.Decimal(0);
  }
  return n.mul(ORDER_NOTIONAL_FEE_RATE).mul(GAS_EXCHANGE_RATE);
}

// 旧版按层固定比例（已不再用于计算金额，仅作历史参考）
export const COMMISSION_LEVEL_RATES = [0.2, 0.1, 0.05, 0.03, 0.02] as const;

/** 差额分佣向上追溯层数，与最高合伙人档位 L8 对齐 */
export const MAX_COMMISSION_LEVEL = 8;

// 合伙人档位：L1~L8 对应的目标总分成比例（相对于下级消费的 USDC）
// L1=0.1, L2=0.2, L3=0.3, L4=0.4, L5=0.5, L6=0.6, L7=0.7, L8=0.8
export const AFFILIATE_TIER_RATES: Record<number, number> = {
  1: 0.1,
  2: 0.2,
  3: 0.3,
  4: 0.4,
  5: 0.5,
  6: 0.6,
  7: 0.7,
  8: 0.8,
};
