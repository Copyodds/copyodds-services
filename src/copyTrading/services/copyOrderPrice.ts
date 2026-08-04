import { Prisma } from '../../generated/prisma/client';

const PRICE_EPS = 1e-9;
const MIN_OUTCOME_PRICE = 0.01;
const MAX_OUTCOME_PRICE = 0.99;

function clampOutcomePrice(price: number): number {
  return Math.min(MAX_OUTCOME_PRICE, Math.max(MIN_OUTCOME_PRICE, price));
}

export function parseSubscriptionSlippage(
  slippage: Prisma.Decimal | null | undefined
): number | null {
  if (slippage == null) return null;
  const n = Number(slippage.toString());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 跟单成交价：虚拟单与 leader 监听价一致；真实单在 leader 价上加滑点。 */
export function resolveCopyOrderPrice(
  leaderPrice: number,
  side: 'BUY' | 'SELL',
  slippage: number | null
): number {
  return applyCopySlippageToPrice(leaderPrice, side, slippage);
}

/** 买单加价、卖单降价，与 leader 成交价对齐的跟单可成交限价 */
export function applyCopySlippageToPrice(
  leaderPrice: number,
  side: 'BUY' | 'SELL',
  slippage: number | null
): number {
  if (!(leaderPrice > 0) || !Number.isFinite(leaderPrice)) return leaderPrice;
  if (slippage == null || slippage <= 0) return clampOutcomePrice(leaderPrice);

  const adjusted =
    side === 'BUY' ? leaderPrice * (1 + slippage) : leaderPrice * (1 - slippage);

  return clampOutcomePrice(adjusted);
}

/** 风控与额度统计用名义金额：按实际限价（含滑点）估算 */
export function computeCopyRiskNotionalUsd(params: {
  size: number;
  orderPrice: number;
}): number {
  const { size, orderPrice } = params;
  if (!(size > 0) || !(orderPrice > 0)) return 0;
  return size * orderPrice;
}

export function isCopyOrderPriceWithinSlippage(params: {
  side: 'BUY' | 'SELL';
  leaderPrice: number;
  orderPrice: number;
  slippage: number | null;
}): boolean {
  const { side, leaderPrice, orderPrice, slippage } = params;
  if (slippage == null || slippage <= 0) return true;
  if (!(leaderPrice > 0) || !Number.isFinite(leaderPrice)) return true;
  if (!Number.isFinite(orderPrice)) return false;

  if (side === 'BUY') {
    return (
      orderPrice + PRICE_EPS >= leaderPrice &&
      orderPrice <= leaderPrice * (1 + slippage) + PRICE_EPS
    );
  }

  return (
    orderPrice <= leaderPrice + PRICE_EPS &&
    orderPrice + PRICE_EPS >= leaderPrice * (1 - slippage)
  );
}
