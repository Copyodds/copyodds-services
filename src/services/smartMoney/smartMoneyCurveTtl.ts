/**
 * 详情曲线 TTL 读穿：未过期用 DB，过期则 live 回写。
 */
import { CONFIG } from '../../config/env';

export type CurvePeriod = '1D' | '1W' | '1M' | 'ALL';

export function curveTtlMsForPeriod(period: CurvePeriod): number {
  switch (period) {
    case '1D':
      return CONFIG.smartMoneyCurve1dTtlMs;
    case '1W':
      return CONFIG.smartMoneyCurve1wTtlMs;
    case '1M':
      return CONFIG.smartMoneyCurve1mTtlMs;
    case 'ALL':
      return CONFIG.smartMoneyCurveAllTtlMs;
    default:
      return CONFIG.smartMoneyCurve1dTtlMs;
  }
}

export function isCurveFresh(fetchedAt: Date | null | undefined, period: CurvePeriod): boolean {
  if (fetchedAt == null) return false;
  return Date.now() - fetchedAt.getTime() < curveTtlMsForPeriod(period);
}

export function curveTypeForPeriod(period: CurvePeriod): string {
  return `PORTFOLIO_PNL_${period}`;
}
