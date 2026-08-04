import type { DataApiPosition } from './polymarketData';

export type PositionCategory = 'active_manual_close' | 'resolved_redeemable';

export type ClassifiedPosition = DataApiPosition & {
  category: PositionCategory;
};

/**
 * 活跃市场：有余额且尚未可 redeem → 走 CLOB 手动 SELL。
 * 已结束可结算：Data API 标记 redeemable → 走链上 redeem（非 CLOB）。
 */
export function classifyPosition(p: DataApiPosition): PositionCategory {
  if (p.size <= 0) return 'active_manual_close';
  if (p.redeemable === true) return 'resolved_redeemable';
  return 'active_manual_close';
}

export function classifyPositions(positions: DataApiPosition[]): ClassifiedPosition[] {
  return positions
    .filter((p) => p.size > 0)
    .map((p) => ({
      ...p,
      category: classifyPosition(p),
    }));
}
