import { CONFIG } from '../../config/env';

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeDisplayScore(
  copyabilityScore: number | null,
  smartMoneyScore: number,
  traderScore?: number | null
): number {
  // F8 / §15：displayScore = TraderScore 别名（产品主分；无独立加权公式）
  if (
    CONFIG.smartMoneyTraderScoreAsPrimary &&
    traderScore != null &&
    Number.isFinite(traderScore)
  ) {
    return roundScore(traderScore);
  }
  // 回落：v4 score 非产品主分，仅无 traderScore 时对照用
  if (CONFIG.smartMoneyScoreVersion.trim().toLowerCase().startsWith('v4')) {
    return roundScore(smartMoneyScore);
  }
  if (!CONFIG.smartMoneyCopyabilityEnabled || copyabilityScore == null) {
    return roundScore(smartMoneyScore);
  }
  const copyWeight = CONFIG.smartMoneyDisplayScoreCopyWeight;
  const smartWeight = CONFIG.smartMoneyDisplayScoreSmartWeight;
  const totalWeight = copyWeight + smartWeight;
  if (totalWeight <= 0) return roundScore(smartMoneyScore);
  return roundScore(
    (copyabilityScore * copyWeight + smartMoneyScore * smartWeight) / totalWeight
  );
}

/** @deprecated §15：rank 融合主路径默认关闭；仅 SMART_MONEY_RANK_MODEL_ENABLED=true 时使用 */
export function computeMlDisplayScore(
  copyabilityScore: number | null,
  rankScore: number
): number {
  if (!CONFIG.smartMoneyRankModelEnabled) {
    return roundScore(rankScore);
  }
  if (copyabilityScore == null) {
    return roundScore(rankScore);
  }
  const rankWeight = CONFIG.smartMoneyDisplayScoreRankWeight;
  const copyWeight = CONFIG.smartMoneyDisplayScoreCopyWeightMl;
  const totalWeight = rankWeight + copyWeight;
  if (totalWeight <= 0) return roundScore(rankScore);
  return roundScore((rankScore * rankWeight + copyabilityScore * copyWeight) / totalWeight);
}
