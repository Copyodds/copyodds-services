/**
 * Trader Score 卡片：原因 / 风险 bullet 模板化生成（方案 §6.2）
 * 因子数值由详情页进度条展示；reasons 只保留定性入榜理由，避免重复。
 */
import type { SmartMoneyEdgeResult } from './smartMoneyEdge';
import type { TraderScorePenaltyItem, TraderScoreResult } from './smartMoneyTraderScore';
import type { SmartMoneyTraderTypeResult } from './smartMoneyTraderType';
import type { SmartMoneyTierResult } from './smartMoneyTier';
import { traderTypeLabelZh } from './smartMoneyTraderType';

export type SmartMoneyTraderCard = {
  traderScore: number;
  tier: string;
  tierLabelZh: string;
  recommendationStars: number;
  suitableFor: string;
  traderType: string;
  traderTypeLabelZh: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  riskLevelLabelZh: string;
  /** 定性入榜原因（不含因子分数条重复内容） */
  reasons: string[];
  risks: string[];
  disclaimer: string;
  /** 多因子分项（演进公式）；详情页优先展示 */
  factors?: {
    edge: number;
    profitability: number;
    copyability: number;
    drawdownHealth: number;
    survivalConsistency: number;
  };
  /** 博彩/集中度等综合扣分（0~30） */
  penalty?: number;
  /** 扣分明细：扣在哪里、为什么 */
  penaltyItems?: TraderScorePenaltyItem[];
  formula?: 'legacy' | 'next';
};

export type BuildTraderCardInput = {
  edge: SmartMoneyEdgeResult;
  traderScore: TraderScoreResult;
  traderType: SmartMoneyTraderTypeResult;
  tier: SmartMoneyTierResult;
  activeDays: number | null;
  totalReturn: number | null;
  /** 已平仓胜率：用于假满分路径风险提示（入榜原因不写胜率） */
  closedWinRate?: number | null;
  hasRealizedOpenWinRateGap?: boolean;
  maxDrawdownPercent: number | null;
  top1MarketPnlShare: number | null;
  dominantCategory: string | null;
};

/** 已平仓≈100% 但路径风险大：卡片风险提示用 */
export function shouldSuppressPerfectWinRateClaim(input: {
  closedWinRate?: number | null;
  maxDrawdownPercent?: number | null;
  hasRealizedOpenWinRateGap?: boolean;
}): boolean {
  const closed = input.closedWinRate;
  if (closed == null || !Number.isFinite(closed) || closed < 0.99) return false;
  const highMdd = input.maxDrawdownPercent != null && input.maxDrawdownPercent >= 0.25;
  return highMdd || input.hasRealizedOpenWinRateGap === true;
}

function riskLevelFrom(input: BuildTraderCardInput): {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  labelZh: string;
} {
  if (
    input.traderType.traderType === 'GAMBLER' ||
    input.traderType.traderType === 'MARKET_MAKER' ||
    input.tier.tier === 'D' ||
    (input.maxDrawdownPercent != null && input.maxDrawdownPercent >= 0.45)
  ) {
    return { riskLevel: 'HIGH', labelZh: '高' };
  }
  if (
    input.tier.tier === 'C' ||
    input.tier.tier === 'B' ||
    (input.maxDrawdownPercent != null && input.maxDrawdownPercent >= 0.25) ||
    (input.top1MarketPnlShare != null && input.top1MarketPnlShare >= 0.5)
  ) {
    return { riskLevel: 'MEDIUM', labelZh: '中' };
  }
  return { riskLevel: 'LOW', labelZh: '低' };
}

function suitableFor(tier: string, traderType: string): string {
  if (traderType === 'MARKET_MAKER') return '不适合普通用户跟单';
  if (traderType === 'GAMBLER') return '仅适合高风险偏好用户观察';
  if (tier === 'S' || tier === 'A') return '普通用户跟单';
  if (tier === 'B') return '观察为主，谨慎跟单';
  return '谨慎观察';
}

