/** CLOB postOrder / getOrder 成交量解析（跟单 BUY FAK 市价单依赖此逻辑） */

export type ClobFillSummary = {
  filled: boolean;
  size?: number;
  notional?: number;
  avgPrice?: number;
};

type ClobFillFields = {
  success?: unknown;
  orderID?: unknown;
  status?: unknown;
  transactionsHashes?: unknown;
  tradeIDs?: unknown;
  takingAmount?: unknown;
  makingAmount?: unknown;
  taking_amount?: unknown;
  making_amount?: unknown;
  size_matched?: unknown;
  sizeMatched?: unknown;
  price?: unknown;
  associate_trades?: unknown;
};

const MATCHED_STATUSES = new Set([
  'matched',
  'filled',
  'mined',
  'confirmed',
  'executed',
]);

/** 市价卖单挂单价常为 0.01 地板价，不能当作真实成交均价 */
export const POLYMARKET_MARKET_SELL_FLOOR_PRICE = 0.01;
const MARKET_SELL_FLOOR_EPS = 1e-6;

export function parseClobFilledAmount(value: unknown): number | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (!raw.includes('.') && num >= 1_000_000) {
    return num / 1_000_000;
  }
  return num;
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => String(item ?? '').trim().length > 0);
}

function statusLooksMatched(status: unknown): boolean {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  return MATCHED_STATUSES.has(s);
}

/** 限价/挂单价是否像市价卖地板（不可用于推算 notional） */
export function isMarketSellFloorPrice(price: number | null | undefined): boolean {
  return (
    price != null &&
    Number.isFinite(price) &&
    price <= POLYMARKET_MARKET_SELL_FLOOR_PRICE + MARKET_SELL_FLOOR_EPS
  );
}

/**
 * 从 postOrder / getOrder 回包提取成交摘要。
 * BUY: taking=outcome 份额, making=抵押名义；SELL 相反。
 */
export function getClobOrderFillSummary(
  result: unknown,
  side: 'BUY' | 'SELL'
): ClobFillSummary {
  if (result == null || typeof result !== 'object') {
    return { filled: false };
  }
  const row = result as ClobFillFields;
  let makingAmount = parseClobFilledAmount(row.makingAmount ?? row.making_amount);
  let takingAmount = parseClobFilledAmount(row.takingAmount ?? row.taking_amount);
  const sizeMatched = parseClobFilledAmount(row.size_matched ?? row.sizeMatched);
  const price = parseClobFilledAmount(row.price);
  const hasTradeRef =
    hasNonEmptyStringArray(row.transactionsHashes) ||
    hasNonEmptyStringArray(row.tradeIDs) ||
    hasNonEmptyStringArray(row.associate_trades);

  if (sizeMatched != null && sizeMatched > 0) {
    if (side === 'BUY') {
      if (!(takingAmount != null && takingAmount > 0)) takingAmount = sizeMatched;
      if (
        !(makingAmount != null && makingAmount > 0) &&
        price != null &&
        !isMarketSellFloorPrice(price)
      ) {
        makingAmount = sizeMatched * price;
      }
    } else {
      if (!(makingAmount != null && makingAmount > 0)) makingAmount = sizeMatched;
      // 卖单：禁止用 0.01 地板价伪造 USDC 回收额
      if (
        !(takingAmount != null && takingAmount > 0) &&
        price != null &&
        !isMarketSellFloorPrice(price)
      ) {
        takingAmount = sizeMatched * price;
      }
    }
  }

  const size = side === 'SELL' ? makingAmount : takingAmount;
  const notional = side === 'SELL' ? takingAmount : makingAmount;
  let avgPrice: number | undefined =
    size != null && notional != null && size > 0 && notional > 0 ? notional / size : undefined;
  if (avgPrice == null && price != null && !isMarketSellFloorPrice(price)) {
    avgPrice = price;
  }

  const filled =
    (size != null && size > 0) ||
    hasTradeRef ||
    (statusLooksMatched(row.status) && sizeMatched != null && sizeMatched > 0);

  return {
    filled,
    size: size ?? undefined,
    notional: notional ?? undefined,
    avgPrice: avgPrice ?? undefined,
  };
}

const BUY_FILL_SIZE_SANITY_MULT = 3;

/**
 * Guard against CLOB fill parsing bugs that inflate BUY share size
 * (e.g. intended ~9 shares / $1.05 recorded as 1050 shares / $120).
 */
