/**
 * 榜单权威指标：评分时解析一次，入库后供 L1 / 列表共用。
 * 禁止门槛与展示各自另算。
 *
 * 总回报：近窗已平仓事件 ΣPnL ÷ Σ成本；不可用则 null（展示「-」），禁止静默 ÷成交量。
 * 成交利润率（PnL/volume）仅作辅指标 turnoverReturnRatio。
 * 回撤（专业口径）：
 * - 最大亏损(USD)：可信峰值下曲线峰→谷最大美元跌
 * - 回撤率：可信峰值下最大比率事件 (Peak−Equity)/Peak（可与美元最大跌不同段）
 * 峰值须达到最小可信阈值，否则为 null（展示「-」），禁止用「美元回撤÷当前仓位」当主指标。
 */

export type CanonicalBoardMetricsSource =
  | 'PREDICTING_TOP'
  | 'LOCAL_FALLBACK'
  | 'MIXED'
  | 'NONE';

/** 总回报本金来源（CLOSED_COST = 近窗已平仓事件成本合计；VOLUME 仅历史快照兼容，新写入不再使用） */
export type CapitalPrincipalSource = 'COST_BASIS' | 'HOLDINGS';

export type PrincipalRoiSource = CapitalPrincipalSource | 'VOLUME' | 'CLOSED_COST';

export type CanonicalBoardMetrics = {
  totalPnl: number | null;
  totalVolume: number | null;
  /** 资本/可信回报比率（非百分数）；无可靠来源时为 null */
  totalReturnRatio: number | null;
  /** 占用本金美元 */
  returnPrincipalUsd: number | null;
  /** 总回报本金来源 */
  returnPrincipalSource: PrincipalRoiSource | null;
  /**
   * 成交利润率 = PnL / volume（辅指标）
   */
  turnoverReturnRatio: number | null;
  /** 累计 PnL 曲线上的最大美元回撤 */
  maxDrawdownUsd: number | null;
  /**
   * 峰权益最大回撤比例 0~1：(Peak−Equity)/Peak；
   * 无可靠正峰值时为 null（前端「-」）。
   */
  maxDrawdownPercent: number | null;
  source: CanonicalBoardMetricsSource;
  checkedAt: string;
};

/** 本金过小则比率无意义。 */
export const MIN_RETURN_PRINCIPAL_USD = 100;
/**
 * 本金须至少覆盖对照金额的一小部分（|PnL| 或美元回撤）。
 */
export const MIN_PRINCIPAL_VS_AMOUNT_RATIO = 0.05;
/** @deprecated 使用 MIN_PRINCIPAL_VS_AMOUNT_RATIO */
export const MIN_PRINCIPAL_VS_PNL_RATIO = MIN_PRINCIPAL_VS_AMOUNT_RATIO;
/** 绝对脏数据上限。 */
export const MAX_PLAUSIBLE_PRINCIPAL_ROI_RATIO = 5;
/**
 * 仅用「当前开仓成本/持仓」去除终身累计 PnL 时的可信上限。
 * 超过则视为窗口不匹配（已平仓利润进分子、成本已不在分母），总回报回退成交量口径。
 */
export const MAX_CREDIBLE_OPEN_SPOT_ROI_RATIO = 1;
/** 成交利润率上限（换手效率）。 */
export const MAX_PLAUSIBLE_TURNOVER_ROI_RATIO = 2;

/**
 * 峰权益 MDD 的最小峰值（美元）。
 * 低于此峰值的早期噪声不计入，避免曲线从 ≈0 起步时假 100% 回撤。
 */
export const MIN_PEAK_EQUITY_USD_FOR_DRAWDOWN = MIN_RETURN_PRINCIPAL_USD;

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function isUsablePrincipal(principal: number, referenceAmount: number): boolean {
  if (!Number.isFinite(principal) || principal < MIN_RETURN_PRINCIPAL_USD) return false;
  const absRef = Math.abs(referenceAmount);
  if (absRef > 0 && principal < absRef * MIN_PRINCIPAL_VS_AMOUNT_RATIO) return false;
  return true;
}

/**
 * 占用本金：取可用的成本与权益中的较大者（峰值占用代理）。
 * 不含成交量。
 */
