/**
 * 策略类型识别（方案 §5C / D7）：纯规则标签，不直接改 TraderScore 数值。
 */
export type SmartMoneyTraderType =
  | 'INFORMATION'
  | 'ARBITRAGE'
  | 'GAMBLER'
  | 'MARKET_MAKER'
  | 'GENERAL';

export type SmartMoneyTraderTypeInput = {
  edgeScore: number;
  edgeSampleN: number;
  medianHoldingSec: number | null;
  tradesPerDay1D: number | null;
  trades7d: number | null;
  top1MarketPnlShare: number | null;
  hasHedgedPairFlag: boolean;
  hasHighTradeFrequencyFlag: boolean;
  extremeOddsShare: number | null;
  totalReturn: number | null;
  maxDrawdownPercent: number | null;
};

export type SmartMoneyTraderTypeResult = {
  traderType: SmartMoneyTraderType;
  labelZh: string;
  reasons: string[];
};

const TYPE_LABEL_ZH: Record<SmartMoneyTraderType, string> = {
  INFORMATION: '信息型',
  ARBITRAGE: '套利型',
  GAMBLER: '赌博型',
  MARKET_MAKER: '做市型',
  GENERAL: '综合型',
};

export function classifySmartMoneyTraderType(
  input: SmartMoneyTraderTypeInput
): SmartMoneyTraderTypeResult {
  const reasons: string[] = [];
  const tradesPerDay =
    input.tradesPerDay1D ??
    (input.trades7d != null ? input.trades7d / 7 : null);
  const holdingDays =
    input.medianHoldingSec != null ? input.medianHoldingSec / 86400 : null;

  // 做市型：高频 + 短持仓 / 对冲
  if (
    input.hasHighTradeFrequencyFlag ||
    (tradesPerDay != null && tradesPerDay >= 80 && (holdingDays == null || holdingDays < 1))
  ) {
    reasons.push('高频或极短持仓，疑似做市/刷量');
    return { traderType: 'MARKET_MAKER', labelZh: TYPE_LABEL_ZH.MARKET_MAKER, reasons };
  }

  // 赌博型：单事件集中 + 极端赔率 / 短样本暴利
  const concentrated =
    input.top1MarketPnlShare != null && input.top1MarketPnlShare >= 0.55;
  const extremeOdds = input.extremeOddsShare != null && input.extremeOddsShare >= 0.35;
  const shortSampleBoom =
    input.edgeSampleN > 0 &&
    input.edgeSampleN < 8 &&
    input.totalReturn != null &&
    input.totalReturn >= 0.8;
  if (concentrated && (extremeOdds || shortSampleBoom || input.edgeScore < 48)) {
    if (concentrated) reasons.push('收益高度集中于少数事件');
    if (extremeOdds) reasons.push('大量极端赔率入场');
    if (shortSampleBoom) reasons.push('短样本暴利，证据不足');
    return { traderType: 'GAMBLER', labelZh: TYPE_LABEL_ZH.GAMBLER, reasons };
  }

  // 套利型：对冲/配对 + 稳 + 交易偏多
  if (
    input.hasHedgedPairFlag ||
    (tradesPerDay != null &&
      tradesPerDay >= 20 &&
      input.maxDrawdownPercent != null &&
      input.maxDrawdownPercent <= 0.15 &&
      (input.totalReturn == null || input.totalReturn <= 0.4))
  ) {
    reasons.push(input.hasHedgedPairFlag ? '存在对冲/配对敞口' : '交易频繁且回撤低、单笔收益偏稳');
    return { traderType: 'ARBITRAGE', labelZh: TYPE_LABEL_ZH.ARBITRAGE, reasons };
  }

  // 信息型：高 Edge + 持仓偏长 + 不过度高频
  if (
    input.edgeSampleN >= 8 &&
    input.edgeScore >= 58 &&
    (holdingDays == null || holdingDays >= 2) &&
    (tradesPerDay == null || tradesPerDay < 50)
  ) {
    reasons.push('预测优势显著，持仓偏长，交易节奏适中');
    return { traderType: 'INFORMATION', labelZh: TYPE_LABEL_ZH.INFORMATION, reasons };
  }

  reasons.push('特征不明显，归为综合型');
  return { traderType: 'GENERAL', labelZh: TYPE_LABEL_ZH.GENERAL, reasons };
}

export function traderTypeLabelZh(type: SmartMoneyTraderType): string {
  return TYPE_LABEL_ZH[type];
}
