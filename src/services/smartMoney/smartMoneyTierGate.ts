import { CONFIG } from '../../config/env';
import { getSmartMoneyTierThresholds } from './smartMoneyTierThresholds';
import { computeHighReturnMarketShare, type ClosedMarketReturnDistribution } from './smartMoneyPositionStats';
import type { SmartMoneyMarketLiquidityProfile } from './smartMoneyMarketLiquidity';
import type { PolymarketProfileFetchResult } from '../polymarket/polymarketProfile';
import type { SmartMoneyScoreResult } from './smartMoneyScorer';
import { COPY_POOL_HARD_FLAGS } from './smartMoneyPipelineTypes';
import {
  computeCapitalReturnRatio,
  computePeakEquityMaxDrawdown,
  readCanonicalBoardMetrics,
  sanitizeMaxDrawdownRatio,
} from './smartMoneyCanonicalBoardMetrics';
import { computeBoardPnlWindowMetrics } from './smartMoneyBoardWindowMetrics';

export type TierGateResult = {
  passed: boolean;
  failedIds: string[];
  failReason: string | null;
};

function fail(ids: string[]): TierGateResult {
  return {
    passed: false,
    failedIds: ids,
    failReason: ids.join(','),
  };
}

function pass(): TierGateResult {
  return { passed: true, failedIds: [], failReason: null };
}

function toNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 同窗美元回撤硬门：要求 maxDrawdownUsd < totalPnlUsd。
 * 任一不可测则视为未触发（跳过，防误杀）。
 */
export function failsMaxDrawdownUsdLtPnl(input: {
  maxDrawdownUsd: number | null | undefined;
  totalPnlUsd: number | null | undefined;
}): boolean {
  const dd = input.maxDrawdownUsd;
  const pnl = input.totalPnlUsd;
  if (dd == null || !Number.isFinite(dd) || pnl == null || !Number.isFinite(pnl)) {
    return false;
  }
  return !(dd < pnl);
}

export function evaluateTier1L(profile: PolymarketProfileFetchResult): TierGateResult {
  const thresholds = getSmartMoneyTierThresholds();
  const failed: string[] = [];
  // F3：持仓金额不作 Light 硬门（评分侧 LOW_HOLDINGS 软惩罚可保留）
  if ((profile.predictionCount ?? 0) < thresholds.minPredictionCount) {
    failed.push('T1L-2');
  }
  if (profile.curves.length < thresholds.minCurvePointCount) {
    failed.push('T1L-3');
  }
  return failed.length > 0 ? fail(failed) : pass();
}

/** 稀疏候选是否因生涯 PnL/成交额豁免（空仓大户） */
export function isLightSparseExempt(profile: PolymarketProfileFetchResult): boolean {
  const totalPnl = toNumber(profile.totalPnl);
  const totalVolume = toNumber(profile.totalVolume);
  const pnlOk =
    CONFIG.smartMoneyLightSparseExemptMinPnl > 0 &&
    totalPnl != null &&
    totalPnl >= CONFIG.smartMoneyLightSparseExemptMinPnl;
  const volumeOk =
    CONFIG.smartMoneyLightSparseExemptMinVolume > 0 &&
    totalVolume != null &&
    totalVolume >= CONFIG.smartMoneyLightSparseExemptMinVolume;
  return pnlOk || volumeOk;
}

/**
 * Phase G Light 便宜加严（不打 trades）：
 * - 低持仓 + 低预测数（大户豁免）
 * - 账户过新 + 预测密度过高
 * - 同窗最大回撤金额 ≥ 同窗总盈亏（与 L1 美元门同源，预杀省 Deep）
 * - 管道优化：1Y/30D/7D 曲线截窗方向门（L-PNL1Y / L-DUAL-SHORT / L-HARD-SHORT）
 *
 * L-DUAL-SHORT 单独返回，由 Light 延后而非 ELIMINATED。
 */
