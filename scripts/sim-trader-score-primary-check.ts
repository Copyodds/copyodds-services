/**
 * 本地模拟：TraderScore / 档位限档 / displayScore 开关影响
 * 用法: npx tsx scripts/sim-trader-score-primary-check.ts
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import { CONFIG } from '../src/config/env';
import { assembleSmartMoneyTraderProfile } from '../src/services/smartMoney/smartMoneyTraderProfile';
import { computeDisplayScore } from '../src/services/smartMoney/smartMoneyDisplayScore';
import { resolveSmartMoneyTier } from '../src/services/smartMoney/smartMoneyTier';
import type { DataApiPosition } from '../src/services/polymarket/polymarketData';

function closedRow(i: number, won: boolean): DataApiPosition {
  return {
    conditionId: `m${i}`,
    avgPrice: won ? 0.4 : 0.65,
    realizedPnl: won ? 25 : -18,
    initialValue: 50,
    size: 100,
    asset: `asset-${i}`,
    redeemable: false,
  } as DataApiPosition;
}

const closed = Array.from({ length: 24 }, (_, i) => closedRow(i, i % 3 !== 0));

const profile = assembleSmartMoneyTraderProfile({
  closedRows: closed,
  totalReturn: 0.42,
  profitFactor: 1.85,
  winRate: 0.66,
  closedMarketCount: 24,
  copyabilityScore: null,
  activeDays: 210,
  maxDrawdownPercent: 0.14,
  consistencyScore: 68,
  top1MarketPnlShare: 0.22,
  tradesPerDay1D: 5,
  trades7d: 30,
  medianHoldingSec: 12 * 86400,
  riskFlags: [],
  totalVolumeUsd: 80_000,
});

const caps = {
  gambler: resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 72,
    edgeSampleN: 20,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'GAMBLER',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
  }),
  marketMaker: resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 72,
    edgeSampleN: 20,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'MARKET_MAKER',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
  }),
  missingCopy: resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 72,
    edgeSampleN: 20,
    copyabilityMissing: true,
    copyabilityScore: null,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
  }),
  lowVolume: resolveSmartMoneyTier({
    traderScore: 85,
    edgeScore: 72,
    edgeSampleN: 20,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'INFORMATION',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
    totalVolumeUsd: 3_000,
  }),
  weakEdge: resolveSmartMoneyTier({
    traderScore: 80,
    edgeScore: 40,
    edgeSampleN: 20,
    copyabilityMissing: false,
    copyabilityScore: 70,
    traderType: 'GENERAL',
    hasHardRiskFlag: false,
    top1MarketPnlShare: 0.2,
  }),
};

const v4Score = 72;
const displayNow = computeDisplayScore(null, v4Score, profile.traderScore.traderScore);

const bugs: string[] = [];
if (caps.gambler.tier === 'S' || caps.gambler.tier === 'A') {
  bugs.push('BUG: 赌博型应 ≤B');
}
if (caps.marketMaker.tier === 'S' || caps.marketMaker.tier === 'A' || caps.marketMaker.tier === 'B') {
  bugs.push(`BUG: 做市型应 ≤C, got ${caps.marketMaker.tier}`);
}
if (caps.missingCopy.tier === 'S' || caps.missingCopy.tier === 'A' || caps.missingCopy.tier === 'B') {
  bugs.push(`BUG: 缺 copyability 应 ≤C, got ${caps.missingCopy.tier}`);
}
if (caps.lowVolume.tier === 'S' || caps.lowVolume.tier === 'A' || caps.lowVolume.tier === 'B') {
  bugs.push(`BUG: 小成交额应 ≤C, got ${caps.lowVolume.tier}`);
}
if (caps.weakEdge.tier !== 'B' && caps.weakEdge.tier !== 'C' && caps.weakEdge.tier !== 'D') {
  bugs.push(`BUG: 弱 Edge 高分应落到观察档, got ${caps.weakEdge.tier}`);
}
if (!CONFIG.smartMoneyTraderScoreAsPrimary && displayNow !== v4Score) {
  bugs.push(`BUG: primary=false 时 displayScore 应等于 v4=${v4Score}, got ${displayNow}`);
}
if (profile.traderScore.copyabilityMissing && profile.traderScore.factors.copyability !== 30) {
  bugs.push(
    `BUG: 缺 copyability 因子应为 30, got ${profile.traderScore.factors.copyability}`
  );
}

console.log(
  JSON.stringify(
    {
      smartMoneyTraderScoreAsPrimary: CONFIG.smartMoneyTraderScoreAsPrimary,
      copyPoolEnter: CONFIG.smartMoneyCopyPoolEnterScore,
      copyPoolExit: CONFIG.smartMoneyCopyPoolExitScore,
      copyPoolExitMiss: CONFIG.smartMoneyCopyPoolExitMissCount,
      sample: {
        traderScore: profile.traderScore.traderScore,
        factors: profile.traderScore.factors,
        penalty: profile.traderScore.penalty,
        tier: profile.tier.tier,
        type: profile.traderType.traderType,
        displayScore: displayNow,
        note: CONFIG.smartMoneyTraderScoreAsPrimary
          ? 'primary ON → displayScore=traderScore'
          : 'primary OFF → displayScore=v4 score (准入分)',
      },
      caps: Object.fromEntries(
        Object.entries(caps).map(([k, v]) => [k, { tier: v.tier, cappedBy: v.cappedBy }])
      ),
      bugs,
      ok: bugs.length === 0,
    },
    null,
    2
  )
);

if (bugs.length) process.exitCode = 1;
