import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { AFFILIATE_TIER_RATES } from '../../config/gas';
import {
  COMMISSION_RULE_VERSION,
  COMMISSION_SOURCE_TYPE,
  settleMallOrderCommissions,
} from '../gas/gas';
import { appendBillingLedgerEntry, BILLING_ENTRY_TYPE } from '../ledger/billingLedger';
import {
  getPolymarketDepositWithdrawPreview,
  submitDepositWalletUsdcRelayerTransfers,
} from '../polymarket/polymarketDepositWithdrawV2';
import { resolveCustodyTreasuryAddress } from '../custody/custody';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from '../custody/userWalletLedger';
import { createConflictError } from '../../utils/appError';
import { parseUnits } from 'viem';
import { recordAdminActivity } from '../adminDashboard/adminActivityLog';
import { applyAffiliateTierAutoUpgradeCascade } from './affiliateTierAutoUpgrade';
import { invalidateOnChainUsdcBalanceCacheForCustodialUser } from '../custody/custodyOnChainBalance';
import { AssetType } from '@polymarket/clob-client-v2';
import { getClobClientForUser, invalidateUserClobClientCache } from '../polymarket/polymarketClob';

export const AFFILIATE_TIER_ACTIVATION_SOURCE = 'AFFILIATE_TIER_ACTIVATION';

type DecimalLike = Prisma.Decimal | number | string;

function toDecimal(value: DecimalLike): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(value);
}

function normalizeUserTier(tier: number | null | undefined): number {
  if (tier == null || tier <= 0) return 0;
  return tier;
}

function assertValidProductTier(tier: number) {
  if (!Number.isInteger(tier) || tier < 1 || tier > 8 || !(tier in AFFILIATE_TIER_RATES)) {
    throw new Error('Invalid affiliate tier on product');
  }
}

export async function listActiveAffiliateTierProducts() {
  return (prisma as any).affiliateTierProduct.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { affiliateTier: 'asc' }, { id: 'asc' }],
  });
}

export type AffiliateTierUpgradePricing = {
  listUsdPrice: string;
  creditUsd: string;
  payableUsd: string;
  creditSource: 'none' | 'catalog_tier_list' | 'fulfilled_order';
  currentTier: number;
  isUpgrade: boolean;
};