export function evaluateLightCheapReject(profile: PolymarketProfileFetchResult): TierGateResult {
  const failed: string[] = [];
  const holdings = toNumber(profile.holdingsValue) ?? 0;
  const predictionCount = profile.predictionCount ?? 0;

  if (
    CONFIG.smartMoneyLightMinHoldingsForSparse > 0 &&
    CONFIG.smartMoneyLightMaxPredictionForSparse > 0 &&
    holdings < CONFIG.smartMoneyLightMinHoldingsForSparse &&
    predictionCount < CONFIG.smartMoneyLightMaxPredictionForSparse &&
    !isLightSparseExempt(profile)
  ) {
    failed.push('T1L-SPARSE');
  }

  if (
    CONFIG.smartMoneyLightMaxAccountAgeDaysForDensity > 0 &&
    CONFIG.smartMoneyLightMaxPredictionsPerDay > 0 &&
    predictionCount > 0
  ) {
    const ageDays = estimateLightAccountAgeDays(profile);
    if (
      ageDays != null &&
      ageDays <= CONFIG.smartMoneyLightMaxAccountAgeDaysForDensity &&
      predictionCount / Math.max(ageDays, 1) > CONFIG.smartMoneyLightMaxPredictionsPerDay
    ) {
      failed.push('T1L-DENSITY');
    }
  }

  if (CONFIG.smartMoneyL1MaxDdUsdLtPnl) {
    const { pnl1y } = computeBoardPnlWindowMetrics(profile, null);
    if (
      failsMaxDrawdownUsdLtPnl({
        maxDrawdownUsd: pnl1y.maxDrawdownUsd,
        totalPnlUsd: pnl1y.pnlUsd,
      })
    ) {
      failed.push('T1L-DD');
    }
  }

  const windowReject = evaluateLightWindowReject(profile);
  if (!windowReject.passed) {
    failed.push(...windowReject.failedIds);
  }

  return failed.length > 0 ? fail(failed) : pass();
}

/**
 * Light 曲线截窗方向门（零额外 HTTP）。
 * - L-PNL1Y：1Y 净盈 ≤ lightMinPnl1y（默认 0）→ 淘汰
 * - L-HARD-SHORT：30D&lt;0 且 1Y 不达 L1 门槛 → 淘汰
 * - L-DUAL-SHORT：30D&lt;0 且 7D&lt;0 → 由调用方延后（仍会出现在 failedIds）
 */
export function evaluateLightWindowReject(profile: PolymarketProfileFetchResult): TierGateResult {
  const failed: string[] = [];
  const holdings = toNumber(profile.holdingsValue);
  const { pnl7d, pnl30d, pnl1y } = computeBoardPnlWindowMetrics(
    profile,
    holdings != null && holdings > 0 ? holdings : null
  );
  const thresholds = getSmartMoneyTierThresholds();
  const minPnl1y = CONFIG.smartMoneyLightMinPnl1y;

  if (pnl1y.pnlUsd != null && pnl1y.pnlUsd <= minPnl1y) {
    failed.push('L-PNL1Y');
  }
  if (
    pnl30d.pnlUsd != null &&
    pnl30d.pnlUsd < 0 &&
    (pnl1y.pnlUsd == null || pnl1y.pnlUsd <= thresholds.scorePoolMinPnl1y)
  ) {
    failed.push('L-HARD-SHORT');
  }
  if (
    pnl30d.pnlUsd != null &&
    pnl30d.pnlUsd < 0 &&
    pnl7d.pnlUsd != null &&
    pnl7d.pnlUsd < 0
  ) {
    failed.push('L-DUAL-SHORT');
  }

  return failed.length > 0 ? fail(failed) : pass();
}

