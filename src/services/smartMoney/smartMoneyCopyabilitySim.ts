import { CONFIG } from '../../config/env';
import {
  normalizeTradeTimestampMs,
  type DataApiTrade,
} from '../polymarket/polymarketTrades';

export type CopyabilitySimOptions = {
  copyNotionalUsd: number;
  copyDelaySec: number;
  slippageBps: number;
  lookbackDays: number;
  excludeHedged: boolean;
  minMarketVolumeUsd: number;
  hedgedConditionIds?: ReadonlySet<string>;
  lowLiquidityConditionIds?: ReadonlySet<string>;
};

export type CopyabilityRoundTrip = {
  conditionId: string;
  asset: string;
  notionalUsd: number;
  pnlUsd: number;
  roi: number;
  holdingSec: number | null;
};

export type CopyabilitySimResult = {
  tradeCount: number;
  replicableTradeCount: number;
  roundTripCount: number;
  replicableTradeShare: number | null;
  simulatedRoi: number | null;
  simulatedWinRate: number | null;
  simulatedMaxDrawdown: number | null;
  /** 跟单仿真累计美元 PnL（Backtest PnL） */
  backtestPnlUsd: number | null;
  /** (负向 roundTrip 数)/roundTripCount；无 roundTrip 时为 null */
  copyLossRate: number | null;
  medianHoldingSec: number | null;
  avgHoldingSec: number | null;
  lastTradeAtMs: number | null;
  sampleWindowDays: number;
  sampleTradeCount: number;
  slippageBpsEffective: number;
  copyabilityScore: number;
  roundTrips: CopyabilityRoundTrip[];
};

