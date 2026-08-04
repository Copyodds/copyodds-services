import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.SMART_MONEY_TRADER_SCORE_AS_PRIMARY = 'true';

async function main(): Promise<void> {
  const { computeMarketEntryEdge, computeSmartMoneyEdge } = await import('./smartMoneyEdge');
  const { computeTraderScore } = await import('./smartMoneyTraderScore');
  const { classifySmartMoneyTraderType } = await import('./smartMoneyTraderType');
  const { resolveSmartMoneyTier, scoreToBaseTier } = await import('./smartMoneyTier');
  const { assembleSmartMoneyTraderProfile } = await import('./smartMoneyTraderProfile');
  const { computeDisplayScore } = await import('./smartMoneyDisplayScore');
  type DataApiPosition = import('../polymarket/polymarketData').DataApiPosition;

  function closedRow(partial: Partial<DataApiPosition> & { conditionId: string }): DataApiPosition {
    return {
      asset: partial.asset ?? partial.conditionId,
      conditionId: partial.conditionId,
      size: partial.size ?? 100,
      avgPrice: partial.avgPrice,
      redeemable: true,
      ...partial,
    } as DataApiPosition;
  }

  const winEdge = computeMarketEntryEdge(
    closedRow({
      conditionId: 'c1',
      avgPrice: 0.3,
      realizedPnl: 70,
      initialValue: 30,
    })
  );
  assert.ok(winEdge);
  assert.ok(Math.abs(winEdge!.edge - 0.7) < 1e-6);
  assert.equal(winEdge!.won, true);

  const smallSample = computeSmartMoneyEdge([
    closedRow({ conditionId: 'a', avgPrice: 0.2, realizedPnl: 80, initialValue: 20 }),
    closedRow({ conditionId: 'b', avgPrice: 0.25, realizedPnl: 75, initialValue: 25 }),
    closedRow({ conditionId: 'c', avgPrice: 0.3, realizedPnl: 70, initialValue: 30 }),
  ]);
  assert.equal(smallSample.edgeSampleN, 3);
  assert.ok(smallSample.edgeScore < 70);
  assert.ok(smallSample.edgeScore > 50);

  const multi = computeSmartMoneyEdge(
    Array.from({ length: 40 }, (_, i) =>
      closedRow({
        conditionId: `m${i}`,
        avgPrice: 0.45,
        realizedPnl: 10,
        initialValue: 45,
      })
    )
  );
  assert.equal(multi.edgeSampleN, 40);
  assert.ok(multi.edgeScore > 60);

  const good = computeTraderScore({
    edgeScore: 70,
    edgeSampleN: 40,
    totalReturn: 0.4,
    profitFactor: 2,
    winRate: 0.6,
    closedMarketCount: 40,
    copyabilityScore: 70,
    copyabilityMissing: false,
    activeDays: 200,
    maxDrawdownPercent: 0.15,
    consistencyScore: 70,
    top1MarketPnlShare: 0.2,
    hasHighTradeFrequencyFlag: false,
    hasHedgedPairFlag: false,
    hasBlacklistedFlag: false,
    extremeOddsShare: 0.05,
  });
  assert.ok(good.traderScore > 60);
  assert.equal(good.penalty, 0);

  const { computeHighMddScorePenalty } = await import('./smartMoneyTraderScore');
  assert.equal(computeHighMddScorePenalty(0.69), 0);
  assert.equal(computeHighMddScorePenalty(0.7), 18);
  assert.equal(computeHighMddScorePenalty(1), 28);

  const highMdd = computeTraderScore({
    edgeScore: 70,
    edgeSampleN: 40,
    totalReturn: 0.4,
    profitFactor: 2,
    winRate: 0.6,
    closedMarketCount: 40,
    copyabilityScore: 70,
    copyabilityMissing: false,
    activeDays: 200,
    maxDrawdownPercent: 1,
    consistencyScore: 70,
    top1MarketPnlShare: 0.2,
    hasHighTradeFrequencyFlag: false,
    hasHedgedPairFlag: false,
    hasBlacklistedFlag: false,
    extremeOddsShare: 0.05,
  });
  assert.ok(highMdd.windowAdjust <= -28);
  assert.ok(highMdd.traderScore < good.traderScore - 20);

  // 高分号：100% 回撤大幅减分后仍可过入池线 50（硬门已关）
  const strongHighMdd = computeTraderScore({
    edgeScore: 88,
    edgeSampleN: 80,
    totalReturn: 0.8,
    profitFactor: 2.8,
    winRate: 0.65,
    closedMarketCount: 80,
    copyabilityScore: 85,
    copyabilityMissing: false,
    activeDays: 300,
    maxDrawdownPercent: 1,
    consistencyScore: 80,
    top1MarketPnlShare: 0.15,
    hasHighTradeFrequencyFlag: false,
    hasHedgedPairFlag: false,
    hasBlacklistedFlag: false,
    extremeOddsShare: 0.05,
  });
  assert.ok(strongHighMdd.traderScore >= 50);

  const missingCopy = computeTraderScore({
    edgeScore: 70,
    edgeSampleN: 40,
    totalReturn: 0.4,
    profitFactor: 2,
    winRate: 0.6,
    closedMarketCount: 40,
    copyabilityScore: null,
    copyabilityMissing: true,
    activeDays: 200,
    maxDrawdownPercent: 0.15,
    consistencyScore: 70,
    top1MarketPnlShare: 0.2,
    hasHighTradeFrequencyFlag: false,
    hasHedgedPairFlag: false,
    hasBlacklistedFlag: false,
    extremeOddsShare: null,
  });
  assert.equal(missingCopy.factors.copyability, 30);
  assert.equal(missingCopy.copyabilityMissing, true);

  assert.equal(scoreToBaseTier(80), 'S');
  assert.equal(scoreToBaseTier(70), 'A');
  assert.equal(scoreToBaseTier(60), 'B');
  assert.equal(scoreToBaseTier(50), 'C');
  assert.equal(scoreToBaseTier(40), 'D');

  const capped = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: true,
    copyabilityScore: null,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 40,
    activeDays: 200,
  });
  assert.equal(capped.tier, 'C');
  assert.ok(capped.cappedBy.includes('COPYABILITY_MISSING'));

  const gambler = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'GAMBLER',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 40,
    activeDays: 200,
  });
  assert.equal(gambler.tier, 'B');
  assert.equal(gambler.labelZh, '高收益观察');

  // §14.4 优秀画像：分够 S 但市场/存活不足 → 降档
  const portraitMiss = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 10,
    activeDays: 30,
  });
  assert.equal(portraitMiss.tier, 'B');
  assert.ok(portraitMiss.cappedBy.some((x) => x.startsWith('EXCELLENT_PORTRAIT')));

  const portraitS = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 35,
    activeDays: 200,
    maxDrawdownPercent: 0.2,
    medianNotionalUsd: 80,
    pnl1yUsd: 5000,
    pnl30dUsd: 200,
    pnl7dUsd: 50,
  });
  assert.equal(portraitS.tier, 'S');

  // 7D 亏损 → S/A 封顶 B（三窗必须都盈利）
  const weekLoss = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 35,
    activeDays: 200,
    maxDrawdownPercent: 0.2,
    medianNotionalUsd: 80,
    pnl1yUsd: 5000,
    pnl30dUsd: 200,
    pnl7dUsd: -20,
  });
  assert.equal(weekLoss.tier, 'B');
  assert.ok(weekLoss.cappedBy.includes('WINDOW_PNL_SA'));

  // 缺 7D 窗 → 也不能上 S/A（以前缺数会跳过检查）
  const weekMissing = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 35,
    activeDays: 200,
    maxDrawdownPercent: 0.2,
    medianNotionalUsd: 80,
    pnl1yUsd: 5000,
    pnl30dUsd: 200,
  });
  assert.equal(weekMissing.tier, 'B');
  assert.ok(weekMissing.cappedBy.includes('WINDOW_PNL_SA_MISSING'));

  // S/A 中位名义缺数或过小 → B（进池已关中位门，主推仍要求）
  const medianMissing = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 35,
    activeDays: 200,
    maxDrawdownPercent: 0.2,
    pnl1yUsd: 5000,
    pnl30dUsd: 200,
    pnl7dUsd: 50,
  });
  assert.equal(medianMissing.tier, 'B');
  assert.ok(medianMissing.cappedBy.includes('MEDIAN_NOTIONAL_SA'));

  // MDD≥70%（含 100%）→ 最高 B
  const highMddTier = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 35,
    activeDays: 200,
    maxDrawdownPercent: 0.7,
    medianNotionalUsd: 80,
    pnl1yUsd: 5000,
    pnl30dUsd: 200,
    pnl7dUsd: 50,
  });
  assert.equal(highMddTier.tier, 'B');
  assert.ok(
    highMddTier.cappedBy.includes('MDD_SA_CAP') || highMddTier.cappedBy.includes('HIGH_MDD_SA')
  );

  // 不可测 MDD → S/A 封顶 B
  const mddMissing = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 35,
    activeDays: 200,
  });
  assert.equal(mddMissing.tier, 'B');
  assert.ok(mddMissing.cappedBy.includes('MDD_UNMEASURABLE'));

  const perfectWrPathRisk = resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 70,
    edgeSampleN: 40,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    closedMarketCount: 35,
    activeDays: 200,
    closedWinRate: 1,
    maxDrawdownPercent: 0.3,
    medianNotionalUsd: 80,
    pnl1yUsd: 5000,
    pnl30dUsd: 200,
    pnl7dUsd: 50,
    hasRealizedOpenWinRateGap: false,
  });
  assert.equal(perfectWrPathRisk.tier, 'B');
  assert.ok(perfectWrPathRisk.cappedBy.includes('PERFECT_CLOSED_WR_PATH_RISK'));

  const mm = classifySmartMoneyTraderType({
    edgeScore: 50,
    edgeSampleN: 20,
    medianHoldingSec: 3600,
    tradesPerDay1D: 120,
    trades7d: 800,
    top1MarketPnlShare: 0.2,
    hasHedgedPairFlag: false,
    hasHighTradeFrequencyFlag: true,
    extremeOddsShare: 0.1,
    totalReturn: 0.1,
    maxDrawdownPercent: 0.05,
  });
  assert.equal(mm.traderType, 'MARKET_MAKER');

  const profile = assembleSmartMoneyTraderProfile({
    closedRows: Array.from({ length: 20 }, (_, i) =>
      closedRow({
        conditionId: `x${i}`,
        avgPrice: 0.4,
        realizedPnl: 12,
        initialValue: 40,
      })
    ),
    totalReturn: 0.3,
    profitFactor: 1.8,
    winRate: 0.6,
    closedMarketCount: 20,
    copyabilityScore: 65,
    activeDays: 180,
    maxDrawdownPercent: 0.12,
    consistencyScore: 65,
    top1MarketPnlShare: 0.18,
    tradesPerDay1D: 5,
    trades7d: 30,
    medianHoldingSec: 10 * 86400,
    riskFlags: [],
  });
  assert.equal(profile.card.traderScore, profile.traderScore.traderScore);
  assert.ok(profile.card.reasons.length > 0);
  assert.ok(
    !profile.card.reasons.some((r) => r.includes('胜率')),
    'entry reasons must not mention win rate'
  );
  assert.ok(profile.card.risks.length > 0);

  const lowVolume = assembleSmartMoneyTraderProfile({
    closedRows: Array.from({ length: 20 }, (_, i) =>
      closedRow({
        conditionId: `lv${i}`,
        avgPrice: 0.4,
        realizedPnl: 12,
        initialValue: 40,
      })
    ),
    totalReturn: 0.5,
    profitFactor: 2.2,
    winRate: 0.7,
    closedMarketCount: 20,
    copyabilityScore: 70,
    activeDays: 200,
    maxDrawdownPercent: 0.1,
    consistencyScore: 70,
    top1MarketPnlShare: 0.15,
    tradesPerDay1D: 3,
    trades7d: 20,
    medianHoldingSec: 10 * 86400,
    riskFlags: [],
    totalVolumeUsd: 3_000,
  });
  assert.ok(
    lowVolume.tier.tier === 'C' || lowVolume.tier.tier === 'D',
    `expected low-volume cap ≤C, got ${lowVolume.tier.tier}`
  );
  assert.ok(lowVolume.tier.cappedBy.includes('LOW_EVIDENCE_VOLUME'));

  assert.equal(computeDisplayScore(null, 60, null), 60);
  // 主排序开关由 CONFIG 控制：开启时优先 traderScore，否则回落 v4 score
  const { CONFIG } = await import('../../config/env');
  if (CONFIG.smartMoneyTraderScoreAsPrimary) {
    assert.equal(computeDisplayScore(null, 60, 86), 86);
  } else {
    assert.equal(computeDisplayScore(null, 60, 86), 60);
  }

  console.log('smartMoneyTraderProfile.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