/** 是否仅为双短窗延后（无其它硬杀码） */
export function isLightDualShortDeferOnly(result: TierGateResult): boolean {
  if (result.passed) return false;
  const hard = result.failedIds.filter((id) => id !== 'L-DUAL-SHORT');
  return hard.length === 0 && result.failedIds.includes('L-DUAL-SHORT');
}

function estimateLightAccountAgeDays(profile: PolymarketProfileFetchResult): number | null {
  const joined = profile.joinedAtText;
  if (typeof joined === 'string' && joined.trim()) {
    const parsed = Date.parse(joined);
    if (!Number.isNaN(parsed)) {
      return Math.max(0, (Date.now() - parsed) / (24 * 60 * 60 * 1000));
    }
    const monthYear = joined.trim().match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
    if (monthYear) {
      const probe = Date.parse(`${monthYear[1]} 1, ${monthYear[2]}`);
      if (!Number.isNaN(probe)) {
        return Math.max(0, (Date.now() - probe) / (24 * 60 * 60 * 1000));
      }
    }
  }
  let minMs: number | null = null;
  for (const point of profile.curves ?? []) {
    const raw = point.ts;
    const ms =
      raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(ms)) continue;
    if (minMs == null || ms < minMs) minMs = ms;
  }
  if (minMs == null) return null;
  return Math.max(0, (Date.now() - minMs) / (24 * 60 * 60 * 1000));
}

/**
 * @deprecated §15：生产主路径未使用 Tier1F；保留函数仅供旧测/排障，勿重新接入门控。
 */
export function evaluateTier1F(input: {
  tradeCount30d: number | null;
  riskFlags: string[];
  dataConfidence: number;
}): TierGateResult {
  const thresholds = getSmartMoneyTierThresholds();
  const failed: string[] = [];
  if ((input.tradeCount30d ?? 0) < thresholds.tier1fMinTrades30d) {
    failed.push('T1F-1');
  }
  if (input.riskFlags.includes('HEDGED_PAIR_EXPOSURE')) {
    failed.push('T1F-2');
  }
  if (input.dataConfidence < thresholds.tier1fMinDataConfidence) {
    failed.push('T1F-3');
  }
  return failed.length > 0 ? fail(failed) : pass();
}

function pickPreferredCurveValues(profile: PolymarketProfileFetchResult): number[] {
  const curves = profile?.curves ?? [];
  const all = curves
    .filter((point) => point.period === 'ALL' && point.curveType.startsWith('PORTFOLIO_PNL'))
    .map((point) => Number(point.value))
    .filter((value) => Number.isFinite(value));
  if (all.length >= 2) return all;
  return curves
    .map((point) => Number(point.value))
    .filter((value) => Number.isFinite(value));
}

/**
 * Deep 曲线早杀（零 HTTP）：仅 L1-DATA / L1-PNL / L1-DD（及可选 L1-RET）。
 * 在 closed/trades Gate 打分前调用，避免白耗上游。
 * 不判 PF/WR/TRADES/CLOSED/VOLUME（那些依赖 Gate 拉数）。
 */