export type CopyabilityExplain = {
  version: 'v1';
  options: CopyabilitySimOptions;
  metrics: Omit<CopyabilitySimResult, 'roundTrips'>;
  lowReplicableShare: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

export function effectiveCopySlippageBps(baseSlippageBps: number, copyDelaySec: number): number {
  const delayPenalty = Math.min(150, Math.round(copyDelaySec / 15) * 5);
  return baseSlippageBps + delayPenalty;
}

export function computeCopyabilityScore(input: {
  simulatedRoi: number | null;
  simulatedWinRate: number | null;
  simulatedMaxDrawdown: number | null;
  replicableTradeShare: number | null;
  roundTripCount: number;
}): number {
  if (input.roundTripCount < 1) return 0;
  const replShare = input.replicableTradeShare ?? 0;
  if (replShare < 0.05) return 0;

  const roiScore =
    input.simulatedRoi == null
      ? 30
      : clamp(((input.simulatedRoi + 0.1) / 0.5) * 100, 0, 100);
  const winScore =
    input.simulatedWinRate == null ? 30 : clamp(input.simulatedWinRate * 100, 0, 100);
  const ddScore =
    input.simulatedMaxDrawdown == null
      ? 40
      : clamp((1 - input.simulatedMaxDrawdown / 0.4) * 100, 0, 100);
  const replScore = clamp(replShare * 100, 0, 100);
  let raw = roiScore * 0.35 + winScore * 0.25 + ddScore * 0.2 + replScore * 0.2;
  if (replShare < CONFIG.smartMoneyCopyMinReplicableShare) {
    raw *= 0.5;
  }
  return roundScore(clamp(raw, 0, 100));
}

function isTradeReplicable(trade: DataApiTrade, options: CopyabilitySimOptions): boolean {
  const conditionId = trade.conditionId?.toLowerCase();
  if (!conditionId || !trade.asset) return false;
  if (options.excludeHedged && options.hedgedConditionIds?.has(conditionId)) return false;
  if (options.lowLiquidityConditionIds?.has(conditionId)) return false;
  const price = trade.price;
  return price != null && Number.isFinite(price) && price > 0;
}

export function simulateCopyabilityFromTrades(
  trades: DataApiTrade[],
  options: CopyabilitySimOptions,
  nowMs = Date.now()
): CopyabilitySimResult {
  const windowStart = nowMs - options.lookbackDays * 24 * 60 * 60 * 1000;
  const inWindow = trades.filter((trade) => {
    const ts = normalizeTradeTimestampMs(trade.timestamp);
    return ts != null && ts >= windowStart && ts <= nowMs;
  });

  const sorted = [...inWindow].sort((left, right) => {
    const leftTs = normalizeTradeTimestampMs(left.timestamp) ?? 0;
    const rightTs = normalizeTradeTimestampMs(right.timestamp) ?? 0;
    return leftTs - rightTs;
  });

  const slippageBps = effectiveCopySlippageBps(options.slippageBps, options.copyDelaySec);
  const lots = new Map<string, Array<{ price: number; shares: number; boughtAtMs: number | null }>>();
  const roundTrips: CopyabilityRoundTrip[] = [];
  let replicableTradeCount = 0;
  let lastTradeAtMs: number | null = null;

  for (const trade of sorted) {
    if (!isTradeReplicable(trade, options)) continue;
    replicableTradeCount += 1;

    const tradeTs = normalizeTradeTimestampMs(trade.timestamp);
    if (tradeTs != null) {
      lastTradeAtMs = lastTradeAtMs == null ? tradeTs : Math.max(lastTradeAtMs, tradeTs);
    }

    const asset = trade.asset!.toLowerCase();
    const conditionId = trade.conditionId!.toLowerCase();
    const leaderPrice = trade.price!;
    const leaderNotional = Math.max(0, (trade.size ?? 0) * leaderPrice);
    const copyNotional = Math.min(
      options.copyNotionalUsd,
      leaderNotional > 0 ? leaderNotional : options.copyNotionalUsd
    );

    if (trade.side === 'BUY') {
      const buyPrice = leaderPrice * (1 + slippageBps / 10_000);
      const shares = copyNotional / buyPrice;
      if (!lots.has(asset)) lots.set(asset, []);
      lots.get(asset)!.push({ price: buyPrice, shares, boughtAtMs: tradeTs });
      continue;
    }

    if (trade.side !== 'SELL') continue;
    const queue = lots.get(asset);
    if (!queue || queue.length === 0) continue;

    const lot = queue.shift()!;
    const sellPrice = leaderPrice * (1 - slippageBps / 10_000);
    const shares = Math.min(lot.shares, copyNotional / lot.price);
    const notionalUsd = shares * lot.price;
    const pnlUsd = shares * (sellPrice - lot.price);
    const roi = lot.price > 0 ? pnlUsd / notionalUsd : 0;
    const holdingSec =
      lot.boughtAtMs != null && tradeTs != null && tradeTs >= lot.boughtAtMs
        ? Math.round((tradeTs - lot.boughtAtMs) / 1000)
        : null;
    roundTrips.push({ conditionId, asset, notionalUsd, pnlUsd, roi, holdingSec });

    const remainingShares = lot.shares - shares;
    if (remainingShares > 1e-9) {
      queue.unshift({ price: lot.price, shares: remainingShares, boughtAtMs: lot.boughtAtMs });
    }
  }

  const tradeCount = inWindow.length;
  const replicableTradeShare = tradeCount > 0 ? replicableTradeCount / tradeCount : null;
  const totalInvested = roundTrips.reduce((sum, trip) => sum + trip.notionalUsd, 0);
  const totalPnl = roundTrips.reduce((sum, trip) => sum + trip.pnlUsd, 0);
  const simulatedRoi = totalInvested > 0 ? totalPnl / totalInvested : null;
  const simulatedWinRate =
    roundTrips.length > 0
      ? roundTrips.filter((trip) => trip.pnlUsd > 0).length / roundTrips.length
      : null;
  const copyLossRate =
    roundTrips.length > 0
      ? roundTrips.filter((trip) => trip.pnlUsd < 0).length / roundTrips.length
      : null;

  const holdingSecs = roundTrips
    .map((trip) => trip.holdingSec)
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const avgHoldingSec =
    holdingSecs.length > 0
      ? Math.round(holdingSecs.reduce((sum, value) => sum + value, 0) / holdingSecs.length)
      : null;
  const medianHoldingSec =
    holdingSecs.length > 0
      ? holdingSecs[Math.floor((holdingSecs.length - 1) / 2)] ?? null
      : null;

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trip of roundTrips) {
    equity += trip.pnlUsd;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }

  const copyabilityScore = computeCopyabilityScore({
    simulatedRoi,
    simulatedWinRate,
    simulatedMaxDrawdown: roundTrips.length > 0 ? maxDrawdown : null,
    replicableTradeShare,
    roundTripCount: roundTrips.length,
  });

  return {
    tradeCount,
    replicableTradeCount,
    roundTripCount: roundTrips.length,
    replicableTradeShare,
    simulatedRoi,
    simulatedWinRate,
    simulatedMaxDrawdown: roundTrips.length > 0 ? maxDrawdown : null,
    backtestPnlUsd: roundTrips.length > 0 ? totalPnl : null,
    copyLossRate,
    medianHoldingSec,
    avgHoldingSec,
    lastTradeAtMs,
    sampleWindowDays: options.lookbackDays,
    sampleTradeCount: tradeCount,
    slippageBpsEffective: slippageBps,
    copyabilityScore,
    roundTrips,
  };
}

