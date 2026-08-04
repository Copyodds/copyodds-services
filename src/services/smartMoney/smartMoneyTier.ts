/**
 * S/A/B/C/D 产品分层（方案 §6 / D5–D7 / §14.4 优秀画像 / §15）
 */
import { CONFIG } from '../../config/env';
import { hasEnoughEdgeSampleForSA } from './smartMoneyEdge';
import type { SmartMoneyTraderType } from './smartMoneyTraderType';

export type SmartMoneyTier = 'S' | 'A' | 'B' | 'C' | 'D';

export const TIER_LABEL_ZH: Record<SmartMoneyTier, string> = {
  S: '顶级聪明资金',
  A: '强推荐跟单',
  B: '高收益观察',
  C: '普通',
  D: '一般 / 高风险',
};

export type SmartMoneyTierInput = {
  traderScore: number;
  edgeScore: number;
  edgeSampleN: number;
  copyabilityMissing: boolean;
  copyabilityScore: number | null;
  traderType: SmartMoneyTraderType;
  hasHardRiskFlag: boolean;
  top1MarketPnlShare: number | null;
  /** 累计成交额（证据不足时限档） */
  totalVolumeUsd?: number | null;
  /** 低于该成交额 → 最高档 ≤C；默认 $10k */
  lowEvidenceVolumeUsd?: number | null;
  /** 独立已结算市场数（S/A 优秀画像） */
  closedMarketCount?: number | null;
  /** 账户存活天数（S/A 优秀画像） */
  activeDays?: number | null;
  /** 已平仓胜率（用于「假 100%」路径风险降档） */
  closedWinRate?: number | null;
  maxDrawdownPercent?: number | null;
  hasRealizedOpenWinRateGap?: boolean;
  /** 近 1Y/30D/7D 窗净盈（S/A 三窗非负） */
  pnl1yUsd?: number | null;
  pnl30dUsd?: number | null;
  pnl7dUsd?: number | null;
  /** 中位成交名义（S/A 置信度门） */
  medianNotionalUsd?: number | null;
  /** MDD 不可测 → 最高 B */
  mddUnmeasurable?: boolean;
};

export type SmartMoneyTierResult = {
  tier: SmartMoneyTier;
  labelZh: string;
  recommendationStars: number;
  cappedBy: string[];
};

function clampTier(tier: SmartMoneyTier, max: SmartMoneyTier): SmartMoneyTier {
  const order: SmartMoneyTier[] = ['S', 'A', 'B', 'C', 'D'];
  return order[Math.max(order.indexOf(tier), order.indexOf(max))];
}

/**
 * 分位友好的分数→档位初判（非通胀：TraderScore 本身应按真实分布落位）
 * S≥78, A≥68, B≥58, C≥48, else D
 */
export function scoreToBaseTier(traderScore: number): SmartMoneyTier {
  if (traderScore >= 78) return 'S';
  if (traderScore >= 68) return 'A';
  if (traderScore >= 58) return 'B';
  if (traderScore >= 48) return 'C';
  return 'D';
}

/**
 * §14.4.3 C：S/A 优秀画像强化（不满足则降档，不作入榜硬门）。
 * S 起步：Edge≥65 ∧ n≥15 ∧ 市场≥30 ∧ 存活≥90 ∧ copy≥55 ∧ top1<50%
 * A：Edge≥55 ∧ n≥8 ∧ 市场≥15 ∧ 存活≥60 ∧ copy≥40
 */
function applyExcellentPortraitCap(
  tier: SmartMoneyTier,
  input: SmartMoneyTierInput,
  cappedBy: string[]
): SmartMoneyTier {
  if (tier !== 'S' && tier !== 'A') return tier;

  const closed = input.closedMarketCount ?? 0;
  const activeDays = input.activeDays ?? 0;
  const copy = input.copyabilityScore;
  const top1 = input.top1MarketPnlShare;

  if (tier === 'S') {
    const sOk =
      input.edgeScore >= 65 &&
      input.edgeSampleN >= 15 &&
      closed >= 30 &&
      activeDays >= 90 &&
      !input.copyabilityMissing &&
      copy != null &&
      copy >= 55 &&
      (top1 == null || top1 < 0.5);
    if (!sOk) {
      cappedBy.push('EXCELLENT_PORTRAIT_S');
      // 未达 S 画像 → 尝试 A；再由 A 画像决定是否落到 B
      return applyExcellentPortraitCap('A', input, cappedBy);
    }
    return 'S';
  }

  // A
  const aOk =
    input.edgeScore >= 55 &&
    hasEnoughEdgeSampleForSA(input.edgeSampleN) &&
    closed >= 15 &&
    activeDays >= 60 &&
    !input.copyabilityMissing &&
    copy != null &&
    copy >= 40;
  if (!aOk) {
    cappedBy.push('EXCELLENT_PORTRAIT_A');
    return 'B';
  }
  return 'A';
}