export function resolveCapitalDeployedPrincipal(input: {
  costBasis?: number | null;
  holdingsValue?: number | null;
  /** 用于校验本金是否相对 PnL/回撤过小 */
  referenceAmount: number;
}): {
  principalUsd: number | null;
  principalSource: CapitalPrincipalSource | null;
} {
  const candidates: Array<{ source: CapitalPrincipalSource; principal: number }> = [];
  if (
    input.costBasis != null &&
    Number.isFinite(input.costBasis) &&
    isUsablePrincipal(input.costBasis, input.referenceAmount)
  ) {
    candidates.push({ source: 'COST_BASIS', principal: input.costBasis });
  }
  if (
    input.holdingsValue != null &&
    Number.isFinite(input.holdingsValue) &&
    isUsablePrincipal(input.holdingsValue, input.referenceAmount)
  ) {
    candidates.push({ source: 'HOLDINGS', principal: input.holdingsValue });
  }
  if (candidates.length === 0) {
    return { principalUsd: null, principalSource: null };
  }
  let best = candidates[0];
  for (const c of candidates) {
    if (c.principal > best.principal) best = c;
  }
  return { principalUsd: roundRatio(best.principal), principalSource: best.source };
}

/**
 * 资本回报：PnL / 占用本金（成本∪权益）。成交量不参与。
 */
export function computeCapitalReturnRatio(input: {
  totalPnl: number | null;
  costBasis?: number | null;
  holdingsValue?: number | null;
}): {
  ratio: number | null;
  principalUsd: number | null;
  principalSource: CapitalPrincipalSource | null;
} {
  const totalPnl = input.totalPnl;
  if (totalPnl == null || !Number.isFinite(totalPnl)) {
    return { ratio: null, principalUsd: null, principalSource: null };
  }
  const capital = resolveCapitalDeployedPrincipal({
    costBasis: input.costBasis,
    holdingsValue: input.holdingsValue,
    referenceAmount: totalPnl,
  });
  if (capital.principalUsd == null || capital.principalSource == null) {
    return { ratio: null, principalUsd: null, principalSource: null };
  }
  const ratio = totalPnl / capital.principalUsd;
  if (!Number.isFinite(ratio) || Math.abs(ratio) > MAX_PLAUSIBLE_PRINCIPAL_ROI_RATIO) {
    return {
      ratio: null,
      principalUsd: capital.principalUsd,
      principalSource: capital.principalSource,
    };
  }
  if (Math.abs(ratio) > MAX_CREDIBLE_OPEN_SPOT_ROI_RATIO) {
    return {
      ratio: null,
      principalUsd: capital.principalUsd,
      principalSource: capital.principalSource,
    };
  }
  return {
    ratio: roundRatio(ratio),
    principalUsd: capital.principalUsd,
    principalSource: capital.principalSource,
  };
}

/**
 * 成交利润率：PnL / volume。仅作辅指标。
 */
export function computeTurnoverReturnRatio(input: {
  totalPnl: number | null;
  totalVolume: number | null;
}): number | null {
  const { totalPnl, totalVolume } = input;
  if (totalPnl == null || totalVolume == null) return null;
  if (!Number.isFinite(totalPnl) || !Number.isFinite(totalVolume)) return null;
  if (!isUsablePrincipal(totalVolume, totalPnl)) return null;
  const ratio = totalPnl / totalVolume;
  if (!Number.isFinite(ratio) || Math.abs(ratio) > MAX_PLAUSIBLE_TURNOVER_ROI_RATIO) return null;
  return roundRatio(ratio);
}

/**
 * 累计 PnL 曲线上的最大美元回撤（峰到谷的美元差）。
 */
export function computeDollarMaxDrawdown(values: number[]): number | null {
  if (values.length < 2) return null;
  let peak = values[0];
  let maxDdUsd = 0;
  let sawFinite = false;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    sawFinite = true;
    if (value > peak) peak = value;
    const dd = peak - value;
    if (dd > maxDdUsd) maxDdUsd = dd;
  }
  if (!sawFinite) return null;
  return roundRatio(maxDdUsd);
}

export type PeakEquityDrawdownStats = {
  /** 最大比率回撤：(Peak−Equity)/Peak；与 maxDrawdownUsd 可不属于同一段峰谷 */
  maxDrawdownPercent: number | null;
  /** 最大美元回撤：曲线峰→谷美元跌幅；与 maxDrawdownPercent 独立选取 */
  maxDrawdownUsd: number | null;
  /** 形成「最大比率回撤」时的峰值权益 */
  peakEquityUsd: number | null;
  currentDrawdown: number | null;
};

/**
 * 峰权益回撤（同一条累计 PnL/权益曲线）：
 * - maxDrawdownUsd：可信峰值下的最大美元跌（曲线峰谷）
 * - maxDrawdownPercent：可信峰值下的最大比率事件 (Peak−Equity)/Peak
 * 二者独立选取，不再强制配对同一段。
 * 仅当 Peak ≥ minPeakUsd 时才计入，避免从 ≈0 起步的假 100%。
 */
