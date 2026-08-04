import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { getPolymarketDepositUsdcBalance } from '../../services/polymarket/polymarketDepositWithdraw';

export type CopyFundingSnapshot = {
  /** 开启/首次激活跟单所需保证金（默认 $10） */
  minUsdcRequired: number;
  /** 运行中继续跟单所需最低保证金（默认 = 平台最小下单额，通常 $1） */
  minUsdcRequiredToOperate: number;
  depositUsdcFormatted: string | null;
  gasBalance: string;
  /** deposit ≥ minUsdcRequired（信息展示；开启/恢复跟单不再校验） */
  hasSufficientUsdc: boolean;
  /** deposit ≥ minUsdcRequiredToOperate */
  hasOperationalUsdc: boolean;
  hasGas: boolean;
};

export type CopyFundingSnapshotOptions = {
  /** 状态轮询：跳过账本同步/auto-wrap，使用短 TTL 缓存 */
  readOnly?: boolean;
};

export async function getCopyFundingSnapshot(
  userId: number,
  options?: CopyFundingSnapshotOptions
): Promise<CopyFundingSnapshot> {
  const minUsdcActivation = CONFIG.copyMinFundingUsdc;
  const minUsdcOperate = CONFIG.copyBuyMinNotionalUsd;
  const [user, deposit] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { gasBalance: true } }),
    getPolymarketDepositUsdcBalance(userId, { readOnly: options?.readOnly === true }).catch(
      () => null
    ),
  ]);
  const gasBal =
    user?.gasBalance instanceof Prisma.Decimal
      ? user.gasBalance
      : new Prisma.Decimal(user?.gasBalance ?? 0);
  const hasGas = gasBal.gt(0);
  const depositFormatted = deposit?.formatted ?? null;
  const depositNum = depositFormatted != null ? Number(depositFormatted) : 0;
  const hasPositiveUsdc =
    depositFormatted != null && Number.isFinite(depositNum) && depositNum > 0;
  const hasSufficientUsdc =
    hasPositiveUsdc && (minUsdcActivation > 0 ? depositNum >= minUsdcActivation : true);
  const hasOperationalUsdc =
    hasPositiveUsdc && (minUsdcOperate > 0 ? depositNum >= minUsdcOperate : true);
  return {
    minUsdcRequired: minUsdcActivation,
    minUsdcRequiredToOperate: minUsdcOperate,
    depositUsdcFormatted: depositFormatted,
    gasBalance: gasBal.toString(),
    hasSufficientUsdc,
    hasOperationalUsdc,
    hasGas,
  };
}

/** 开启/恢复跟单：仅需平台 Gas > 0（不校验 USDC 保证金） */
export function isCopyFundingReady(snapshot: CopyFundingSnapshot): boolean {
  return snapshot.hasGas;
}

/** Runtime copy trading is stopped only by platform Gas depletion. */
export function isCopyFundingOperational(snapshot: CopyFundingSnapshot): boolean {
  return snapshot.hasGas;
}

export function describeCopyFundingOperationalFailure(snapshot: CopyFundingSnapshot): string {
  if (!snapshot.hasGas) {
    return '平台 Gas 已用尽，买单已跳过；有持仓时仍可跟卖，请充值 Gas 后恢复买入。';
  }
  if (!snapshot.hasOperationalUsdc) {
    return `Polymarket deposit 可用资金低于继续买入的最低要求（至少 $${snapshot.minUsdcRequiredToOperate} USDC）；买单会被跳过，但不会暂停跟单监听。`;
  }
  return '跟单资金不足，买单会被跳过。';
}