export function evaluateL1CurveEarlyReject(
  profile: PolymarketProfileFetchResult
): TierGateResult & {
  totalPnl1y: number | null;
  maxDrawdownUsd1y: number | null;
  totalReturn1y: number | null;
  maxDrawdown1y: number | null;
} {
  const thresholds = getSmartMoneyTierThresholds();
  const failed: string[] = [];
  const curveValues = pickPreferredCurveValues(profile);
  if (curveValues.length < 2) {
    return {
      ...fail(['L1-DATA']),
      totalPnl1y: null,
      maxDrawdownUsd1y: null,
      totalReturn1y: null,
      maxDrawdown1y: null,
    };
  }

  const holdings = toNumber(profile.holdingsValue);
  const { pnl1y } = computeBoardPnlWindowMetrics(
    profile,
    holdings != null && holdings > 0 ? holdings : null
  );
  const totalPnl1y = pnl1y.pnlUsd;
  const maxDrawdownUsd1y = pnl1y.maxDrawdownUsd;
  const totalReturn1y = pnl1y.returnRatio;
  const sanitizedDd = sanitizeMaxDrawdownRatio(
    pnl1y.maxDrawdownRatio,
    CONFIG.smartMoneyMddSaturation
  );
  const maxDrawdown1y = sanitizedDd.value;

  if (totalPnl1y == null || totalPnl1y <= thresholds.scorePoolMinPnl1y) {
    failed.push('L1-PNL');
  }
  if (
    CONFIG.smartMoneyL1RequireTotalReturn &&
    (totalReturn1y == null || totalReturn1y < thresholds.tier2MinTotalReturn)
  ) {
    failed.push('L1-RET');
  }

  let drawdownGateFailed = false;
  if (
    CONFIG.smartMoneyL1MaxDdUsdLtPnl &&
    failsMaxDrawdownUsdLtPnl({
      maxDrawdownUsd: maxDrawdownUsd1y,
      totalPnlUsd: totalPnl1y,
    })
  ) {
    drawdownGateFailed = true;
  }
  // 比例尺仅在回报可测时早杀；缺本金 ROI 时留给完整 L1，避免误杀
  if (
    CONFIG.smartMoneyL1MaxDdLeReturn &&
    maxDrawdown1y != null &&
    totalReturn1y != null &&
    (totalReturn1y <= 0 || maxDrawdown1y > totalReturn1y)
  ) {
    drawdownGateFailed = true;
  }
  if (drawdownGateFailed) {
    failed.push('L1-DD');
  }

  const result = failed.length > 0 ? fail(failed) : pass();
  return {
    ...result,
    totalPnl1y,
    maxDrawdownUsd1y,
    totalReturn1y,
    maxDrawdown1y,
  };
}

export function evaluateTier2Core(input: {
  profile: PolymarketProfileFetchResult;
  resolvedTotalPnl: number | null;
  totalVolume: number | null;
}): TierGateResult {
  /** L1 候选质量门：PnL>0、同窗 MDD$ < PnL$（Volume 不作硬门） */
  return evaluateL1CandidateGate(input);
}

/**
 * 候选池 → 评分池质量硬门槛（设计 §4.3 C*）。
 * - 总盈亏：1Y 同窗绝对美元（缺省回退 resolvedTotalPnl）
 * - 回撤：默认要求同窗 maxDrawdownUsd < totalPnlUsd（比例尺 MDD≤回报仅排障可选）
 * - 胜率/盈亏比：已平仓市场口径；近 30 日成交；总盈利绝对美元门槛
 */
