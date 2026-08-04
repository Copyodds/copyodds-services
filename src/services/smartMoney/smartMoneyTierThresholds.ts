import { CONFIG } from '../../config/env';

export type SmartMoneyTierThresholds = {
  minHoldingsValue: number;
  minPredictionCount: number;
  minCurvePointCount: number;
  tier1fMinTrades30d: number;
  tier1fMinDataConfidence: number;
  tier2MinTotalReturn: number;
  tier2MaxDrawdown: number;
  tier2MinCalmar: number;
  tier2MinVolume: number;
  /** 评分池 C1：总盈利美元下限 */
  scorePoolMinPnl1y: number;
  scorePoolMinLifetimeVolume: number;
  /** 评分池 C4：胜率下限（比率） */
  scorePoolMinWinRate: number;
  /** 评分池 C5：盈亏比下限 */
  scorePoolMinProfitFactor: number;
  /** 评分池 C6：近 7 日成交笔数 */
  scorePoolMinTrades7d: number;
  scorePoolMinTrades30d: number;
  /** 评分池 C8：已平仓市场样本 */
  scorePoolMinClosedMarkets: number;
  minClosedMarketsForEligibility: number;
  minHighReturnMarketShare: number;
  minLiquidityClassificationShare: number;
  minHighVolumeMarketShare: number;
};

let cachedOverrides: Partial<SmartMoneyTierThresholds> = {};

function defaultThresholds(): SmartMoneyTierThresholds {
  return {
    minHoldingsValue: CONFIG.smartMoneyMinHoldingsValue,
    minPredictionCount: CONFIG.smartMoneyMinPredictionCount,
    minCurvePointCount: CONFIG.smartMoneyMinCurvePointCount,
    tier1fMinTrades30d: CONFIG.smartMoneyTier1fMinTrades30d,
    tier1fMinDataConfidence: CONFIG.smartMoneyTier1fMinDataConfidence,
    tier2MinTotalReturn: CONFIG.smartMoneyTier2MinTotalReturn,
    tier2MaxDrawdown: CONFIG.smartMoneyTier2MaxDrawdown,
    tier2MinCalmar: CONFIG.smartMoneyTier2MinCalmar,
    tier2MinVolume: CONFIG.smartMoneyTier2MinVolume,
    scorePoolMinPnl1y: CONFIG.smartMoneyScorePoolMinPnl1y,
    scorePoolMinLifetimeVolume: CONFIG.smartMoneyScorePoolMinLifetimeVolume,
    scorePoolMinWinRate: CONFIG.smartMoneyScorePoolMinWinRate,
    scorePoolMinProfitFactor: CONFIG.smartMoneyScorePoolMinProfitFactor,
    scorePoolMinTrades7d: CONFIG.smartMoneyScorePoolMinTrades7d,
    scorePoolMinTrades30d: CONFIG.smartMoneyScorePoolMinTrades30d,
    scorePoolMinClosedMarkets: CONFIG.smartMoneyScorePoolMinClosedMarkets,
    minClosedMarketsForEligibility: CONFIG.smartMoneyMinClosedMarketsForEligibility,
    minHighReturnMarketShare: CONFIG.smartMoneyMinHighReturnMarketShare,
    minLiquidityClassificationShare: CONFIG.smartMoneyMinLiquidityClassificationShare,
    minHighVolumeMarketShare: CONFIG.smartMoneyMinHighVolumeMarketShare,
  };
}

export function getSmartMoneyTierThresholds(): SmartMoneyTierThresholds {
  return {
    ...defaultThresholds(),
    ...cachedOverrides,
  };
}

export function applySmartMoneyTierThresholdOverrides(
  overrides: Partial<SmartMoneyTierThresholds>
): void {
  cachedOverrides = overrides;
}

export function clearSmartMoneyTierThresholdOverrides(): void {
  cachedOverrides = {};
}

export function pickSmartMoneyTierThresholds(raw: unknown): Partial<SmartMoneyTierThresholds> {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const keys = Object.keys(defaultThresholds()) as Array<keyof SmartMoneyTierThresholds>;
  const picked: Partial<SmartMoneyTierThresholds> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      picked[key] = value;
    }
  }
  return picked;
}
