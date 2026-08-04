import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import {
  COMMISSION_RULE_VERSION,
  COMMISSION_SOURCE_TYPE,
  settleMallOrderCommissions,
} from './gas';
import { appendBillingLedgerEntry, BILLING_ENTRY_TYPE } from '../ledger/billingLedger';
import {
  getCustodialWalletAddressForUser,
  getCustodialWalletForUser,
  resolveCustodyTreasuryAddress,
} from '../custody/custody';
import {
  appendUserWalletLedger,
  WALLET_LEDGER_CATEGORY,
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_RAIL,
} from '../custody/userWalletLedger';
import { resumeUserCopyTradingPausedForGas } from '../../copyTrading/services/copyFundingMonitor';
import {
  getNativeBalance,
  getUsdcBalance,
  publicClient,
  USDC_E_ADDRESS,
} from '../polymarket/web3';
import { parseUnits } from 'viem';
import { polygon } from 'viem/chains';
import { CONFIG } from '../../config/env';
import { createConflictError } from '../../utils/appError';
import { invalidateOnChainUsdcBalanceCacheForCustodialUser } from '../custody/custodyOnChainBalance';
import {
  getPolymarketDepositWithdrawPreview,
  submitDepositWalletUsdcRelayerTransfers,
} from '../polymarket/polymarketDepositWithdrawV2';
import { AssetType } from '@polymarket/clob-client-v2';
import { getClobClientForUser, invalidateUserClobClientCache } from '../polymarket/polymarketClob';
import { recordAdminActivity } from '../adminDashboard/adminActivityLog';
import { applyAffiliateTierAutoUpgradeCascade } from '../affiliate/affiliateTierAutoUpgrade';
import { resolvePurchaseAffiliateTierGrant } from '../affiliate/affiliateTierFirstPurchase';

type DecimalLike = Prisma.Decimal | number | string;
const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;
const custodyChain = { ...polygon, id: CONFIG.chainId || polygon.id };

const MIN_NATIVE_FOR_ERC20_TRANSFER_WEI = 1_000_000_000_000_000n;

function toDecimal(value: DecimalLike): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(value);
}

function normalizeUserTier(tier: number | null | undefined): number {
  if (tier == null || tier <= 0) return 0;
  return tier;
}

/** Grant L1 on first Gas purchase; honor package bonusAffiliateTier when higher. */
async function grantGasPackageBonusAffiliateTier(
  tx: Prisma.TransactionClient,
  options: {
    orderId: number;
    userId: number;
    packageId: number;
    sourceOrderId: string;
    grantedAt: Date;
  },
) {
  const pkg = await (tx as any).gasPackage.findUnique({
    where: { id: options.packageId },
  });
  const packageBonusTier = (pkg as any)?.bonusAffiliateTier ?? null;

  const user = await (tx as any).user.findUnique({ where: { id: options.userId } });
  if (!user) {
    throw new Error('User not found');
  }

  const currentTier = normalizeUserTier((user as any).affiliateTier);
  const grantTier = resolvePurchaseAffiliateTierGrant({
    currentTier,
    packageBonusTier,
  });
  // Belt-and-suspenders: never write a lower/equal affiliate tier.
  if (grantTier == null || grantTier <= currentTier) {
    return { granted: null as number | null, user };
  }

  const tierLabel = `V${grantTier}`;
  const isFirstPurchaseActivation = currentTier <= 0;
  const isPackageBonus = packageBonusTier != null && grantTier === packageBonusTier;
  const affiliateNote = isFirstPurchaseActivation && !isPackageBonus
    ? `L1 activated via first gas package purchase #${options.sourceOrderId}`
    : isFirstPurchaseActivation
      ? `Activated via gas package order #${options.sourceOrderId} (${tierLabel})`
      : `Bonus tier from gas package order #${options.sourceOrderId} (${tierLabel})`;

  const updatedUser = await (tx as any).user.update({
    where: { id: options.userId },
    data: {
      affiliateTier: grantTier,
      affiliateNote,
    },
  });

  const entryType =
    isFirstPurchaseActivation && grantTier === 1 && !isPackageBonus
      ? BILLING_ENTRY_TYPE.AFFILIATE_TIER_ACTIVATED
      : BILLING_ENTRY_TYPE.AFFILIATE_TIER_BONUS_FROM_GAS_PACKAGE;

  await appendBillingLedgerEntry(
    {
      userId: options.userId,
      entryType,
      sourceType: COMMISSION_SOURCE_TYPE.MALL_ORDER,
      sourceOrderId: options.sourceOrderId,
      amount: new Prisma.Decimal(0),
      currency: 'USD',
      note: isFirstPurchaseActivation && grantTier === 1 && !isPackageBonus
        ? `Gas package order ${options.sourceOrderId} first-purchase L1 activation`
        : `Gas package order ${options.sourceOrderId} bonus affiliate tier (${tierLabel})`,
      metadata: {
        bonusAffiliateTier: grantTier,
        previousTier: currentTier > 0 ? currentTier : null,
        packageId: options.packageId,
        gasPackageOrderId: options.orderId,
        packageBonusTier,
        firstPurchaseActivation: isFirstPurchaseActivation,
      },
    },
    tx,
  );

  await applyAffiliateTierAutoUpgradeCascade((updatedUser as any).id, tx);

  return { granted: grantTier as number, user: updatedUser };
}