export function buildDefaultCopyabilitySimOptions(input?: {
  hedgedConditionIds?: ReadonlySet<string>;
  lowLiquidityConditionIds?: ReadonlySet<string>;
}): CopyabilitySimOptions {
  return {
    copyNotionalUsd: CONFIG.smartMoneyCopyNotionalUsd,
    copyDelaySec: CONFIG.smartMoneyCopyDelaySec,
    slippageBps: CONFIG.smartMoneyCopySlippageBps,
    lookbackDays: CONFIG.smartMoneyCopyLookbackDays,
    excludeHedged: CONFIG.smartMoneyCopyExcludeHedged,
    minMarketVolumeUsd: CONFIG.smartMoneyMinMarketVolumeUsd,
    hedgedConditionIds: input?.hedgedConditionIds,
    lowLiquidityConditionIds: input?.lowLiquidityConditionIds,
  };
}

export type CopyabilityScenarioKey = 'tight' | 'base' | 'stress';

export type CopyabilityMultiScenarioResult = {
  copyabilityScore: number;
  scenarios: Record<
    CopyabilityScenarioKey,
    { score: number; slippageBps: number; delaySec: number; sim: CopyabilitySimResult }
  >;
  weights: { tight: number; base: number; stress: number };
};

function normalizeScenarioWeights(): { tight: number; base: number; stress: number } {
  const tight = Math.max(0, CONFIG.smartMoneyCopyScenarioWeightTight);
  const base = Math.max(0, CONFIG.smartMoneyCopyScenarioWeightBase);
  const stress = Math.max(0, CONFIG.smartMoneyCopyScenarioWeightStress);
  const sum = tight + base + stress;
  if (sum <= 0) return { tight: 0.2, base: 0.5, stress: 0.3 };
  return { tight: tight / sum, base: base / sum, stress: stress / sum };
}

export function buildCopyabilityScenarioOptions(
  scenario: CopyabilityScenarioKey,
  input?: {
    hedgedConditionIds?: ReadonlySet<string>;
    lowLiquidityConditionIds?: ReadonlySet<string>;
  }
): CopyabilitySimOptions {
  const base = buildDefaultCopyabilitySimOptions(input);
  if (scenario === 'tight') {
    return {
      ...base,
      slippageBps: CONFIG.smartMoneyCopyTightSlippageBps,
      copyDelaySec: CONFIG.smartMoneyCopyTightDelaySec,
    };
  }
  if (scenario === 'stress') {
    return {
      ...base,
      slippageBps: CONFIG.smartMoneyCopyStressSlippageBps,
      copyDelaySec: CONFIG.smartMoneyCopyStressDelaySec,
    };
  }
  return base;
}

/** 三情景仿跟单综合：0.2×tight + 0.5×base + 0.3×stress（可配置） */
export function simulateCopyabilityMultiScenario(
  trades: DataApiTrade[],
  input?: {
    hedgedConditionIds?: ReadonlySet<string>;
    lowLiquidityConditionIds?: ReadonlySet<string>;
  },
  nowMs = Date.now()
): CopyabilityMultiScenarioResult {
  const weights = normalizeScenarioWeights();
  const keys: CopyabilityScenarioKey[] = ['tight', 'base', 'stress'];
  const scenarios = {} as CopyabilityMultiScenarioResult['scenarios'];
  for (const key of keys) {
    const options = buildCopyabilityScenarioOptions(key, input);
    const sim = simulateCopyabilityFromTrades(trades, options, nowMs);
    scenarios[key] = {
      score: sim.copyabilityScore,
      slippageBps: options.slippageBps,
      delaySec: options.copyDelaySec,
      sim,
    };
  }
  const copyabilityScore = roundScore(
    clamp(
      weights.tight * scenarios.tight.score +
        weights.base * scenarios.base.score +
        weights.stress * scenarios.stress.score,
      0,
      100
    )
  );
  return { copyabilityScore, scenarios, weights };
}

export function extractHedgedConditionIdsFromExposure(
  hedgedPairExposure: { hedgedMarketCount?: number | null } | null | undefined,
  conditionIds: string[]
): Set<string> {
  if ((hedgedPairExposure?.hedgedMarketCount ?? 0) <= 0) {
    return new Set();
  }
  return new Set(conditionIds.map((id) => id.toLowerCase()).filter(Boolean));
}