export function resolveSmartMoneyTier(input: SmartMoneyTierInput): SmartMoneyTierResult {
  const cappedBy: string[] = [];
  let tier = scoreToBaseTier(input.traderScore);

  // 高收益但 Edge 弱 → 最多 B（「高收益观察」）
  if (
    (tier === 'S' || tier === 'A') &&
    input.edgeScore < 55 &&
    input.traderScore >= 58
  ) {
    tier = 'B';
    cappedBy.push('EDGE_WEAK_HIGH_RETURN');
  }

  if (!hasEnoughEdgeSampleForSA(input.edgeSampleN) && (tier === 'S' || tier === 'A')) {
    tier = 'B';
    cappedBy.push('EDGE_SAMPLE_INSUFFICIENT');
  }

  // D5：缺 copyability → ≤C
  if (input.copyabilityMissing || input.copyabilityScore == null) {
    const before = tier;
    tier = clampTier(tier, 'C');
    if (tier !== before) cappedBy.push('COPYABILITY_MISSING');
  } else if (input.copyabilityScore < 35 && (tier === 'S' || tier === 'A')) {
    tier = 'B';
    cappedBy.push('COPYABILITY_LOW');
  }

  // D7：赌博型 ≤B；做市型 ≤C
  if (input.traderType === 'GAMBLER') {
    const before = tier;
    tier = clampTier(tier, 'B');
    if (tier !== before) cappedBy.push('TYPE_GAMBLER');
  }
  if (input.traderType === 'MARKET_MAKER') {
    const before = tier;
    tier = clampTier(tier, 'C');
    if (tier !== before) cappedBy.push('TYPE_MARKET_MAKER');
  }

  if (input.hasHardRiskFlag && (tier === 'S' || tier === 'A')) {
    tier = 'C';
    cappedBy.push('HARD_RISK_FLAG');
  }

  // 已平仓≈100% 但 MDD≥25% 或已平仓/未平仓胜率缺口大 → S/A 降到 B
  if (
    (tier === 'S' || tier === 'A') &&
    input.closedWinRate != null &&
    input.closedWinRate >= 0.99 &&
    ((input.maxDrawdownPercent != null && input.maxDrawdownPercent >= 0.25) ||
      input.hasRealizedOpenWinRateGap === true)
  ) {
    tier = 'B';
    cappedBy.push('PERFECT_CLOSED_WR_PATH_RISK');
  }

  if (
    input.top1MarketPnlShare != null &&
    input.top1MarketPnlShare >= 0.7 &&
    (tier === 'S' || tier === 'A')
  ) {
    tier = 'B';
    cappedBy.push('SINGLE_EVENT_CONCENTRATION');
  }

  // §5A.3：成交额过小 → 证据不足，最高档 ≤C（不作加分，仅限档）
  const volumeFloor =
    input.lowEvidenceVolumeUsd != null && Number.isFinite(input.lowEvidenceVolumeUsd)
      ? input.lowEvidenceVolumeUsd
      : 10_000;
  if (
    input.totalVolumeUsd != null &&
    Number.isFinite(input.totalVolumeUsd) &&
    input.totalVolumeUsd < volumeFloor
  ) {
    const before = tier;
    tier = clampTier(tier, 'C');
    if (tier !== before) cappedBy.push('LOW_EVIDENCE_VOLUME');
  }

  // §14.4 / S2：优秀画像强化 S/A（绝对 PnL/ROI 不作否决）
  if (tier === 'S' || tier === 'A') {
    tier = applyExcellentPortraitCap(tier, input, cappedBy);
  }

  // 管道优化：S/A 必须三窗齐全且盈利 + 可测 MDD 上限 + 中位成交
  if (tier === 'S' || tier === 'A') {
    tier = applySaTrustCaps(tier, input, cappedBy);
  }

  const stars =
    tier === 'S' ? 5 : tier === 'A' ? 4 : tier === 'B' ? 3 : tier === 'C' ? 2 : 1;

  return {
    tier,
    labelZh: TIER_LABEL_ZH[tier],
    recommendationStars: stars,
    cappedBy,
  };
}

function applySaTrustCaps(
  tier: SmartMoneyTier,
  input: SmartMoneyTierInput,
  cappedBy: string[]
): SmartMoneyTier {
  if (tier !== 'S' && tier !== 'A') return tier;

  if (input.mddUnmeasurable === true || input.maxDrawdownPercent == null) {
    cappedBy.push('MDD_UNMEASURABLE');
    return 'B';
  }
  // 默认 MDD≥40% 即封顶 B；高回撤阈值（默认 70%）同样封顶（双保险）
  const mddSaCap = CONFIG.smartMoneyTierSaMaxMddPct;
  const mddHigh = CONFIG.smartMoneyScoreHighMddPct;
  if (mddSaCap > 0 && input.maxDrawdownPercent >= mddSaCap) {
    cappedBy.push('MDD_SA_CAP');
    return 'B';
  }
  if (mddHigh > 0 && input.maxDrawdownPercent >= mddHigh) {
    cappedBy.push('HIGH_MDD_SA');
    return 'B';
  }

  // S/A：7D / 30D / 1Y（ALL 近窗）必须齐全且均为盈利；缺数或任一亏损 → ≤B
  if (input.pnl1yUsd == null || input.pnl30dUsd == null || input.pnl7dUsd == null) {
    cappedBy.push('WINDOW_PNL_SA_MISSING');
    return 'B';
  }
  if (input.pnl1yUsd <= 0 || input.pnl30dUsd <= 0 || input.pnl7dUsd <= 0) {
    cappedBy.push('WINDOW_PNL_SA');
    return 'B';
  }

  // S/A 主推仍要求中位够大（默认可跟单）；缺数或过小 → ≤B
  if (CONFIG.smartMoneyTierSaMinMedianNotionalUsd > 0) {
    if (
      input.medianNotionalUsd == null ||
      input.medianNotionalUsd < CONFIG.smartMoneyTierSaMinMedianNotionalUsd
    ) {
      cappedBy.push('MEDIAN_NOTIONAL_SA');
      return 'B';
    }
  }

  return tier;
}

/** 做市型不进主推筛选（S/A） */
export function isMainPushTier(tier: SmartMoneyTier, traderType: SmartMoneyTraderType): boolean {
  if (traderType === 'MARKET_MAKER') return false;
  return tier === 'S' || tier === 'A';
}