export async function createGasPackage(options: {
  name: string;
  usdPrice: DecimalLike;
  gasAmount: DecimalLike;
  description?: string | null;
  isActive?: boolean;
  sortOrder?: number;
  chainId?: number | null;
  currency?: string | null;
}) {
  const name = options.name.trim();
  if (!name) {
    throw new Error('Package name is required');
  }

  let usdPrice: Prisma.Decimal;
  let gasAmount: Prisma.Decimal;
  try {
    usdPrice = toDecimal(options.usdPrice);
  } catch {
    throw new Error('Invalid usdPrice');
  }

  try {
    gasAmount = toDecimal(options.gasAmount);
  } catch {
    throw new Error('Invalid gasAmount');
  }

  if (!usdPrice.gt(0)) {
    throw new Error('usdPrice must be greater than 0');
  }

  if (!gasAmount.gt(0)) {
    throw new Error('gasAmount must be greater than 0');
  }

  const description = options.description?.trim() || null;
  const currency = options.currency?.trim().toUpperCase() || 'USD';

  return (prisma as any).gasPackage.create({
    data: {
      name,
      usdPrice,
      gasAmount,
      description,
      isActive: options.isActive ?? true,
      sortOrder: options.sortOrder ?? 0,
      chainId: options.chainId ?? null,
      currency,
    },
  });
}

export async function listActivePackages() {
  return (prisma as any).gasPackage.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
}