export function sanitizeCopyBuyFillAgainstIntent(params: {
  fillSize: number;
  fillNotional?: number | null;
  intendedSize: number;
  intendedNotionalUsd: number;
  executionPrice: number;
}): { size: number; notional: number | null; corrected: boolean } {
  const fillSize = Math.max(0, params.fillSize);
  const intendedSize = Math.max(0, params.intendedSize);
  const intendedNotionalUsd = Math.max(0, params.intendedNotionalUsd);
  const executionPrice = Math.max(0, params.executionPrice);
  const fillNotional =
    params.fillNotional != null && Number.isFinite(params.fillNotional) && params.fillNotional > 0
      ? params.fillNotional
      : null;

  const sizeCapFromIntent = intendedSize > 0 ? intendedSize * BUY_FILL_SIZE_SANITY_MULT : 0;
  const sizeCapFromNotional =
    intendedNotionalUsd > 0 && executionPrice > 0
      ? (intendedNotionalUsd * BUY_FILL_SIZE_SANITY_MULT) / executionPrice
      : 0;
  const sizeCap = Math.max(sizeCapFromIntent, sizeCapFromNotional);

  const impliedNotional = executionPrice > 0 ? fillSize * executionPrice : 0;
  const notionalTooLarge =
    intendedNotionalUsd > 0 && impliedNotional > intendedNotionalUsd * BUY_FILL_SIZE_SANITY_MULT;
  const sizeTooLarge = sizeCap > 0 && fillSize > sizeCap;

  if (!sizeTooLarge && !notionalTooLarge) {
    return { size: fillSize, notional: fillNotional, corrected: false };
  }

  if (
    fillNotional != null &&
    intendedNotionalUsd > 0 &&
    fillNotional <= intendedNotionalUsd * BUY_FILL_SIZE_SANITY_MULT &&
    executionPrice > 0
  ) {
    return { size: fillNotional / executionPrice, notional: fillNotional, corrected: true };
  }

  if (intendedNotionalUsd > 0 && executionPrice > 0) {
    return {
      size: intendedNotionalUsd / executionPrice,
      notional: intendedNotionalUsd,
      corrected: true,
    };
  }

  if (intendedSize > 0) {
    return {
      size: intendedSize,
      notional: fillNotional,
      corrected: true,
    };
  }

  return { size: fillSize, notional: fillNotional, corrected: false };
}

/** 用 getOrder 回包补全 postOrder 中缺失的 taking/makingAmount */
export function mergeClobFillFromOpenOrder(
  postResult: unknown,
  openOrder: unknown,
  side: 'BUY' | 'SELL'
): unknown {
  if (postResult == null || typeof postResult !== 'object') return postResult;
  if (openOrder == null || typeof openOrder !== 'object') return postResult;

  const order = openOrder as ClobFillFields;
  const sizeMatched = parseClobFilledAmount(order.size_matched ?? order.sizeMatched);
  if (!(sizeMatched != null && sizeMatched > 0)) return postResult;

  const price = parseClobFilledAmount(order.price);
  const canUseLimitPriceAsFill = price != null && !isMarketSellFloorPrice(price);
  const notional = canUseLimitPriceAsFill ? sizeMatched * price : null;
  const enriched: Record<string, unknown> = { ...(postResult as Record<string, unknown>) };

  if (side === 'BUY') {
    if (!parseClobFilledAmount(enriched.takingAmount)) {
      enriched.takingAmount = String(sizeMatched);
    }
    if (!parseClobFilledAmount(enriched.makingAmount) && notional != null) {
      enriched.makingAmount = String(notional);
    }
  } else {
    if (!parseClobFilledAmount(enriched.makingAmount)) {
      enriched.makingAmount = String(sizeMatched);
    }
    if (!parseClobFilledAmount(enriched.takingAmount) && notional != null) {
      enriched.takingAmount = String(notional);
    }
  }

  if (order.status != null && enriched.status == null) {
    enriched.status = order.status;
  }
  if (hasNonEmptyStringArray(order.associate_trades) && !hasNonEmptyStringArray(enriched.tradeIDs)) {
    enriched.tradeIDs = order.associate_trades;
  }

  return enriched;
}

/** 用成交明细补全真实成交价/名义（卖单尤其避免 0.01 地板价） */
export function mergeClobFillFromTrades(
  postResult: unknown,
  trades: unknown,
  side: 'BUY' | 'SELL',
  orderID?: string
): unknown {
  if (postResult == null || typeof postResult !== 'object') return postResult;
  if (!Array.isArray(trades) || trades.length === 0) return postResult;

  const oid = (orderID ?? String((postResult as { orderID?: unknown }).orderID ?? ''))
    .trim()
    .toLowerCase();
  const matched = trades.filter((t) => {
    if (t == null || typeof t !== 'object') return false;
    if (!oid) return true;
    const taker = String((t as { taker_order_id?: unknown }).taker_order_id ?? '')
      .trim()
      .toLowerCase();
    return !!taker && (taker === oid || taker.includes(oid) || oid.includes(taker));
  });
  const rows = matched.length > 0 ? matched : [];

  let sizeSum = 0;
  let notionalSum = 0;
  for (const t of rows) {
    if (t == null || typeof t !== 'object') continue;
    const row = t as { size?: unknown; price?: unknown };
    const sz = parseClobFilledAmount(row.size);
    const px = parseClobFilledAmount(row.price);
    if (sz == null || px == null || isMarketSellFloorPrice(px)) continue;
    sizeSum += sz;
    notionalSum += sz * px;
  }
  if (!(sizeSum > 0) || !(notionalSum > 0)) return postResult;

  const enriched: Record<string, unknown> = { ...(postResult as Record<string, unknown>) };
  if (side === 'BUY') {
    enriched.takingAmount = String(sizeSum);
    enriched.makingAmount = String(notionalSum);
  } else {
    enriched.makingAmount = String(sizeSum);
    enriched.takingAmount = String(notionalSum);
  }
  return enriched;
}