export function buildSmartMoneyTraderCard(input: BuildTraderCardInput): SmartMoneyTraderCard {
  const reasons: string[] = [];
  const risks: string[] = [];
  const f = input.traderScore.factors;
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '—');

  // —— 入榜原因：定性综合，不与因子进度条重复报分 ——
  if (f.edge >= 60 && input.edge.edgeSampleN > 0) {
    reasons.push(
      `预测能力较强：Edge ${
        input.edge.edgeBar != null
          ? `${input.edge.edgeBar >= 0 ? '+' : ''}${input.edge.edgeBar.toFixed(2)}`
          : '—'
      }，覆盖 ${input.edge.edgeSampleN} 个已结算市场`
    );
  } else if (f.edge >= 55) {
    reasons.push('预测能力达到入榜可用水平');
  }

  if (f.profitability >= 60) {
    reasons.push('盈利质量较好（回报 / 近窗动量 / 盈亏比综合）');
  }

  if (!input.traderScore.copyabilityMissing && f.copyability >= 55) {
    reasons.push(
      f.copyability >= 70 ? '可复制性较高：仿真跟单表现较好' : '可复制性尚可：仿真跟单表现一般'
    );
  }

  if (f.drawdownHealth >= 60) {
    const mddPct =
      input.maxDrawdownPercent != null && Number.isFinite(input.maxDrawdownPercent)
        ? Math.round(input.maxDrawdownPercent * 100)
        : null;
    reasons.push(
      mddPct != null ? `风险控制较好：峰权益回撤 ${mddPct}%` : '回撤健康度较好'
    );
  }

  if (f.survivalConsistency >= 60 && input.activeDays != null && input.activeDays >= 60) {
    reasons.push(`${Math.round(input.activeDays)} 天持续交易样本`);
  } else if (input.activeDays != null && input.activeDays >= 90) {
    reasons.push(`${Math.round(input.activeDays)} 天持续交易样本`);
  }

  if (input.top1MarketPnlShare != null && input.top1MarketPnlShare < 0.35) {
    reasons.push(`非单次事件驱动（Top1 事件占比 ${Math.round(input.top1MarketPnlShare * 100)}%）`);
  }
  if (input.traderType.traderType === 'INFORMATION') {
    reasons.push('类型为信息型（提前布局特征）');
  }
  if (input.tier.tier === 'S' || input.tier.tier === 'A') {
    reasons.push(`综合达到 ${input.tier.tier} 档推荐门槛`);
  }
  if (reasons.length === 0) {
    reasons.push('已过入榜门槛，可结合因子得分与风险提示自行判断');
  }

  const suppressPerfectWr = shouldSuppressPerfectWinRateClaim(input);
  if (suppressPerfectWr) {
    risks.push('已平仓胜率近满分，但回撤或未平仓差距较大，不宜按「全胜」理解');
  }
  if (input.traderScore.copyabilityMissing) {
    risks.push('跟单仿真样本不足，可复制性待补齐');
  }
  if (input.edge.edgeSampleN < 8) {
    risks.push('已结算市场样本偏少，预测能力证据不足');
  }
  if (input.top1MarketPnlShare != null && input.top1MarketPnlShare >= 0.5) {
    risks.push(`收益较集中：Top1 事件占比 ${Math.round(input.top1MarketPnlShare * 100)}%`);
  }
  if (input.dominantCategory) {
    risks.push(`偏 ${input.dominantCategory} 市场，品类波动可能加大`);
  }
  if (input.traderType.traderType === 'GAMBLER') {
    risks.push('疑似事件押注型，谨慎跟单');
  }
  if (input.traderType.traderType === 'MARKET_MAKER') {
    risks.push('疑似做市/高频，不适合普通跟单');
  }
  if (input.maxDrawdownPercent != null && input.maxDrawdownPercent >= 0.35) {
    risks.push(`历史回撤偏高（${Math.round(input.maxDrawdownPercent * 100)}%）`);
  }
  if ((input.traderScore.penalty ?? 0) >= 12) {
    risks.push(`博彩/集中度特征扣分较高（−${fmt(input.traderScore.penalty)}）`);
  }
  risks.push('历史表现不代表未来；跟单前请设置资金上限');

  const risk = riskLevelFrom(input);

  return {
    traderScore: input.traderScore.traderScore,
    tier: input.tier.tier,
    tierLabelZh: input.tier.labelZh,
    recommendationStars: input.tier.recommendationStars,
    suitableFor: suitableFor(input.tier.tier, input.traderType.traderType),
    traderType: input.traderType.traderType,
    traderTypeLabelZh: traderTypeLabelZh(input.traderType.traderType),
    riskLevel: risk.riskLevel,
    riskLevelLabelZh: risk.labelZh,
    reasons: reasons.slice(0, 6),
    risks: risks.slice(0, 6),
    disclaimer: '跟单有风险，是否跟随由你决定',
    factors: {
      edge: f.edge,
      profitability: f.profitability,
      copyability: f.copyability,
      drawdownHealth: f.drawdownHealth,
      survivalConsistency: f.survivalConsistency,
    },
    penalty: input.traderScore.penalty,
    penaltyItems: input.traderScore.penaltyItems ?? [],
    formula: input.traderScore.formula,
  };
}