export function evaluateL1CandidateGate(input: {
  profile: PolymarketProfileFetchResult;
  resolvedTotalPnl: number | null;
  totalVolume: number | null;
  /** 权威回报率（比率）；undefined 时回退占用本金 ROI */
  effectiveTotalReturn?: number | null;
  /** 权威回撤（比率） */
  effectiveMaxDrawdown?: number | null;
  /** 按市场胜率（优先已平仓）；缺则门失败 */
  winRate?: number | null;
  /** 按市场盈亏比；缺则门失败 */
  profitFactor?: number | null;
  /** 近 7 日成交笔数 */
  trades7d?: number | null;
  /** 近 30 日成交笔数；评分池使用此窗口 */
  trades30d?: number | null;
  /** 与 1Y 曲线同窗的绝对 PnL、覆盖和本金归一指标 */
  totalPnl1y?: number | null;
  pnlWindowDays?: number | null;
  totalReturn1y?: number | null;
  maxDrawdown1y?: number | null;
  /** 与 1Y PnL 同窗的最大回撤金额（美元） */
  maxDrawdownUsd1y?: number | null;
  /** 已平仓市场样本数（C8）；null = 未知/拉取失败，禁止按 0 硬杀 */
  closedMarketCount?: number | null;
  /**
   * 已平仓样本不可靠（HTTP 失败 / CLOSED_RETURN_DATA_MISSING）。
   * true 时跳过 L1-CLOSED / L1-WR，避免把瞬时上游失败当成「真没已平仓」。
   */
  closedMarketDataMissing?: boolean;
  /**
   * closed-positions HTTP 明确失败时为 true。
   * 仅此时跳过 L1-PF；「拉成功但样本为空/不足」仍应按 null/低 PF 硬拦，防放水入池。
   */
  closedFetchFailed?: boolean;
  /**
   * 近窗成交是否抓取成功。
   * false 时跳过 L1-TRADES30D，避免把上游超时当成「近 30 日 0 笔」。
   */
  tradesFetchOk?: boolean;
  /** 已有足够已平仓盈利样本且总亏损为 0；PF 数学上为正无穷 */
  profitFactorNoLoss?: boolean;
  /** 中位成交名义（USD） */
  medianNotionalUsd?: number | null;
  /** 粉尘成交占比 0–1 */
  dustShare?: number | null;
  /** 用于名义金额分布的有效交易样本数 */
  tradeNotionalSampleCount?: number;
}): TierGateResult {
  const thresholds = getSmartMoneyTierThresholds();
  const failed: string[] = [];
  const curveValues = pickPreferredCurveValues(input.profile);
  if (curveValues.length < 2) {
    return fail(['L1-DATA']);
  }
  const useWindowMetrics =
    input.totalReturn1y !== undefined ||
    input.maxDrawdown1y !== undefined ||
    input.maxDrawdownUsd1y !== undefined;
  const useCanonical =
    !useWindowMetrics &&
    (input.effectiveTotalReturn !== undefined || input.effectiveMaxDrawdown !== undefined);
  const holdingsValue = toNumber(input.profile.holdingsValue);
  const capitalRoi = computeCapitalReturnRatio({
    totalPnl: input.resolvedTotalPnl,
    holdingsValue,
  });
  const peakDd = computePeakEquityMaxDrawdown(curveValues);
  const totalReturn = useWindowMetrics
    ? (input.totalReturn1y ?? null)
    : useCanonical
      ? (input.effectiveTotalReturn ?? null)
      : capitalRoi.ratio;
  const rawMaxDrawdown = useWindowMetrics
    ? (input.maxDrawdown1y ?? null)
    : useCanonical
      ? (input.effectiveMaxDrawdown ?? null)
      : peakDd.maxDrawdownPercent;
  const sanitizedDd = sanitizeMaxDrawdownRatio(rawMaxDrawdown, CONFIG.smartMoneyMddSaturation, {
    peakEquityUsd: peakDd.peakEquityUsd,
    maxDrawdownUsd:
      input.maxDrawdownUsd1y !== undefined ? input.maxDrawdownUsd1y : peakDd.maxDrawdownUsd,
    totalPnlUsd: input.totalPnl1y !== undefined ? input.totalPnl1y : input.resolvedTotalPnl,
  });
  const maxDrawdown = sanitizedDd.value;

  // C1 同一 1Y 曲线窗总盈利；旧调用仅在未提供窗口字段时回退 resolvedTotalPnl。
  const pnlForGate =
    input.totalPnl1y !== undefined ? input.totalPnl1y : input.resolvedTotalPnl;
  if (pnlForGate == null || pnlForGate <= thresholds.scorePoolMinPnl1y) {
    failed.push('L1-PNL');
  }
  // §15：默认不硬拦回报率（净盈 $ 已覆盖方向）；排障可开 SMART_MONEY_L1_REQUIRE_TOTAL_RETURN
  if (
    CONFIG.smartMoneyL1RequireTotalReturn &&
    (totalReturn == null || totalReturn < thresholds.tier2MinTotalReturn)
  ) {
    failed.push('L1-RET');
  }
  // 默认：同窗 MDD$ < PnL$（尺子同源）；缺数跳过
  const maxDrawdownUsdForGate =
    input.maxDrawdownUsd1y !== undefined
      ? input.maxDrawdownUsd1y
      : input.totalPnl1y !== undefined
        ? null
        : peakDd.maxDrawdownUsd;
  let drawdownGateFailed = false;
  if (
    CONFIG.smartMoneyL1MaxDdUsdLtPnl &&
    failsMaxDrawdownUsdLtPnl({
      maxDrawdownUsd: maxDrawdownUsdForGate,
      totalPnlUsd: pnlForGate,
    })
  ) {
    drawdownGateFailed = true;
  }
  // 排障可选：旧比例尺 MDD≤回报（默认关）
  if (CONFIG.smartMoneyL1MaxDdLeReturn && maxDrawdown != null) {
    if (totalReturn == null || totalReturn <= 0 || maxDrawdown > totalReturn) {
      drawdownGateFailed = true;
    }
  }
  if (drawdownGateFailed) {
    failed.push('L1-DD');
  }
  // C8 样本：仅在「可靠计数」下硬拦；拉取失败 / 数据缺失时跳过，防误杀
  const closedDataMissing =
    input.closedMarketDataMissing === true || input.closedMarketCount == null;
  if (
    !closedDataMissing &&
    (input.closedMarketCount as number) < thresholds.scorePoolMinClosedMarkets
  ) {
    failed.push('L1-CLOSED');
  } else if (
    !closedDataMissing &&
    CONFIG.smartMoneyL1RequireWinRate &&
    (input.winRate == null || input.winRate < thresholds.scorePoolMinWinRate)
  ) {
    failed.push('L1-WR');
  }
  // C5 盈亏比：仅 HTTP 失败跳过；样本空/不足仍硬拦（与「缺数重试 / 真不合格」分离）
  if (
    input.closedFetchFailed !== true &&
    !input.profitFactorNoLoss &&
    (input.profitFactor == null || input.profitFactor < thresholds.scorePoolMinProfitFactor)
  ) {
    failed.push('L1-PF');
  }
  // C6 近 30 日成交：仅成交抓取成功时硬拦；失败由 Deep 短冷却重试，不进 COLD
  if (
    input.tradesFetchOk !== false &&
    (input.trades30d ?? 0) < thresholds.scorePoolMinTrades30d
  ) {
    failed.push('L1-TRADES30D');
  }
  // §15：默认不硬杀 Volume（小额 → 档位 ≤C）
  if (
    CONFIG.smartMoneyL1RequireLifetimeVolume &&
    (input.totalVolume == null || input.totalVolume <= thresholds.scorePoolMinLifetimeVolume)
  ) {
    failed.push('L1-VOLUME');
  }

  // L1-DUST 改为软扣分（scoreExplain / HIGH_DUST_SHARE），不再硬杀 L1
  void input.medianNotionalUsd;
  void input.dustShare;
  void input.tradeNotionalSampleCount;

  // 默认 SMART_MONEY_COPY_POOL_MAX_MDD_PCT=0：高回撤不硬杀，改由 TraderScore 大幅减分
  if (
    CONFIG.smartMoneyCopyPoolMaxMddPct > 0 &&
    maxDrawdown != null &&
    Number.isFinite(maxDrawdown) &&
    maxDrawdown >= CONFIG.smartMoneyCopyPoolMaxMddPct
  ) {
    failed.push('L1-MDD-PCT');
  }

  void thresholds.tier2MinVolume;
  void thresholds.tier2MaxDrawdown;
  void thresholds.tier2MinCalmar;
  void input.pnlWindowDays;
  void input.trades7d;
  return failed.length > 0 ? fail(failed) : pass();
}

