import type { DataApiPosition } from './polymarketData';
import {
  isConfirmedExpiredLoserPosition,
  isExpiredWorthlessPosition,
  isWorthlessRedeemablePosition,
  WORTHLESS_POSITION_VALUE_MAX_USD,
} from './positionVisibility';

export type SettlementStatus = 'active' | 'redeemable' | 'pending_settlement' | 'settled_loss';

export type SuggestedAction = 'close' | 'redeem' | 'wait' | 'none';

export function normalizePositionTokenId(tokenID: string): string {
  return tokenID.trim().toLowerCase();
}

export function positionValueUsdFromApi(p: DataApiPosition): number {
  const price = Number(p.curPrice ?? 0);
  const value = Number(p.currentValue ?? price * p.size);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export type DeriveSettlementContext = {
  apiPos: DataApiPosition | null;
  hasOpenLots: boolean;
  inDisplayRaw: boolean;
  isWorthlessHidden: boolean;
  isStaleHidden: boolean;
  isDustHidden: boolean;
};

export function deriveSettlementStatus(
  ctx: DeriveSettlementContext,
  now = new Date()
): SettlementStatus {
  const { apiPos, hasOpenLots, inDisplayRaw, isWorthlessHidden, isStaleHidden, isDustHidden } = ctx;

  if (apiPos && apiPos.size > 0 && apiPos.redeemable === true) {
    if (positionValueUsdFromApi(apiPos) > WORTHLESS_POSITION_VALUE_MAX_USD) {
      return 'redeemable';
    }
    return hasOpenLots ? 'settled_loss' : 'settled_loss';
  }

  if (
    inDisplayRaw &&
    apiPos &&
    apiPos.size > 0 &&
    !isWorthlessHidden &&
    !isStaleHidden &&
    !isDustHidden
  ) {
    return 'active';
  }

  if (apiPos && isConfirmedExpiredLoserPosition(apiPos, now)) {
    return 'settled_loss';
  }

  if (
    apiPos &&
    (isWorthlessHidden ||
      isWorthlessRedeemablePosition(apiPos) ||
      isExpiredWorthlessPosition(apiPos, now))
  ) {
    return hasOpenLots ? 'pending_settlement' : 'settled_loss';
  }

  if (isStaleHidden && hasOpenLots) {
    return 'pending_settlement';
  }

  if (hasOpenLots && (!apiPos || !(apiPos.size > 0))) {
    return 'pending_settlement';
  }

  if (apiPos && apiPos.size > 0 && !inDisplayRaw) {
    return 'pending_settlement';
  }

  return 'pending_settlement';
}

/** Subscription / single-token view without partition sets. */
export function deriveSettlementStatusFromApiPosition(
  apiPos: DataApiPosition | null,
  hasOpenLots: boolean,
  now = new Date()
): SettlementStatus {
  if (!apiPos || !(apiPos.size > 0)) {
    return hasOpenLots ? 'pending_settlement' : 'active';
  }

  if (apiPos.redeemable === true) {
    return positionValueUsdFromApi(apiPos) > WORTHLESS_POSITION_VALUE_MAX_USD
      ? 'redeemable'
      : 'settled_loss';
  }

  if (isConfirmedExpiredLoserPosition(apiPos, now) || isWorthlessRedeemablePosition(apiPos)) {
    return 'settled_loss';
  }

  if (isExpiredWorthlessPosition(apiPos, now)) {
    return 'pending_settlement';
  }

  const end = apiPos.endDate ? new Date(apiPos.endDate) : null;
  const curPrice = Number(apiPos.curPrice ?? 0);
  if (
    end &&
    !Number.isNaN(end.getTime()) &&
    end.getTime() <= now.getTime() &&
    (!Number.isFinite(curPrice) || curPrice <= 0)
  ) {
    return 'pending_settlement';
  }

  return 'active';
}

export function suggestedActionForStatus(status: SettlementStatus): SuggestedAction {
  switch (status) {
    case 'active':
      return 'close';
    case 'redeemable':
      return 'redeem';
    case 'pending_settlement':
      return 'wait';
    case 'settled_loss':
      return 'none';
    default:
      return 'none';
  }
}

export function canCloseForStatus(status: SettlementStatus): boolean {
  return status === 'active';
}

export function canRedeemForStatus(status: SettlementStatus): boolean {
  return status === 'redeemable';
}

export function settlementHintForStatus(status: SettlementStatus): string {
  switch (status) {
    case 'active':
      return '活跃市场，可通过平仓卖出。';
    case 'redeemable':
      return '市场已结算为赢面，请使用赎回换回 USDC。';
    case 'pending_settlement':
      return '市场已结束，正在等待 Polymarket 结算；暂不可平仓，赢面结算后将可赎回。';
    case 'settled_loss':
      return '该结果未命中或已无价值，系统将自动关账，无需操作。';
    default:
      return '';
  }
}

export type SettlementFields = {
  settlementStatus: SettlementStatus;
  settlementHint: string;
  suggestedAction: SuggestedAction;
  canClose: boolean;
  canRedeem: boolean;
};

export function buildSettlementFields(
  status: SettlementStatus,
  apiPos: DataApiPosition | null = null
): SettlementFields {
  void apiPos;
  return {
    settlementStatus: status,
    settlementHint: settlementHintForStatus(status),
    suggestedAction: suggestedActionForStatus(status),
    canClose: canCloseForStatus(status),
    canRedeem: canRedeemForStatus(status),
  };
}
