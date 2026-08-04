import '../src/loadEnv';
import { prisma } from '../src/db';
import { fetchDataApiClosedPositions } from '../src/services/polymarket/polymarketData';

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length).trim();
  }
  return null;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundMetric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function marketKeyFromRow(row: any, fallbackIndex: number): string {
  if (typeof row.conditionId === 'string' && row.conditionId) return row.conditionId;
  if (typeof row.asset === 'string' && row.asset) return row.asset;
  return `row:${fallbackIndex}`;
}

function extractPnlFromRow(row: any, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberFromUnknown(row[key]);
    if (value != null) return value;
  }
  return null;
}

function computeClosedProfitFactorFromRows(rows: any[]): {
  sampleSize: number;
  marketCount: number;
  decisiveMarkets: number;
  winningMarkets: number;
  grossProfit: number;
  grossLossAbs: number;
  oldSentinelProfitFactor: number | null;
  updatedProfitFactor: number | null;
} {
  const pnlByMarket = new Map<string, number>();
  let totalPnl = 0;
  let sampleSize = 0;

  for (const row of rows) {
    const pnl = extractPnlFromRow(row, ['realizedPnl', 'pnl', 'cashPnl', 'totalPnl', 'profit']);
    if (pnl == null) continue;
    sampleSize += 1;
    totalPnl += pnl;

    const marketKey = marketKeyFromRow(row, sampleSize);
    pnlByMarket.set(marketKey, (pnlByMarket.get(marketKey) ?? 0) + pnl);
  }

  const marketPnls = [...pnlByMarket.values()];
  let winningMarkets = 0;
  let decisiveMarkets = 0;
  let grossProfit = 0;
  let grossLossAbs = 0;

  for (const pnl of marketPnls) {
    if (pnl > 0) grossProfit += pnl;
    else if (pnl < 0) grossLossAbs += Math.abs(pnl);

    if (Math.abs(pnl) < 0.5) continue;
    decisiveMarkets += 1;
    if (pnl > 0) winningMarkets += 1;
  }

  const oldSentinelProfitFactor =
    grossLossAbs > 0 ? roundMetric(grossProfit / grossLossAbs) : grossProfit > 0 ? 99 : null;

  const updatedProfitFactor = grossLossAbs > 0 ? roundMetric(grossProfit / grossLossAbs) : null;

  // totalPnl currently not printed; kept for future extension
  void totalPnl;

  return {
    sampleSize,
    marketCount: marketPnls.length,
    decisiveMarkets,
    winningMarkets,
    grossProfit,
    grossLossAbs,
    oldSentinelProfitFactor,
    updatedProfitFactor,
  };
}

function extractStoredProfitFactor(scoreExplain: any): number | null {
  if (scoreExplain == null || typeof scoreExplain !== 'object' || Array.isArray(scoreExplain)) return null;
  const explain = scoreExplain as any;

  const candidates = [
    explain.displayProfile,
    explain.externalPrimary,
    explain.externalPredictingTop?.all,
    explain.externalMerged?.all,
    explain.externalLocalFallback?.all,
  ];

  for (const block of candidates) {
    if (block == null || typeof block !== 'object' || Array.isArray(block)) continue;
    const n = (block as any).profitFactor;
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    // 与 extractSmartMoneyExplainMetric 一致：过滤掉 n<=0 或 n>100
    if (n <= 0 || n > 100) continue;
    return n;
  }

  return null;
}

async function main(): Promise<void> {
  const walletArg = getArg('wallet') ?? process.argv[2] ?? null;
  if (!walletArg) {
    throw new Error('Usage: npx tsx scripts/debug-smart-money-profit-factor.ts --wallet=0x...');
  }
  const wallet = walletArg.toLowerCase();

  console.log('=== Debug PF for wallet ===');
  console.log('wallet:', wallet);

  console.log('\n--- 1) Fetch data-api closed-positions ---');
  const { rows: closedRows } = await fetchDataApiClosedPositions(wallet, {
    limit: 50,
    maxPages: 2,
    skipCache: true,
  });
  console.log('closedRows:', closedRows.length);

  const computed = computeClosedProfitFactorFromRows(closedRows);
  console.log('computed.sampleSize:', computed.sampleSize);
  console.log('computed.marketCount:', computed.marketCount);
  console.log('computed.decidingMarkets(>=|pnl|>=0.5):', computed.decisiveMarkets);
  console.log('computed.winningMarkets:', computed.winningMarkets);
  console.log('grossProfit:', computed.grossProfit);
  console.log('grossLossAbs:', computed.grossLossAbs);
  console.log('oldSentinelProfitFactor(legacy):', computed.oldSentinelProfitFactor);
  console.log('updatedProfitFactor(current code):', computed.updatedProfitFactor);

  console.log('\n--- 2) Read DB scoreExplain profitFactor ---');
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: {
      wallet: true,
      score: true,
      rank: true,
      recentPnl7d: true,
      scoreExplain: true,
      displayScore: true,
      rankScore: true,
      inCopyPool: true,
      lastScoredAt: true,
      copyPoolEnteredAt: true,
    },
  });

  if (!row) {
    console.log('DB row not found.');
    return;
  }

  const storedPf = extractStoredProfitFactor(row.scoreExplain);
  console.log('DB.score:', row.score?.toString?.() ?? row.score);
  console.log('DB.rank:', row.rank);
  console.log('DB.recentPnl7d:', row.recentPnl7d?.toString?.() ?? row.recentPnl7d);
  console.log('DB.inCopyPool:', row.inCopyPool);
  console.log('DB.lastScoredAt:', row.lastScoredAt?.toISOString?.() ?? row.lastScoredAt);
  console.log('DB.stored profitFactor(profitFactor field):', storedPf);

  console.log('\n--- 3) Explanation ---');
  if (computed.grossLossAbs === 0 && computed.grossProfit > 0) {
    console.log(
      'grossLossAbs == 0 且 grossProfit > 0 => 盈亏比分母(亏损市场总和)为 0，旧逻辑把它占位成 99。'
    );
  } else if (computed.grossLossAbs > 0) {
    console.log('分母非 0 => profitFactor 是有限值，旧逻辑不会走 99 占位分支。');
  } else {
    console.log('grossProfit==0 或样本不足 => 旧逻辑不会返回 99。');
  }
}

main()
  .catch((err) => {
    console.error('[debug-smart-money-profit-factor] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