async function resolveUpgradeCreditUsd(
  userId: number,
  currentTier: number,
): Promise<{ credit: Prisma.Decimal; source: AffiliateTierUpgradePricing['creditSource'] }> {
  if (currentTier <= 0) {
    return { credit: new Prisma.Decimal(0), source: 'none' };
  }

  const currentProduct = await (prisma as any).affiliateTierProduct.findFirst({
    where: { affiliateTier: currentTier, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  if (currentProduct) {
    return {
      credit: toDecimal((currentProduct as any).usdPrice),
      source: 'catalog_tier_list',
    };
  }

  const lastOrder = await (prisma as any).affiliateTierOrder.findFirst({
    where: {
      userId,
      affiliateTier: currentTier,
      status: 'FULFILLED',
    },
    orderBy: [{ fulfilledAt: 'desc' }, { id: 'desc' }],
  });
  if (lastOrder) {
    return {
      credit: toDecimal((lastOrder as any).paidUsd),
      source: 'fulfilled_order',
    };
  }

  return { credit: new Prisma.Decimal(0), source: 'none' };
}

export async function resolveAffiliateTierUpgradePricing(
  userId: number,
  product: { affiliateTier: number; usdPrice: DecimalLike },
  currentTierInput?: number,
): Promise<AffiliateTierUpgradePricing> {
  let currentTier = currentTierInput;
  if (currentTier === undefined) {
    const user = await (prisma as any).user.findUnique({ where: { id: userId } });
    currentTier = normalizeUserTier((user as any)?.affiliateTier);
  }

  const listUsd = toDecimal(product.usdPrice);
  const targetTier = product.affiliateTier;
  if (targetTier <= currentTier) {
    return {
      listUsdPrice: listUsd.toString(),
      creditUsd: '0',
      payableUsd: listUsd.toString(),
      creditSource: 'none',
      currentTier,
      isUpgrade: false,
    };
  }

  const { credit, source } = await resolveUpgradeCreditUsd(userId, currentTier);
  const payable = listUsd.sub(credit);
  if (!payable.gt(0)) {
    throw createConflictError('升级补差价无效，请检查档位商品标价配置', {
      reasonCode: 'AFFILIATE_TIER_UPGRADE_PRICE_INVALID',
      listUsdPrice: listUsd.toString(),
      creditUsd: credit.toString(),
      currentTier,
      targetTier,
    });
  }

  return {
    listUsdPrice: listUsd.toString(),
    creditUsd: credit.toString(),
    payableUsd: payable.toString(),
    creditSource: source,
    currentTier,
    isUpgrade: currentTier > 0,
  };
}

export async function listAffiliateTierProductsWithPricing(userId: number) {
  const user = await (prisma as any).user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error('User not found');
  }
  const currentTier = normalizeUserTier((user as any).affiliateTier);
  const products = await listActiveAffiliateTierProducts();
  const items = [];
  for (const product of products) {
    const pricing = await resolveAffiliateTierUpgradePricing(
      userId,
      {
        affiliateTier: (product as any).affiliateTier,
        usdPrice: (product as any).usdPrice,
      },
      currentTier,
    );
    items.push({
      ...product,
      pricing,
    });
  }
  return { currentTier, items };
}

export async function fulfillPaidAffiliateTierOrder(
  tx: Prisma.TransactionClient,
  orderId: number,
) {
  const existing = await (tx as any).affiliateTierOrder.findUnique({
    where: { id: orderId },
    include: { product: true },
  });
  if (!existing) {
    throw new Error('Affiliate tier order not found');
  }
  if (
    (existing as any).status === 'FULFILLED' &&
    (existing as any).commissionSettlementStatus === 'SETTLED'
  ) {
    return {
      order: existing,
      user: await (tx as any).user.findUnique({ where: { id: (existing as any).userId } }),
      commissionPlan: null,
    };
  }
  if ((existing as any).status !== 'PAID') {
    throw new Error('Order status is not paid');
  }

  const user = await (tx as any).user.findUnique({ where: { id: (existing as any).userId } });
  if (!user) {
    throw new Error('User not found');
  }
  const currentTier = normalizeUserTier((user as any).affiliateTier);
  const targetTier = (existing as any).affiliateTier as number;
  if (targetTier <= currentTier) {
    throw createConflictError('当前档位已不低于所购激活档位', {
      reasonCode: 'AFFILIATE_TIER_ALREADY_ACTIVE',
      currentTier,
      targetTier,
    });
  }

  const paidUsd = toDecimal((existing as any).paidUsd as any);
  const sourceOrderId = String((existing as any).id);
  const fulfilledAt = new Date();
  const tierLabel = `V${targetTier}`;

  const updatedUser = await (tx as any).user.update({
    where: { id: (existing as any).userId },
    data: {
      affiliateTier: targetTier,
      affiliateNote: currentTier <= 0
        ? `L1+ activated via first tier shop purchase #${sourceOrderId} (${tierLabel})`
        : `Activated via shop order #${sourceOrderId} (${tierLabel})`,
    },
  });

  const commissionPlan = await settleMallOrderCommissions(
    {
      affiliateTierOrderId: orderId,
      buyerUserId: (existing as any).userId,
      distributableAmount: paidUsd,
      sourceOrderId,
      sourceType: COMMISSION_SOURCE_TYPE.AFFILIATE_TIER_ORDER,
      ruleVersion: COMMISSION_RULE_VERSION,
    },
    tx,
  );

  const order = await (tx as any).affiliateTierOrder.update({
    where: { id: orderId },
    data: {
      status: 'FULFILLED',
      fulfilledAt,
      commissionSettlementStatus: 'SETTLED',
      commissionSettledAt: fulfilledAt,
    },
  });

  await appendBillingLedgerEntry(
    {
      userId: (existing as any).userId,
      entryType: BILLING_ENTRY_TYPE.AFFILIATE_TIER_ACTIVATED,
      sourceType: AFFILIATE_TIER_ACTIVATION_SOURCE,
      sourceOrderId,
      amount: paidUsd.negated(),
      currency: 'USD',
      note: `Affiliate tier order ${sourceOrderId} fulfilled (${tierLabel})`,
      metadata: {
        affiliateTier: targetTier,
        productId: (existing as any).productId,
        previousTier: currentTier > 0 ? currentTier : null,
        listUsdPrice: (existing as any).listUsdPrice?.toString?.() ?? null,
        creditUsd: (existing as any).creditUsd?.toString?.() ?? null,
        paidUsd: paidUsd.toString(),
        totalCommission: commissionPlan?.totalCommissionAmount?.toString?.() ?? null,
      },
    },
    tx,
  );

  await applyAffiliateTierAutoUpgradeCascade((updatedUser as any).id, tx);

  return { order, user: updatedUser, commissionPlan };
}

export async function purchaseAffiliateTierWithPolymarketDeposit(options: {
  userId: number;
  productId: number;
}) {
  const user = await (prisma as any).user.findUnique({
    where: { id: options.userId },
  });
  if (!user) {
    throw new Error('User not found');
  }

  const product = await (prisma as any).affiliateTierProduct.findUnique({
    where: { id: options.productId },
  });
  if (!product || !(product as any).isActive) {
    throw new Error('Affiliate tier product not found or inactive');
  }

  const targetTier = (product as any).affiliateTier as number;
  assertValidProductTier(targetTier);
  const currentTier = normalizeUserTier((user as any).affiliateTier);
  if (targetTier <= currentTier) {
    throw createConflictError('只能购买高于当前档位的激活商品', {
      reasonCode: 'AFFILIATE_TIER_ALREADY_ACTIVE',
      currentTier,
      targetTier,
    });
  }

  const upgradePricing = await resolveAffiliateTierUpgradePricing(
    options.userId,
    {
      affiliateTier: targetTier,
      usdPrice: (product as any).usdPrice,
    },
    currentTier,
  );
  const listUsd = toDecimal(upgradePricing.listUsdPrice);
  const creditUsd = toDecimal(upgradePricing.creditUsd);
  const payableUsd = toDecimal(upgradePricing.payableUsd);
  if (!payableUsd.gt(0)) {
    throw new Error('Invalid payable upgrade price');
  }
  const amountText = payableUsd.toFixed(6);
  const amountUnits = parseUnits(amountText, 6);
  const treasuryAddress = await resolveCustodyTreasuryAddress();

  const preview = await getPolymarketDepositWithdrawPreview(options.userId);
  if (!preview) {
    throw createConflictError('未配置 Polymarket deposit 地址，请先完成托管开通与 Polymarket 授权', {
      hint: 'POST /api/custody/open 或 /api/custody/authorize-polymarket',
    });
  }
  if (preview.blockers.length > 0) {
    throw createConflictError('当前不满足用 Polymarket 交易余额付款的条件', {
      reasonCode: 'POLYMARKET_WITHDRAW_PREVIEW_BLOCKED',
      blockers: preview.blockers,
      checks: preview.checks,
    });
  }
  const maxWei = BigInt(preview.maxWithdrawableRaw);
  if (amountUnits > maxWei) {
    throw createConflictError('Polymarket 可付 USDC 不足', {
      reasonCode: 'WITHDRAW_EXCEEDS_MAX',
      maxWithdrawableRaw: maxWei.toString(),
      maxWithdrawableFormatted: preview.maxWithdrawableFormatted,
    });
  }

  const paymentConfirmedAt = new Date();
  const order = await (prisma as any).affiliateTierOrder.create({
    data: {
      userId: options.userId,
      productId: (product as any).id,
      status: 'PENDING',
      paidUsd: payableUsd,
      listUsdPrice: listUsd,
      creditUsd: creditUsd.gt(0) ? creditUsd : null,
      affiliateTier: targetTier,
    },
  });
  const sourceOrderId = String((order as any).id);
  const relayIdempotencyKey = `wallet-tier-act-pm-dep-relay-${sourceOrderId}`;
  const transferLegs = [{ to: treasuryAddress, amountWei: amountUnits }];

  await appendBillingLedgerEntry({
    userId: options.userId,
    entryType: BILLING_ENTRY_TYPE.AFFILIATE_TIER_ORDER_CREATED,
    sourceType: AFFILIATE_TIER_ACTIVATION_SOURCE,
    sourceOrderId,
    amount: payableUsd.negated(),
    currency: 'USD',
    note: `Affiliate tier order ${sourceOrderId} created (Polymarket deposit)`,
    metadata: {
      productId: (product as any).id,
      affiliateTier: targetTier,
      listUsdPrice: listUsd.toString(),
      creditUsd: creditUsd.toString(),
      payableUsd: payableUsd.toString(),
      creditSource: upgradePricing.creditSource,
      status: 'PENDING',
      paymentSource: 'POLYMARKET_DEPOSIT',
      treasuryAddress,
      splitLegCount: transferLegs.length,
    },
  });

  const { transactionHash, deposit, legs } = await submitDepositWalletUsdcRelayerTransfers({
    userId: options.userId,
    idempotencyKey: relayIdempotencyKey,
    totalAmountWei: amountUnits,
    transfers: transferLegs,
  });

  const result = await prisma.$transaction(async (tx) => {
    await (tx as any).affiliateTierOrder.update({
      where: { id: (order as any).id },
      data: {
        status: 'PAID',
        txHash: transactionHash,
        paymentConfirmedAt,
      },
    });

    await appendBillingLedgerEntry(
      {
        userId: options.userId,
        entryType: BILLING_ENTRY_TYPE.AFFILIATE_TIER_ORDER_CONFIRMED,
        sourceType: AFFILIATE_TIER_ACTIVATION_SOURCE,
        sourceOrderId,
        amount: payableUsd,
        currency: 'USD',
        note: `Affiliate tier order ${sourceOrderId} payment confirmed (Polymarket deposit)`,
        metadata: {
          paymentSource: 'POLYMARKET_DEPOSIT',
          status: 'PAID',
          txHash: transactionHash,
          deposit,
          listUsdPrice: listUsd.toString(),
          creditUsd: creditUsd.toString(),
          payableUsd: payableUsd.toString(),
          creditSource: upgradePricing.creditSource,
          transferLegs: legs.map((l) => ({ to: l.to, amount: l.amountStr })),
          amountRaw: amountUnits.toString(),
        },
      },
      tx,
    );

    await appendUserWalletLedger(
      {
        userId: options.userId,
        rail: WALLET_LEDGER_RAIL.ONCHAIN_USDC,
        direction: WALLET_LEDGER_DIRECTION.DEBIT,
        amount: amountText,
        symbol: 'USDC.e',
        category: WALLET_LEDGER_CATEGORY.AFFILIATE_TIER_ACTIVATION_PURCHASE,
        refType: 'RELAYER_TX',
        refId: String(transactionHash),
        idempotencyKey: `wallet-tier-act-purchase-pm-dep-${sourceOrderId}`,
        metadata: {
          productId: (product as any).id,
          affiliateTier: targetTier,
          listUsdPrice: listUsd.toString(),
          creditUsd: creditUsd.toString(),
          payableUsd: payableUsd.toString(),
          creditSource: upgradePricing.creditSource,
          paymentSource: 'POLYMARKET_DEPOSIT',
          txHash: transactionHash,
          deposit,
          transferLegs: legs.map((l) => ({ to: l.to, amount: l.amountStr })),
          amountRaw: amountUnits.toString(),
        },
      },
      tx,
    );

    return fulfillPaidAffiliateTierOrder(tx, (order as any).id);
  });

  invalidateOnChainUsdcBalanceCacheForCustodialUser(options.userId);
  try {
    const custodial = preview.custodialAddress;
    invalidateUserClobClientCache(options.userId, custodial);
    const clob = await getClobClientForUser(options.userId, custodial);
    await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } catch (e) {
    console.warn('[affiliate-tier-shop] CLOB collateral refresh after PM deposit purchase skipped', e);
  }

  recordAdminActivity({
    eventType: 'affiliate.tier.activated',
    title: 'Affiliate tier activated',
    level: 'info',
    actorType: 'user',
    actorId: String(options.userId),
    targetType: 'AffiliateTierOrder',
    targetId: sourceOrderId,
    metadata: {
      affiliateTier: targetTier,
      paidUsd: payableUsd.toString(),
      listUsdPrice: listUsd.toString(),
      creditUsd: creditUsd.toString(),
      creditSource: upgradePricing.creditSource,
      txHash: transactionHash,
    },
  });

  if (result?.commissionPlan?.totalCommissionAmount) {
    recordAdminActivity({
      eventType: 'commission.generated',
      title: 'Commission Generated',
      level: 'info',
      actorType: 'system',
      targetType: 'AffiliateTierOrder',
      targetId: sourceOrderId,
      metadata: {
        totalCommission: String(result.commissionPlan.totalCommissionAmount),
        sourceType: COMMISSION_SOURCE_TYPE.AFFILIATE_TIER_ORDER,
      },
    });
  }

  const publicOrder = { ...(result.order as Record<string, unknown>) };
  delete publicOrder.userId;

  return {
    order: publicOrder,
    product,
    user: result.user,
    pricing: upgradePricing,
    transactionHash,
    amount: amountText,
    deposit,
    to: treasuryAddress,
    transferLegs: legs.map((l) => ({ to: l.to, amount: l.amountStr })),
  };
}