export function computePeakEquityMaxDrawdown(
  values: number[],
  options?: { minPeakUsd?: number }
): PeakEquityDrawdownStats {
  const minPeakUsd = options?.minPeakUsd ?? MIN_PEAK_EQUITY_USD_FOR_DRAWDOWN;
  if (values.length < 2) {
    return {
      maxDrawdownPercent: null,
      maxDrawdownUsd: null,
      peakEquityUsd: null,
      currentDrawdown: null,
    };
  }

  let runningPeak = Number.NEGATIVE_INFINITY;
  let maxDdRatio = 0;
  let maxDdUsd = 0;
  let peakAtMaxRatio: number | null = null;
  let currentDrawdown: number | null = null;
  let hasReliablePeak = false;

  for (const raw of values) {
    if (!Number.isFinite(raw)) continue;
    if (raw > runningPeak) {
      runningPeak = raw;
    }
    if (!(runningPeak >= minPeakUsd)) {
      continue;
    }
    hasReliablePeak = true;
    const ddUsd = runningPeak - raw;
    const ddRatio = clamp01(ddUsd / runningPeak);
    if (ddUsd > maxDdUsd) {
      maxDdUsd = ddUsd;
    }
    if (ddRatio >= maxDdRatio) {
      maxDdRatio = ddRatio;
      peakAtMaxRatio = runningPeak;
    }
    currentDrawdown = ddRatio;
  }

  if (!hasReliablePeak) {
    return {
      maxDrawdownPercent: null,
      maxDrawdownUsd: null,
      peakEquityUsd: null,
      currentDrawdown: null,
    };
  }

  return {
    maxDrawdownPercent: roundRatio(maxDdRatio),
    maxDrawdownUsd: roundRatio(maxDdUsd),
    peakEquityUsd: peakAtMaxRatio != null ? roundRatio(peakAtMaxRatio) : null,
    currentDrawdown: currentDrawdown == null ? null : roundRatio(currentDrawdown),
  };
}

/**
 * 回撤率透传：该是多少就多少（含接近 100%），不再置空为「假/不可测」。
 * 高回撤改由 CopyPool 硬门（默认关闭）+ TraderScore 大幅减分处理。
 * 参数保留以兼容旧调用方。
 */
export function sanitizeMaxDrawdownRatio(
  mdd: number | null | undefined,
  _saturationThreshold?: number,
  _context?: {
    peakEquityUsd?: number | null;
    maxDrawdownUsd?: number | null;
    totalPnlUsd?: number | null;
  }
): {
  value: number | null;
  unmeasurable: boolean;
  raw: number | null;
} {
  void _saturationThreshold;
  void _context;
  const raw = mdd == null || !Number.isFinite(mdd) ? null : mdd;
  return { value: raw, unmeasurable: false, raw };
}

/**
 * @deprecated 榜单主回撤已改为 computePeakEquityMaxDrawdown。
 * 保留供旧调用；「美元回撤÷当前仓位」不再作为展示/L1 主路径。
 */
export function computeCapitalNormalizedDrawdown(input: {
  maxDrawdownUsd: number | null;
  costBasis?: number | null;
  holdingsValue?: number | null;
}): {
  ratio: number | null;
  principalUsd: number | null;
  principalSource: CapitalPrincipalSource | null;
} {
  const ddUsd = input.maxDrawdownUsd;
  if (ddUsd == null || !Number.isFinite(ddUsd) || ddUsd < 0) {
    return { ratio: null, principalUsd: null, principalSource: null };
  }
  if (ddUsd === 0) {
    const capital = resolveCapitalDeployedPrincipal({
      costBasis: input.costBasis,
      holdingsValue: input.holdingsValue,
      referenceAmount: MIN_RETURN_PRINCIPAL_USD,
    });
    return {
      ratio: 0,
      principalUsd: capital.principalUsd,
      principalSource: capital.principalSource,
    };
  }
  const capital = resolveCapitalDeployedPrincipal({
    costBasis: input.costBasis,
    holdingsValue: input.holdingsValue,
    referenceAmount: ddUsd,
  });
  if (capital.principalUsd == null) {
    return { ratio: null, principalUsd: null, principalSource: null };
  }
  const raw = ddUsd / capital.principalUsd;
  if (!Number.isFinite(raw) || raw < 0) {
    return { ratio: null, principalUsd: capital.principalUsd, principalSource: capital.principalSource };
  }
  return {
    ratio: roundRatio(Math.min(1, raw)),
    principalUsd: capital.principalUsd,
    principalSource: capital.principalSource,
  };
}

/**
 * @deprecated 兼容旧名；总回报请优先传入 closedWindowReturn，勿再回退 volume。
 */
export function computePrincipalBasedReturnRatio(input: {
  totalPnl: number | null;
  totalVolume: number | null;
  costBasis?: number | null;
  holdingsValue?: number | null;
}): {
  ratio: number | null;
  principalUsd: number | null;
  principalSource: PrincipalRoiSource | null;
} {
  void input.totalVolume;
  return computeCapitalReturnRatio({
    totalPnl: input.totalPnl,
    costBasis: input.costBasis,
    holdingsValue: input.holdingsValue,
  });
}