export function evaluateTier2Enhanced(input: {
  closedMarketReturnDistribution: ClosedMarketReturnDistribution | null;
  marketLiquidityProfile: SmartMoneyMarketLiquidityProfile | null;
}): TierGateResult {
  const thresholds = getSmartMoneyTierThresholds();
  const failed: string[] = [];
  const closedCount = input.closedMarketReturnDistribution?.sampledMarketCount ?? 0;
  if (closedCount < thresholds.minClosedMarketsForEligibility) {
    failed.push('T2E-2');
  }
  const highReturnShare = input.closedMarketReturnDistribution
    ? computeHighReturnMarketShare(input.closedMarketReturnDistribution)
    : null;
  if (highReturnShare == null || highReturnShare < thresholds.minHighReturnMarketShare) {
    failed.push('T2E-1');
  }
  const liquidityShare = input.marketLiquidityProfile?.classificationShare ?? null;
  if (liquidityShare == null || liquidityShare < thresholds.minLiquidityClassificationShare) {
    failed.push('T2E-3');
  }
  const highVolumeShare = input.marketLiquidityProfile?.highVolumeMarketShare ?? null;
  if (highVolumeShare == null || highVolumeShare < thresholds.minHighVolumeMarketShare) {
    failed.push('T2E-4');
  }
  return failed.length > 0 ? fail(failed) : pass();
}

