/**
 * 本地模拟：诊断若干钱包「回撤率 100% / 显示 -」的成因。
 * 路径与线上一致：Profile 曲线 + 开仓成本 → 资本归一化回撤 / 1Y 窗回撤。
 *
 *   npx tsx scripts/diagnose-drawdown-wallets.ts
 */
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/polycopy_test';

const WALLETS = [
  '0x251c1a283703beed41590b0875a8dcb8ddd1541f',
  '0x5c4600b33a02adf80dd07d6853f0c59e8d9e753d',
  '0xdb713f5ca529f6b6b2405c25e9afb96f2f09aa29',
  '0xbf337426aa856996b8bb79b238345dd1a0276bf7',
  '0xfb0f17657c9c24293b918adb86362a4d8fc90b02',
];

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(2)}%`;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function diagnoseOne(wallet: string): Promise<void> {
  const [
    { fetchPolymarketProfile },
    { fetchPositionPnlContext },
    { computeDrawdownStats },
    {
      computeDollarMaxDrawdown,
      computeCapitalNormalizedDrawdown,
      resolveCapitalDeployedPrincipal,
      resolveCanonicalBoardMetrics,
      MIN_RETURN_PRINCIPAL_USD,
      MIN_PRINCIPAL_VS_AMOUNT_RATIO,
    },
    { pickPortfolioPnlValues, computeBoardPnlWindowMetrics },
  ] = await Promise.all([
    import('../src/services/polymarket/polymarketProfile.js'),
    import('../src/services/smartMoney/smartMoneyPositionStats.js'),
    import('../src/services/smartMoney/smartMoneyScorer.js'),
    import('../src/services/smartMoney/smartMoneyCanonicalBoardMetrics.js'),
    import('../src/services/smartMoney/smartMoneyBoardWindowMetrics.js'),
  ]);

  const profile = await fetchPolymarketProfile(wallet, { pnlPeriods: ['1D', '1W', '1M', 'ALL'] });
  const positionContext = await fetchPositionPnlContext(wallet);

  const all = pickPortfolioPnlValues(profile, 'ALL');
  const preferredCurveValues = all.values;
  const holdingsValue = num(profile.holdingsValue);
  const costBasis = positionContext.stats.open?.totalCostBasis ?? null;
  const totalPnl = num(profile.totalPnl);
  const totalVolume = num(profile.totalVolume);

  const ddUsd = computeDollarMaxDrawdown(preferredCurveValues);
  const capitalDd = computeCapitalNormalizedDrawdown({
    maxDrawdownUsd: ddUsd,
    costBasis,
    holdingsValue,
  });
  const curveDd = computeDrawdownStats(preferredCurveValues);
  const capital = resolveCapitalDeployedPrincipal({
    costBasis,
    holdingsValue,
    referenceAmount: ddUsd && ddUsd > 0 ? ddUsd : MIN_RETURN_PRINCIPAL_USD,
  });
  const principalForWindow = capital.principalUsd;
  const windows = computeBoardPnlWindowMetrics(profile, principalForWindow);
  const canonical = resolveCanonicalBoardMetrics({
    totalPnl,
    totalVolume,
    costBasis,
    holdingsValue,
    pnlCurveValues: preferredCurveValues,
    metricsSource: 'LOCAL_FALLBACK',
  });

  // 与 scorer 一致的展示优先级：1y 窗回撤 → 资本归一化 → 曲线峰回撤
  const boardDisplay =
    windows.pnl1y.maxDrawdownRatio ?? capitalDd.ratio ?? curveDd.maxDrawdownPercent;

  const troughAfterPeak = (() => {
    if (preferredCurveValues.length < 2) return null;
    let p = preferredCurveValues[0]!;
    let maxDd = 0;
    let trough = preferredCurveValues[0]!;
    let peakAt = preferredCurveValues[0]!;
    for (const v of preferredCurveValues) {
      if (v > p) {
        p = v;
        peakAt = v;
      }
      const d = p - v;
      if (d > maxDd) {
        maxDd = d;
        trough = v;
      }
    }
    return { peak: peakAt, trough, maxDdUsd: Math.round(maxDd * 100) / 100 };
  })();

  const reasons: string[] = [];
  if (preferredCurveValues.length < 2) {
    reasons.push(`ALL 曲线点数不足(${preferredCurveValues.length}<2) → 无法算回撤 →「-」`);
  }
  if (ddUsd == null) reasons.push('终身曲线美元回撤为 null');
  if (capital.principalUsd == null) {
    reasons.push(
      `占用本金不合格(成本=${costBasis}, 持仓=${holdingsValue}, 需≥$${MIN_RETURN_PRINCIPAL_USD} 且 ≥对照额×${MIN_PRINCIPAL_VS_AMOUNT_RATIO}) → 资本归一化回撤 null`
    );
  }
  if (windows.pnl1y.maxDrawdownRatio == null && windows.pnl1y.maxDrawdownUsd != null) {
    reasons.push(
      `1Y 窗有美元回撤(${windows.pnl1y.maxDrawdownUsd}) 但本金无效 → maxDrawdownRatio=null`
    );
  }
  if (windows.pnl1y.maxDrawdownRatio != null && windows.pnl1y.maxDrawdownRatio >= 0.999) {
    reasons.push(
      `【100% 主因·1Y窗】maxDrawdownUsd(${windows.pnl1y.maxDrawdownUsd}) / 本金(${principalForWindow}) ≥ 1，夹紧为 100%。` +
        ` 含义：近1年累计 PnL 曲线上的峰→谷美元跌幅 ≥ 当前占用本金（持仓/开仓成本），不是「账户余额归零」的字面意思。`
    );
  }
  if (
    (windows.pnl1y.maxDrawdownRatio == null || windows.pnl1y.maxDrawdownRatio < 0.999) &&
    capitalDd.ratio != null &&
    capitalDd.ratio >= 0.999
  ) {
    reasons.push(
      `【100% 主因·终身资本归一化】美元回撤(${ddUsd}) ≥ 占用本金(${capital.principalUsd}) → 夹紧 100%`
    );
  }
  if (
    boardDisplay == null
  ) {
    reasons.push('最终展示回撤为 null → 前端显示「-」（缺曲线或本金，或二者都不合格）');
  } else if (boardDisplay < 0.999 && reasons.every((r) => !r.includes('100%'))) {
    reasons.push(`正常可算回撤：展示约 ${pct(boardDisplay)}`);
  }

  // 典型「高盈利大户但当前仓位很小」说明
  if (
    totalPnl != null &&
    totalPnl > 10_000 &&
    principalForWindow != null &&
    principalForWindow < totalPnl * 0.05 &&
    boardDisplay != null &&
    boardDisplay >= 0.5
  ) {
    reasons.push(
      '注意：终身已实现利润远大于当前持仓/成本，用「当前小本金」去除「历史大回撤美元」会系统性偏高甚至顶到 100%。'
    );
  }

  console.log('\n' + '='.repeat(72));
  console.log(wallet);
  console.log(
    JSON.stringify(
      {
        basics: {
          holdingsValue,
          costBasis,
          totalPnl,
          totalVolume,
          predictionCount: profile.predictionCount,
          allCurvePoints: preferredCurveValues.length,
          curveFirst: preferredCurveValues[0] ?? null,
          curveLast: preferredCurveValues.at(-1) ?? null,
          drawdownPath: troughAfterPeak,
        },
        drawdown: {
          lifetimeDollarDdUsd: ddUsd,
          capitalPrincipalUsd: capital.principalUsd,
          capitalPrincipalSource: capital.principalSource,
          capitalNormalizedDd: pct(capitalDd.ratio),
          curvePeakRelativeDd: pct(curveDd.maxDrawdownPercent),
          pnl1y: {
            pnlUsd: windows.pnl1y.pnlUsd,
            maxDrawdownUsd: windows.pnl1y.maxDrawdownUsd,
            maxDrawdownRatio: pct(windows.pnl1y.maxDrawdownRatio),
            coverageRatio: windows.pnl1y.coverageRatio,
            actualWindowDays: windows.pnl1y.actualWindowDays,
          },
          canonicalLifetimeDd: pct(canonical.maxDrawdownPercent),
          /** 与榜单展示优先级一致 */
          boardDisplay: pct(boardDisplay),
        },
        reasons,
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  console.log('Diagnosing drawdown for', WALLETS.length, 'wallets (live upstream)...');
  for (const w of WALLETS) {
    try {
      await diagnoseOne(w);
    } catch (error) {
      console.error('\n' + w, 'FAILED', error instanceof Error ? error.message : error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