export function resolveCanonicalBoardMetrics(input: {
  totalPnl: number | null;
  totalVolume: number | null;
  costBasis?: number | null;
  holdingsValue?: number | null;
  /**
   * 近窗已平仓事件总回报（权威主路径）。
   * 有值则作为 totalReturnRatio；无则 null，不再用开仓现货 ROI 或成交量回退。
   */
  closedWindowReturn?: {
    totalReturnRatio: number | null;
    returnPrincipalUsd: number | null;
  } | null;
  /** 累计 PnL 曲线，用于峰权益回撤 */
  pnlCurveValues?: number[] | null;
  /**
   * @deprecated 忽略：榜单总回报不再采信外部/曲线 totalReturn。
   */
  primaryTotalReturn?: number | null;
  /**
   * @deprecated 忽略：回撤改由峰权益 MDD 计算。
   */
  effectiveMaxDrawdown?: number | null;
  metricsSource: string | null;
}): CanonicalBoardMetrics {
  void input.primaryTotalReturn;
  void input.effectiveMaxDrawdown;
  void input.costBasis;
  void input.holdingsValue;

  const turnoverReturnRatio = computeTurnoverReturnRatio({
    totalPnl: input.totalPnl,
    totalVolume: input.totalVolume,
  });
  const peakDd = computePeakEquityMaxDrawdown(input.pnlCurveValues ?? []);
  const maxDrawdownUsd = peakDd.maxDrawdownUsd ?? computeDollarMaxDrawdown(input.pnlCurveValues ?? []);

  const closed = input.closedWindowReturn;
  const totalReturnRatio =
    closed?.totalReturnRatio != null && Number.isFinite(closed.totalReturnRatio)
      ? roundRatio(closed.totalReturnRatio)
      : null;
  const returnPrincipalUsd =
    totalReturnRatio != null &&
    closed?.returnPrincipalUsd != null &&
    Number.isFinite(closed.returnPrincipalUsd)
      ? roundRatio(closed.returnPrincipalUsd)
      : null;
  const returnPrincipalSource: PrincipalRoiSource | null =
    totalReturnRatio != null ? 'CLOSED_COST' : null;

  const source: CanonicalBoardMetricsSource =
    input.metricsSource === 'PREDICTING_TOP' ||
    input.metricsSource === 'LOCAL_FALLBACK' ||
    input.metricsSource === 'MIXED'
      ? input.metricsSource
      : totalReturnRatio != null || peakDd.maxDrawdownPercent != null
        ? 'LOCAL_FALLBACK'
        : 'NONE';

  return {
    totalPnl: input.totalPnl,
    totalVolume: input.totalVolume,
    totalReturnRatio,
    returnPrincipalUsd,
    returnPrincipalSource,
    turnoverReturnRatio,
    maxDrawdownUsd,
    maxDrawdownPercent: peakDd.maxDrawdownPercent,
    source,
    checkedAt: new Date().toISOString(),
  };
}

/** 从 scoreExplain / scoreResult 读取已写入的权威快照 */
export function readCanonicalBoardMetrics(scoreExplain: unknown): CanonicalBoardMetrics | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) {
    return null;
  }
  const raw = (scoreExplain as { canonicalBoardMetrics?: unknown }).canonicalBoardMetrics;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const sourceRaw = typeof row.source === 'string' ? row.source : 'NONE';
  const source: CanonicalBoardMetricsSource =
    sourceRaw === 'PREDICTING_TOP' ||
    sourceRaw === 'LOCAL_FALLBACK' ||
    sourceRaw === 'MIXED' ||
    sourceRaw === 'NONE'
      ? sourceRaw
      : 'NONE';
  const principalSourceRaw =
    typeof row.returnPrincipalSource === 'string' ? row.returnPrincipalSource : null;
  const returnPrincipalSource: PrincipalRoiSource | null =
    principalSourceRaw === 'COST_BASIS' ||
    principalSourceRaw === 'HOLDINGS' ||
    principalSourceRaw === 'VOLUME' ||
    principalSourceRaw === 'CLOSED_COST'
      ? principalSourceRaw
      : null;
  return {
    totalPnl: num(row.totalPnl),
    totalVolume: num(row.totalVolume),
    totalReturnRatio: num(row.totalReturnRatio),
    returnPrincipalUsd: num(row.returnPrincipalUsd),
    returnPrincipalSource,
    turnoverReturnRatio: num(row.turnoverReturnRatio),
    maxDrawdownUsd: num(row.maxDrawdownUsd),
    maxDrawdownPercent: num(row.maxDrawdownPercent),
    source,
    checkedAt: typeof row.checkedAt === 'string' ? row.checkedAt : new Date(0).toISOString(),
  };
}
