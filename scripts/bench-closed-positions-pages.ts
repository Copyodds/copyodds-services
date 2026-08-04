/**
 * closed-positions 翻页速度对比：10 / 40 / 80 页（与生产同函数）。
 *
 * 用法：
 *   npx tsx scripts/bench-closed-positions-pages.ts
 *   npx tsx scripts/bench-closed-positions-pages.ts --pages=10,40,80 --rounds=1
 *   npx tsx scripts/bench-closed-positions-pages.ts --wallets=0xaaa,0xbbb --pages=10,40,80
 *   npx tsx scripts/bench-closed-positions-pages.ts --json=out.json
 *
 * 说明：
 * - 走真实 Data API，需外网
 * - 同一钱包按页数从小到大测，减少后测吃热缓存的偏差（API 侧仍可能有 CDN）
 * - 受 365d 早停 + 120s 总预算约束，低频地址 10/40/80 可能几乎一样快
 */
process.env.CUSTODY_TREASURY_ADDRESS ??=
  '0x0000000000000000000000000000000000000001';
process.env.DATABASE_URL ??= 'postgresql://u:p@127.0.0.1:5432/unused';
process.env.JWT_SECRET ??= 'bench-closed-pages-not-for-prod';
process.env.RPC_URL ??= 'http://127.0.0.1:8545';

import { writeFileSync } from 'node:fs';
import {
  CLOSED_POSITIONS_PAGE_GAP_MS,
  CLOSED_POSITIONS_TOTAL_BUDGET_MS,
  CLOSED_POSITIONS_WINDOW_DAYS,
  fetchDataApiClosedPositions,
} from '../src/services/polymarket/polymarketData';

/** 测试服近期 Top 分档样本（含高/中活跃） */
const DEFAULT_WALLETS = [
  '0x88a132c7b2d1901d783ce3307adb36c78428618d',
  '0xce5fd046d90c8f0bde86654560e607eb6600d782',
  '0x9aaff199c14a12eb0efbba92cdaa277a0a428298',
  '0x524db836890e08aceb3abcdee98d44240e324495',
  '0xf7c2664cb29240811d6a89dd3960ebbc03a79b8d',
  '0xc9f9a7610efa67b8614c3152f50af2bd9db6c5e8',
];

const DEFAULT_PAGES = [10, 40, 80];

type RunRow = {
  wallet: string;
  maxPages: number;
  round: number;
  ok: boolean;
  error?: string;
  elapsedMs: number;
  pageCount: number;
  rowCount: number;
      capped: boolean;
  timedOut: boolean;
  /** 未撞页帽且未超时 → 视为自然结束（空页或出窗） */
  naturalStop: boolean;
  windowDays: number;
};

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length).trim();
  }
  return null;
}

function parseWallets(): string[] {
  const raw = getArg('wallets');
  const list = (raw ? raw.split(/[\s,]+/) : DEFAULT_WALLETS)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => /^0x[a-f0-9]{40}$/.test(w));
  if (list.length === 0) throw new Error('no valid wallets');
  return [...new Set(list)];
}

function parsePages(): number[] {
  const raw = getArg('pages') ?? DEFAULT_PAGES.join(',');
  const pages = raw
    .split(/[\s,]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 1)
    .map((n) => Math.floor(n));
  if (pages.length === 0) throw new Error('no valid --pages');
  return [...new Set(pages)].sort((a, b) => a - b);
}

