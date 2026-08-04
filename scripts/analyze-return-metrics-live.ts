/**
 * 离线复算总盈利率 / 平均盈利率（纯 HTTP，不依赖本地 DB / .env）
 * npx tsx scripts/analyze-return-metrics-live.ts --wallet=0xa445...
 */
const DATA_API = 'https://data-api.polymarket.com';
const WINDOW_DAYS = 365;

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length).trim();
  }
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function fmtPct(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  const pct = Math.abs(ratio) <= 5 ? ratio * 100 : ratio;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function titleOf(row: Record<string, unknown>): string {
  const t = row.title;
  if (typeof t === 'string' && t.trim()) return t.trim().slice(0, 72);
  return '(no title)';
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${url} ${body.slice(0, 120)}`);
  }
  return res.json();
}

/** 与 polymarketData.fetchDataApiClosedPositions 一致：limit≤50 翻页 */
async function fetchClosedPositions(wallet: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const limit = 50;
  let offset = 0;
  for (let page = 0; page < 40; page += 1) {
    const url = `${DATA_API}/closed-positions?user=${wallet}&limit=${limit}&offset=${offset}`;
    const data = await fetchJson(url);
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      if (row && typeof row === 'object') out.push(row as Record<string, unknown>);
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return out;
}

async function fetchOpenPositions(wallet: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const limit = 500;
  let offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const url = `${DATA_API}/positions?user=${wallet}&limit=${limit}&offset=${offset}&sizeThreshold=0`;
    const data = await fetchJson(url);
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      if (row && typeof row === 'object') out.push(row as Record<string, unknown>);
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return out;
}

function extractClosedAtMs(row: Record<string, unknown>): number | null {
  for (const key of ['timestamp', 'createdAt', 'endDate', 'closedAt', 'updatedAt']) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
      if (/^\d+$/.test(value.trim())) {
        const n = Number(value.trim());
        return n < 1e12 ? n * 1000 : n;
      }
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

function filterRecent(rows: Record<string, unknown>[], nowMs = Date.now()): Record<string, unknown>[] {
  const threshold = nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const withTs = rows.filter((r) => extractClosedAtMs(r) != null);
  if (withTs.length === 0) return rows;
  return withTs.filter((r) => {
    const ms = extractClosedAtMs(r);
    return ms != null && ms >= threshold;
  });
}

/** 与 smartMoneyPositionStats.extractClosedPositionReturnRatio 一致 */
function extractReturnRatio(row: Record<string, unknown>): number | null {
  const explicit = num(row.percentRealizedPnl) ?? num(row.percentPnl);
  if (explicit != null) {
    return Math.abs(explicit) > 1 ? explicit / 100 : explicit;
  }
  const pnl = num(row.realizedPnl) ?? num(row.pnl) ?? num(row.cashPnl) ?? num(row.totalPnl);
  const bought = num(row.totalBought);
  const avg = num(row.avgPrice);
  const cost =
    num(row.initialValue) ?? (bought != null && avg != null ? bought * avg : null);
  if (pnl == null || cost == null || cost <= 0) return null;
  return round4(pnl / cost);
}

function costOf(row: Record<string, unknown>): number | null {
  const bought = num(row.totalBought);
  const avg = num(row.avgPrice);
  return num(row.initialValue) ?? (bought != null && avg != null ? bought * avg : null);
}

function pnlOf(row: Record<string, unknown>): number | null {
  return num(row.realizedPnl) ?? num(row.pnl) ?? num(row.cashPnl) ?? num(row.totalPnl);
}

/** 精简版 resolveCapitalDeployedPrincipal + computeCapitalReturnRatio */
function computeCapitalRoi(input: {
  totalPnl: number | null;
  costBasis: number | null;
  holdingsValue: number | null;
  totalVolume: number | null;
}): {
  ratio: number | null;
  principal: number | null;
  source: string | null;
  turnover: number | null;
} {
  const pnl = input.totalPnl;
  if (pnl == null) {
    return { ratio: null, principal: null, source: null, turnover: null };
  }
  const MIN_PRINCIPAL = 50;
  const candidates: Array<{ source: string; principal: number }> = [];
  if (input.costBasis != null && input.costBasis >= MIN_PRINCIPAL) {
    candidates.push({ source: 'COST_BASIS', principal: input.costBasis });
  }
  if (input.holdingsValue != null && input.holdingsValue >= MIN_PRINCIPAL) {
    candidates.push({ source: 'HOLDINGS', principal: input.holdingsValue });
  }
  let principal: number | null = null;
  let source: string | null = null;
  if (candidates.length) {
    const best = candidates.reduce((a, b) => (b.principal > a.principal ? b : a));
    principal = best.principal;
    source = best.source;
  }

  let ratio: number | null = null;
  if (principal != null && principal > 0) {
    ratio = round4(pnl / principal);
    // 开仓现货 ROI 过大则不可信，回退成交量
    if (Math.abs(ratio) > 1 && input.totalVolume != null && input.totalVolume > 0) {
      ratio = round4(pnl / input.totalVolume);
      principal = input.totalVolume;
      source = 'VOLUME';
    }
  }

  const turnover =
    input.totalVolume != null && input.totalVolume > 0
      ? round4(pnl / input.totalVolume)
      : null;

  if (ratio == null && turnover != null) {
    ratio = turnover;
    principal = input.totalVolume;
    source = 'VOLUME';
  }

  return { ratio, principal, source, turnover };
}

async function main() {
  const wallet = (getArg('wallet') ?? '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error('need --wallet=0x...');

  console.log(`\n=== 本地采集并复算: ${wallet} ===\n`);

  const [closedRows, openRows] = await Promise.all([
    fetchClosedPositions(wallet),
    fetchOpenPositions(wallet),
  ]);
  console.log(`closed-positions 总行数: ${closedRows.length}`);
  console.log(`open positions 总行数: ${openRows.length}`);

  const recent = filterRecent(closedRows);
  console.log(`近 ${WINDOW_DAYS} 天已平仓行数: ${recent.length}`);

  type Calc = {
    title: string;
    pnl: number | null;
    cost: number | null;
    ratio: number | null;
    source: 'percentPnl' | 'pnl/cost' | 'none';
  };
  const calcs: Calc[] = recent.map((row) => {
    const explicit = num(row.percentRealizedPnl) ?? num(row.percentPnl);
    const ratio = extractReturnRatio(row);
    return {
      title: titleOf(row),
      pnl: pnlOf(row),
      cost: costOf(row),
      ratio,
      source:
        ratio == null
          ? 'none'
          : explicit != null
            ? 'percentPnl'
            : 'pnl/cost',
    };
  });

  const usable = calcs.filter((c) => c.ratio != null) as Array<Calc & { ratio: number }>;
  const sum = usable.reduce((s, c) => s + c.ratio, 0);
  const mean = usable.length ? round4(sum / usable.length) : null;
  const winN = usable.filter((c) => c.ratio > 0).length;
  const lossN = usable.filter((c) => c.ratio < 0).length;
  const flatN = usable.filter((c) => c.ratio === 0).length;

  console.log('\n==================== A) 平均盈利率 ====================');
  console.log('口径: 近365天已平仓按市场汇总后，事件收益率等权算术平均（亏=负比率）');
  console.log('单笔: 市场 Σpnl / Σcost（行先按 conditionId 合并）');
  console.log(`可算样本 N=${usable.length}（盈 ${winN} / 亏 ${lossN} / 平 ${flatN}）`);
  console.log(`Σ比率 = ${sum.toFixed(6)}`);
  console.log(`mean = Σ/N = ${sum.toFixed(6)} / ${usable.length} = ${mean}`);
  console.log(`展示平均盈利率 ≈ ${fmtPct(mean)}`);

  const sorted = [...usable].sort((a, b) => b.ratio - a.ratio);
  console.log('\n盈利率 TOP10（等权拉高均值）:');
  for (const c of sorted.slice(0, 10)) {
    console.log(
      `  ${fmtPct(c.ratio).padStart(9)} | pnl=${(c.pnl ?? 0).toFixed(2).padStart(10)} cost=${(c.cost ?? 0).toFixed(2).padStart(10)} | ${c.title}`
    );
  }
  console.log('\n盈利率 BOTTOM10（亏损已计入）:');
  for (const c of sorted.slice(-10).reverse()) {
    console.log(
      `  ${fmtPct(c.ratio).padStart(9)} | pnl=${(c.pnl ?? 0).toFixed(2).padStart(10)} cost=${(c.cost ?? 0).toFixed(2).padStart(10)} | ${c.title}`
    );
  }

  let wPnl = 0;
  let wCost = 0;
  for (const c of usable) {
    if (c.pnl != null && c.cost != null && c.cost > 0) {
      wPnl += c.pnl;
      wCost += c.cost;
    }
  }
  const weighted = wCost > 0 ? round4(wPnl / wCost) : null;
  console.log('\n对照【本金加权】Σpnl/Σcost:');
  console.log(`  Σpnl=${wPnl.toFixed(2)} Σcost=${wCost.toFixed(2)} → ${fmtPct(weighted)}`);

  // —— 总盈利率 ——
  let openCost = 0;
  let openValue = 0;
  for (const row of openRows) {
    const size = num(row.size) ?? num(row.totalBought);
    const avg = num(row.avgPrice);
    const cost =
      num(row.initialValue) ?? (size != null && avg != null ? size * avg : null);
    const cur = num(row.currentValue) ?? num(row.value);
    if (cost != null) openCost += cost;
    if (cur != null) openValue += cur;
  }

  let holdingsApi: number | null = null;
  try {
    const j = (await fetchJson(`${DATA_API}/value?user=${wallet}`)) as any;
    holdingsApi = Array.isArray(j) ? num(j[0]?.value) : num(j?.value);
  } catch (e) {
    console.log('value API fail', e);
  }

  let lbPnl: number | null = null;
  let lbVol: number | null = null;
  try {
    const j = (await fetchJson(
      `${DATA_API}/v1/leaderboard?timePeriod=ALL&orderBy=PNL&limit=1&user=${wallet}&category=OVERALL`
    )) as any;
    const row = Array.isArray(j) ? j[0] : null;
    if (row) {
      lbPnl = num(row.pnl);
      lbVol = num(row.vol);
    }
  } catch (e) {
    console.log('leaderboard API fail', e);
  }

  // 官网 profile 常用：再试 user-pnl 风格不可用时，用 closed 合计作参考
  const closedSumPnl = closedRows.reduce((s, r) => s + (pnlOf(r) ?? 0), 0);

  const totalPnl = lbPnl ?? closedSumPnl;
  const holdings = holdingsApi ?? (openValue > 0 ? openValue : null);
  const costBasis = openCost > 0 ? openCost : null;

  const roi = computeCapitalRoi({
    totalPnl,
    costBasis,
    holdingsValue: holdings,
    totalVolume: lbVol,
  });

  console.log('\n==================== B) 总盈利率 ====================');
  console.log('口径: 近365天已平仓事件 Σpnl ÷ Σcost（与线上一致；不可用显示 —，不回退 volume）');
  console.log(`closed 近窗 Σpnl=${wPnl.toFixed(2)} Σcost=${wCost.toFixed(2)} → ${fmtPct(weighted)}`);
  console.log('(对照旧开仓现货 ROI，仅诊断用，线上已废弃作主指标)');
  console.log(`openCost=${openCost.toFixed(2)} openValue=${openValue.toFixed(2)}`);
  console.log(`/value holdings=${holdingsApi ?? '—'} 采用=${holdings ?? '—'}`);
  console.log(`leaderboard ALL pnl=${lbPnl ?? '—'} vol=${lbVol ?? '—'}`);
  console.log(`closed 全量 ΣrealizedPnl=${closedSumPnl.toFixed(2)}`);
  console.log(`旧资本ROI totalPnl=${totalPnl} 本金=${roi.principal} 来源=${roi.source} → ${fmtPct(roi.ratio)}`);
  console.log(`turnover(PnL/vol 辅)=${roi.turnover} → ${fmtPct(roi.turnover)}`);

  console.log('\n==================== C) 结论 ====================');
  console.log(`平均盈利率(事件等权) ≈ ${fmtPct(mean)}`);
  console.log(`总盈利率(Σpnl/Σcost) ≈ ${fmtPct(weighted)}`);
  console.log('注: 等权平均可被小本金高倍率单拉高；总盈利率按成本合计，两者可不一致。');
  console.log(
    JSON.stringify(
      {
        wallet,
        closedRows: closedRows.length,
        recentRows: recent.length,
        avgN: usable.length,
        avgMeanRatio: mean,
        avgDisplay: fmtPct(mean),
        totalClosedCostRoi: weighted,
        totalDisplay: fmtPct(weighted),
        legacyOpenSpotRoi: {
          totalPnl,
          principal: roi.principal,
          principalSource: roi.source,
          totalReturnRatio: roi.ratio,
        },
        winN,
        lossN,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