export function hasCopyPoolHardFlag(flags: string[]): boolean {
  return flags.some((flag) => (COPY_POOL_HARD_FLAGS as readonly string[]).includes(flag));
}

/** 命中 CopyPool 硬旗时写入淘汰池的 reason（无硬旗返回 null） */
export function buildCopyPoolHardElimReason(flags: readonly string[]): string | null {
  const hits = flags.filter((flag) =>
    (COPY_POOL_HARD_FLAGS as readonly string[]).includes(flag)
  );
  if (hits.length === 0) return null;
  return `COPY_HARD|${hits.slice(0, 6).join(',')}`;
}

export function extractDataConfidence(scoreResult: SmartMoneyScoreResult): number {
  const explain = scoreResult.scoreExplain as { components?: { dataConfidence?: number } };
  return explain.components?.dataConfidence ?? 0;
}

export function extractResolvedTotalPnl(scoreResult: SmartMoneyScoreResult): number | null {
  const explain = scoreResult.scoreExplain as {
    resolvedMetrics?: { totalPnl?: number | null };
  };
  return scoreResult.totalPnl ?? explain.resolvedMetrics?.totalPnl ?? null;
}

/**
 * L1 只读 scoreExplain.canonicalBoardMetrics（评分入库权威快照）。
 * 无快照时返回 null 字段 → 门槛失败（与列表空值一致），禁止另算本地曲线通胀回报。
 */
export function extractL1DisplayAlignedMetrics(scoreResult: SmartMoneyScoreResult): {
  effectiveTotalReturn: number | null;
  effectiveMaxDrawdown: number | null;
  localCurveReturn: number | null;
  sourceHint: string;
} {
  const canonical = readCanonicalBoardMetrics(scoreResult.scoreExplain);
  if (canonical) {
    return {
      effectiveTotalReturn: canonical.totalReturnRatio,
      effectiveMaxDrawdown: canonical.maxDrawdownPercent,
      localCurveReturn: null,
      sourceHint: `canonical:${canonical.source}`,
    };
  }
  // 兼容尚未写入 canonical 的旧缓存行：仍禁止曲线通胀，只用列上百分数还原
  let effectiveTotalReturn: number | null = null;
  if (scoreResult.externalTotalReturn != null) {
    const stored = scoreResult.externalTotalReturn;
    effectiveTotalReturn = Math.abs(stored) > 10 ? stored / 100 : stored;
  }
  return {
    effectiveTotalReturn,
    effectiveMaxDrawdown: scoreResult.maxDrawdownPercent ?? null,
    localCurveReturn: null,
    sourceHint: scoreResult.maxDrawdownPercent != null ? 'row:maxDrawdownPercent' : 'missing-canonical',
  };
}