function parseRounds(): number {
  const n = Number(getArg('rounds') ?? '1');
  return Number.isFinite(n) && n >= 1 ? Math.min(5, Math.floor(n)) : 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function pctile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function runOne(wallet: string, maxPages: number, round: number): Promise<RunRow> {
  const started = Date.now();
  try {
    const result = await fetchDataApiClosedPositions(wallet, {
      maxPages,
      windowDays: CLOSED_POSITIONS_WINDOW_DAYS,
      totalBudgetMs: CLOSED_POSITIONS_TOTAL_BUDGET_MS,
      pageGapMs: CLOSED_POSITIONS_PAGE_GAP_MS,
    });
    return {
      wallet,
      maxPages,
      round,
      ok: true,
      elapsedMs: Date.now() - started,
      pageCount: result.meta.pageCount,
      rowCount: result.rows.length,
      capped: result.meta.capped,
      timedOut: result.meta.timedOut,
      naturalStop: !result.meta.capped && !result.meta.timedOut,
      windowDays: result.meta.windowDays,
    };
  } catch (error) {
    return {
      wallet,
      maxPages,
      round,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
      pageCount: 0,
      rowCount: 0,
      capped: false,
      timedOut: false,
      naturalStop: false,
      windowDays: CLOSED_POSITIONS_WINDOW_DAYS,
    };
  }
}

function printTable(rows: RunRow[]): void {
  console.log('\n=== 明细（每钱包 × 每页数）===\n');
  console.log(
    [
      'wallet'.padEnd(14),
      'pages'.padStart(5),
      'elapsed'.padStart(9),
      'gotPages'.padStart(8),
      'rows'.padStart(6),
      'cap'.padStart(4),
      'nat'.padStart(4),
      't/o'.padStart(4),
      'status',
    ].join(' ')
  );
  for (const r of rows) {
    const short = `${r.wallet.slice(0, 8)}…${r.wallet.slice(-4)}`;
    console.log(
      [
        short.padEnd(14),
        String(r.maxPages).padStart(5),
        fmtMs(r.elapsedMs).padStart(9),
        String(r.pageCount).padStart(8),
        String(r.rowCount).padStart(6),
        (r.capped ? 'Y' : 'n').padStart(4),
        (r.naturalStop ? 'Y' : 'n').padStart(4),
        (r.timedOut ? 'Y' : 'n').padStart(4),
        r.ok ? 'ok' : `ERR ${r.error?.slice(0, 40) ?? ''}`,
      ].join(' ')
    );
  }
}

function printSummary(rows: RunRow[], pages: number[]): void {
  const ok = rows.filter((r) => r.ok);
  console.log('\n=== 按 maxPages 汇总 ===\n');
  console.log(
    [
      'maxPages'.padStart(8),
      'n'.padStart(4),
      'avg'.padStart(9),
      'p50'.padStart(9),
      'p90'.padStart(9),
      'max'.padStart(9),
      'avgGotPg'.padStart(9),
      'avgRows'.padStart(8),
      'hitCap%'.padStart(8),
      'vs10'.padStart(8),
    ].join(' ')
  );

  const byPage = new Map<number, number[]>();
  for (const p of pages) byPage.set(p, []);
  for (const r of ok) {
    byPage.get(r.maxPages)?.push(r.elapsedMs);
  }
  const baseAvg = avg(byPage.get(pages[0]!) ?? []);

  for (const p of pages) {
    const ms = byPage.get(p) ?? [];
    const subset = ok.filter((r) => r.maxPages === p);
    const hitCap = subset.filter((r) => r.capped).length;
    const ratio = baseAvg > 0 ? avg(ms) / baseAvg : 0;
    console.log(
      [
        String(p).padStart(8),
        String(ms.length).padStart(4),
        fmtMs(avg(ms)).padStart(9),
        fmtMs(pctile(ms, 50)).padStart(9),
        fmtMs(pctile(ms, 90)).padStart(9),
        fmtMs(Math.max(0, ...ms, 0)).padStart(9),
        (avg(subset.map((r) => r.pageCount)) || 0).toFixed(1).padStart(9),
        Math.round(avg(subset.map((r) => r.rowCount)) || 0)
          .toString()
          .padStart(8),
        `${subset.length ? Math.round((hitCap / subset.length) * 100) : 0}%`.padStart(8),
        `${ratio.toFixed(2)}x`.padStart(8),
      ].join(' ')
    );
  }

  // 同钱包相对加速
  console.log('\n=== 同钱包相对耗时（以该钱包 最小 pages 为 1.0x）===\n');
  const wallets = [...new Set(ok.map((r) => r.wallet))];
  for (const w of wallets) {
    const short = `${w.slice(0, 8)}…${w.slice(-4)}`;
    const mine = ok.filter((r) => r.wallet === w);
    const basePage = Math.min(...mine.map((r) => r.maxPages));
    const base = avg(mine.filter((r) => r.maxPages === basePage).map((r) => r.elapsedMs));
    const parts = pages.map((p) => {
      const m = avg(mine.filter((r) => r.maxPages === p).map((r) => r.elapsedMs));
      const got = avg(mine.filter((r) => r.maxPages === p).map((r) => r.pageCount));
      if (!m) return `p${p}=—`;
      return `p${p}=${fmtMs(m)}/${got.toFixed(0)}pg(${(m / base).toFixed(2)}x)`;
    });
    console.log(`${short}  ${parts.join('  ')}`);
  }

  console.log('\n=== 全量 933 Deep 墙钟粗估（仅 closed 段，concurrency=2）===\n');
  for (const p of pages) {
    const ms = byPage.get(p) ?? [];
    if (ms.length === 0) continue;
    const perWallet = avg(ms);
    const wallHours = (933 * perWallet) / 2 / 3600_000;
    console.log(
      `maxPages=${p}: avg closed ${fmtMs(perWallet)} → 933@c=2 约 ${wallHours.toFixed(2)}h（仅 closed，不含 profile/trades/写库）`
    );
  }
}

async function main(): Promise<void> {
  const wallets = parseWallets();
  const pages = parsePages();
  const rounds = parseRounds();
  const jsonPath = getArg('json');

  console.log('[bench-closed-pages] plan', {
    wallets: wallets.length,
    pages,
    rounds,
    windowDays: CLOSED_POSITIONS_WINDOW_DAYS,
    totalBudgetMs: CLOSED_POSITIONS_TOTAL_BUDGET_MS,
    pageGapMs: CLOSED_POSITIONS_PAGE_GAP_MS,
  });

  const rows: RunRow[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const wallet of wallets) {
      for (const maxPages of pages) {
        console.log(`[run] round=${round} wallet=${wallet.slice(0, 10)}… maxPages=${maxPages}`);
        const row = await runOne(wallet, maxPages, round);
        rows.push(row);
        console.log(
          `  -> ${row.ok ? 'ok' : 'ERR'} ${fmtMs(row.elapsedMs)} pages=${row.pageCount} rows=${row.rowCount} capped=${row.capped} naturalStop=${row.naturalStop}`
        );
        // 降低连续打 API 的 429 风险
        await sleep(400);
      }
      await sleep(800);
    }
  }

  printTable(rows);
  printSummary(rows, pages);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
    console.log(`\nJSON written: ${jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