export async function createPackageOrder(options: {
  userId: number;
  packageId: number;
  walletAddress?: string;
}) {
  const user = await (prisma as any).user.findUnique({
    where: { id: options.userId },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const pkg = await (prisma as any).gasPackage.findUnique({
    where: { id: options.packageId },
  });

  if (!pkg || !(pkg as any).isActive) {
    throw new Error('Gas package not found or inactive');
  }

  const usdPrice = (pkg as any).usdPrice as Prisma.Decimal;
  const gasAmount = (pkg as any).gasAmount as Prisma.Decimal;

  const order = await (prisma as any).gasPackageOrder.create({
    data: {
      userId: (user as any).id,
      packageId: (pkg as any).id,
      status: 'PENDING',
      paidUsd: usdPrice,
      gasAmount,
    },
  });

  await appendBillingLedgerEntry({
    userId: (user as any).id,
    entryType: BILLING_ENTRY_TYPE.PACKAGE_ORDER_CREATED,
    sourceType: COMMISSION_SOURCE_TYPE.MALL_ORDER,
    sourceOrderId: String((order as any).id),
    amount: usdPrice.negated(),
    currency: 'USD',
    note: `Package order ${(order as any).id} created`,
    metadata: {
      packageId: (pkg as any).id,
      gasAmount: gasAmount.toString(),
      status: 'PENDING',
    },
  });

  recordAdminActivity({
    eventType: 'gas.order.created',
    title: 'Gas Order Created',
    level: 'info',
    actorType: 'user',
    actorId: String((user as any).id),
    targetType: 'GasPackageOrder',
    targetId: String((order as any).id),
  });

  return {
    order,
    package: pkg,
    suggestedPayment: {
      usdPrice: usdPrice.toString(),
      gasAmount: gasAmount.toString(),
      walletAddress: options.walletAddress,
    },
  };
}

export async function confirmPackageOrder(options: {
  orderId: number;
  txHash: string;
}) {
  const existing = await (prisma as any).gasPackageOrder.findUnique({
    where: { id: options.orderId },
  });

  if (!existing) {
    throw new Error('Package order not found');
  }

  if ((existing as any).status === 'PAID' || (existing as any).status === 'FULFILLED') {
    return existing;
  }

  if ((existing as any).status !== 'PENDING') {
    throw new Error('Order status is not pending');
  }

  const updated = await (prisma as any).gasPackageOrder.update({
    where: { id: options.orderId },
    data: {
      status: 'PAID',
      txHash: options.txHash,
      paymentConfirmedAt: new Date(),
    },
  });
  recordAdminActivity({
    eventType: 'gas.order.paid',
    title: 'Gas Order Paid',
    level: 'info',
    actorType: 'user',
    actorId: String((existing as any).userId),
    targetType: 'GasPackageOrder',
    targetId: String(options.orderId),
  });
  await appendBillingLedgerEntry({
    userId: (existing as any).userId,
    entryType: BILLING_ENTRY_TYPE.PACKAGE_ORDER_CONFIRMED,
    sourceType: COMMISSION_SOURCE_TYPE.MALL_ORDER,
    sourceOrderId: String(options.orderId),
    amount: existing.paidUsd as Prisma.Decimal,
    currency: 'USD',
    note: `Package order ${options.orderId} payment confirmed`,
    metadata: {
      txHash: options.txHash,
      status: 'PAID',
    },
  });
  return updated;
}

export async function fulfillPaidPackageOrder(
  tx: Prisma.TransactionClient,
  orderId: number,
) {
  const existing = await (tx as any).gasPackageOrder.findUnique({
    where: { id: orderId },
  });

  if (!existing) {
    throw new Error('Package order not found');
  }

  if ((existing as any).status === 'FULFILLED' && (existing as any).commissionSettlementStatus === 'SETTLED') {
    return {
      packageOrder: existing,
      gasOrder: (existing as any).gasOrderId
        ? await (tx as any).gasOrder.findUnique({ where: { id: (existing as any).gasOrderId } })
        : null,
      user: await (tx as any).user.findUnique({ where: { id: (existing as any).userId } }),
    };
  }

  if ((existing as any).status !== 'PAID') {
    throw new Error('Order status is not paid');
  }

  const paidUsd = toDecimal((existing as any).paidUsd as any);
  const gasAmount = toDecimal((existing as any).gasAmount as any);
  const sourceOrderId = String((existing as any).id);
  const fulfilledAt = new Date();

  const gasOrder = await (tx as any).gasOrder.create({
    data: {
      userId: (existing as any).userId,
      amountPaid: paidUsd,
      gasPurchasedGross: gasAmount,
      gasNetToUser: gasAmount,
      commissionTotal: new Prisma.Decimal(0),
      distributableUsdc: paidUsd,
      sourceType: COMMISSION_SOURCE_TYPE.MALL_ORDER,
      sourceOrderId,
      commissionRuleVersion: COMMISSION_RULE_VERSION,
      status: 'SUCCESS',
    },
  });

  const updatedUser = await (tx as any).user.update({
    where: { id: (existing as any).userId },
    data: {
      gasBalance: {
        increment: gasAmount,
      },
    },
    select: {
      gasBalance: true,
    },
  });

  await (tx as any).gasBalanceLog.create({
    data: {
      userId: (existing as any).userId,
      change: gasAmount,
      type: 'PACKAGE_FULFILLMENT',
      sourceType: COMMISSION_SOURCE_TYPE.MALL_ORDER,
      sourceOrderId,
      ruleVersion: COMMISSION_RULE_VERSION,
      relatedOrderId: gasOrder.id,
    },
  });

  await appendBillingLedgerEntry(
    {
      userId: (existing as any).userId,
      entryType: BILLING_ENTRY_TYPE.PACKAGE_ORDER_FULFILLED,
      sourceType: COMMISSION_SOURCE_TYPE.MALL_ORDER,
      sourceOrderId,
      amount: gasAmount,
      balanceAfter: updatedUser.gasBalance,
      currency: 'GAS',
      ruleVersion: COMMISSION_RULE_VERSION,
      note: `Package order ${sourceOrderId} fulfilled`,
      metadata: {
        gasOrderId: gasOrder.id,
        paidUsd: paidUsd.toString(),
      },
    },
    tx as Prisma.TransactionClient
  );

  await appendUserWalletLedger(
    {
      userId: (existing as any).userId,
      rail: WALLET_LEDGER_RAIL.GAS_POINTS,
      direction: WALLET_LEDGER_DIRECTION.CREDIT,
      amount: gasAmount,
      symbol: 'GAS',
      category: WALLET_LEDGER_CATEGORY.PACKAGE_FULFILL_GAS,
      refType: 'GasPackageOrder',
      refId: sourceOrderId,
      idempotencyKey: `wallet-pkg-fulfill-gas-${sourceOrderId}`,
      balanceAfter: updatedUser.gasBalance,
      metadata: { gasOrderId: gasOrder.id, paidUsd: paidUsd.toString() },
    },
    tx,
  );

  const commissionPlan = await settleMallOrderCommissions(
    {
      orderId: (existing as any).id,
      buyerUserId: (existing as any).userId,
      distributableAmount: paidUsd,
      sourceOrderId,
      sourceType: COMMISSION_SOURCE_TYPE.MALL_ORDER,
      ruleVersion: COMMISSION_RULE_VERSION,
    },
    tx,
  );

  await (tx as any).gasOrder.update({
    where: { id: gasOrder.id },
    data: {
      commissionTotal: commissionPlan.totalCommissionAmount,
    },
  });

  const bonusResult = await grantGasPackageBonusAffiliateTier(tx, {
    orderId,
    userId: (existing as any).userId,
    packageId: (existing as any).packageId,
    sourceOrderId,
    grantedAt: fulfilledAt,
  });

  const orderUpdateData: Record<string, unknown> = {
    status: 'FULFILLED',
    fulfilledAt,
    commissionSettlementStatus: 'SETTLED',
    commissionSettledAt: fulfilledAt,
    gasOrderId: gasOrder.id,
  };
  if (bonusResult.granted != null) {
    orderUpdateData.bonusAffiliateTierGranted = bonusResult.granted;
    orderUpdateData.bonusAffiliateTierGrantedAt = fulfilledAt;
  }

  const updated = await (tx as any).gasPackageOrder.update({
    where: { id: orderId },
    data: orderUpdateData,
  });

  const user =
    bonusResult.user ??
    (await (tx as any).user.findUnique({
      where: { id: (existing as any).userId },
    }));

  return {
    packageOrder: updated,
    gasOrder,
    commissionPlan,
    user,
    bonusAffiliateTierGranted: bonusResult.granted,
  };
}

export async function fulfillPackageOrder(options: {
  orderId: number;
}) {
  const result = await prisma.$transaction(async (tx) => fulfillPaidPackageOrder(tx, options.orderId));
  if (result?.user?.id) {
    await resumeUserCopyTradingPausedForGas({ userId: result.user.id });
  }
  if (result?.commissionPlan?.totalCommissionAmount) {
    recordAdminActivity({
      eventType: 'commission.generated',
      title: 'Commission Generated',
      level: 'info',
      actorType: 'system',
      targetType: 'GasPackageOrder',
      targetId: String(options.orderId),
      metadata: {
        totalCommission: String(result.commissionPlan.totalCommissionAmount),
      },
    });
  }
  if (result?.bonusAffiliateTierGranted) {
    recordAdminActivity({
      eventType: 'affiliate.tier.bonus_granted',
      title: 'Affiliate tier bonus granted (gas package)',
      level: 'info',
      actorType: 'system',
      targetType: 'GasPackageOrder',
      targetId: String(options.orderId),
      metadata: {
        affiliateTier: result.bonusAffiliateTierGranted,
      },
    });
  }
  return result;
}

export async function purchasePackageWithCustodyWallet(options: { userId: number; packageId: number }) {
  void options;
  throw createConflictError(
    'Custody-wallet gas package purchase is disabled. Use Polymarket deposit relayer payment instead.',
    {
      reasonCode: 'GAS_PACKAGE_CUSTODY_PURCHASE_DISABLED',
      recommendedEndpoint: '/api/gas-packages/orders/purchase-with-polymarket-deposit',
    },
  );
}

export async function purchasePackageWithPolymarketDeposit(options: { userId: number; packageId: number }) {
  const user = await (prisma as any).user.findUnique({
    where: { id: options.userId },
  });
  if (!user) {
    throw new Error('User not found');
  }

  const pkg = await (prisma as any).gasPackage.findUnique({
    where: { id: options.packageId },
  });
  if (!pkg || !(pkg as any).isActive) {
    throw new Error('Gas package not found or inactive');
  }

  const usdPrice = (pkg as any).usdPrice as Prisma.Decimal;
  const gasAmount = (pkg as any).gasAmount as Prisma.Decimal;
  const amountText = usdPrice.toFixed(6);
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
  const order = await (prisma as any).gasPackageOrder.create({
    data: {
      userId: options.userId,
      packageId: (pkg as any).id,
      status: 'PENDING',
      paidUsd: usdPrice,
      gasAmount,
    },
  });
  const sourceOrderId = String((order as any).id);
  const relayIdempotencyKey = `wallet-pkg-pm-dep-relay-${sourceOrderId}`;
  const transferLegs = [{ to: treasuryAddress, amountWei: amountUnits }];

  await appendBillingLedgerEntry({
    userId: options.userId,
    entryType: BILLING_ENTRY_TYPE.PACKAGE_ORDER_CREATED,
    sourceType: COMMISSION_SOURCE_TYPE.MALL_ORDER,
    sourceOrderId,
    amount: usdPrice.negated(),
    currency: 'USD',
    note: `Package order ${sourceOrderId} created (Polymarket deposit)`,
    metadata: {
      packageId: (pkg as any).id,
      gasAmount: gasAmount.toString(),
      status: 'PENDING',
      paymentSource: 'POLYMARKET_DEPOSIT',
      treasuryAddress,
      splitLegCount: transferLegs.length,
    },
  });

  const { transactionHash, totalAmountStr, deposit, legs } = await submitDepositWalletUsdcRelayerTransfers({
    userId: options.userId,
    idempotencyKey: relayIdempotencyKey,
    totalAmountWei: amountUnits,
    transfers: transferLegs,
  });

  const result = await prisma.$transaction(async (tx) => {
    await (tx as any).gasPackageOrder.update({
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
        entryType: BILLING_ENTRY_TYPE.PACKAGE_ORDER_CONFIRMED,
        sourceType: COMMISSION_SOURCE_TYPE.MALL_ORDER,
        sourceOrderId,
        amount: usdPrice,
        currency: 'USD',
        note: `Package order ${sourceOrderId} payment confirmed (Polymarket deposit)`,
        metadata: {
          paymentSource: 'POLYMARKET_DEPOSIT',
          status: 'PAID',
          txHash: transactionHash,
          deposit,
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
        category: WALLET_LEDGER_CATEGORY.PACKAGE_PURCHASE,
        refType: 'RELAYER_TX',
        refId: String(transactionHash),
        idempotencyKey: `wallet-pkg-purchase-pm-dep-${sourceOrderId}`,
        metadata: {
          packageId: (pkg as any).id,
          gasAmount: gasAmount.toString(),
          paymentSource: 'POLYMARKET_DEPOSIT',
          txHash: transactionHash,
          deposit,
          transferLegs: legs.map((l) => ({ to: l.to, amount: l.amountStr })),
          amountRaw: amountUnits.toString(),
        },
      },
      tx,
    );

    return fulfillPaidPackageOrder(tx, (order as any).id);
  });

  await resumeUserCopyTradingPausedForGas({ userId: options.userId });

  invalidateOnChainUsdcBalanceCacheForCustodialUser(options.userId);
  try {
    const custodial = preview.custodialAddress;
    invalidateUserClobClientCache(options.userId, custodial);
    const clob = await getClobClientForUser(options.userId, custodial);
    await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } catch (e) {
    console.warn('[gas-package] CLOB collateral refresh after PM deposit purchase skipped', e);
  }

  return {
    ...result,
    transactionHash,
    amount: totalAmountStr,
    deposit,
    transferLegs: legs.map((l) => ({ to: l.to, amount: l.amountStr })),
  };
}
