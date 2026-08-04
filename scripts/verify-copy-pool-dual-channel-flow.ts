/**
 * 榜单双通道 + Gate 增量 — 本地无库全流程回归（对齐方案 v1.2）
 *
 * Usage:
 *   npx tsx scripts/verify-copy-pool-dual-channel-flow.ts
 */
import assert from 'node:assert/strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/polycopy_test';
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.SMART_MONEY_COPY_POOL_RESCORE_MODE = 'dual_channel';
process.env.SMART_MONEY_COPY_POOL_DAILY_TOP_N = '100';
process.env.SMART_MONEY_CLOSED_GATE_MAX_PAGES = '30';

type Stage = 'QUALIFIED' | 'COPY_POOL' | 'SCORED';

type SimWallet = {
  wallet: string;
  stage: Stage;
  rank: number | null;
  inCopyPool: boolean;
  lastScoredAt: number | null;
  nextDeepAnalyzeAt: number;
  lastDeepQueuedAt: number | null;
};

const DAY = 86_400_000;
let nowMs = Date.parse('2026-07-29T08:00:00.000Z');
const TOP_N = 100;

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function isScoredToday(w: SimWallet): boolean {
  return w.lastScoredAt != null && dayKey(w.lastScoredAt) === dayKey(nowMs);
}

function seedPool(): SimWallet[] {
  const rows: SimWallet[] = [];
  for (let i = 1; i <= 250; i += 1) {
    rows.push({
      wallet: `0x${i.toString(16).padStart(40, '0')}`,
      stage: 'COPY_POOL',
      rank: i,
      inCopyPool: true,
      // Top150 昨天评过；其余更早 → Top100 今日全 due
      lastScoredAt: nowMs - (i <= 150 ? DAY + 3_600_000 : 3 * DAY),
      nextDeepAnalyzeAt: nowMs - 1,
      lastDeepQueuedAt: nowMs - i * 60_000,
    });
  }
  // 3 个刚入榜无 rank（应进 background 优先）
  for (let i = 0; i < 3; i += 1) {
    rows.push({
      wallet: `0xnull${i.toString().padStart(36, '0')}`,
      stage: 'COPY_POOL',
      rank: null,
      inCopyPool: true,
      lastScoredAt: nowMs - DAY,
      nextDeepAnalyzeAt: nowMs - 1,
      lastDeepQueuedAt: null,
    });
  }
  // 2 个 QUALIFIED 进水
  for (let i = 0; i < 2; i += 1) {
    rows.push({
      wallet: `0xq${i.toString().padStart(39, '0')}`,
      stage: 'QUALIFIED',
      rank: null,
      inCopyPool: false,
      lastScoredAt: null,
      nextDeepAnalyzeAt: nowMs - 1,
      lastDeepQueuedAt: null,
    });
  }
  return rows;
}

function countPriorityDue(rows: SimWallet[]): number {
  return rows.filter(
    (w) =>
      w.inCopyPool &&
      w.stage === 'COPY_POOL' &&
      w.rank != null &&
      w.rank >= 1 &&
      w.rank <= TOP_N &&
      !isScoredToday(w)
  ).length;
}

function pickPriority(rows: SimWallet[], limit: number): string[] {
  return rows
    .filter(
      (w) =>
        w.inCopyPool &&
        w.stage === 'COPY_POOL' &&
        w.rank != null &&
        w.rank >= 1 &&
        w.rank <= TOP_N &&
        !isScoredToday(w) &&
        w.nextDeepAnalyzeAt <= nowMs
    )
    .sort((a, b) => (a.rank! - b.rank!) || a.wallet.localeCompare(b.wallet))
    .slice(0, limit)
    .map((w) => w.wallet);
}

/** NULLS FIRST then rank ASC */
function compareBg(a: SimWallet, b: SimWallet): number {
  if (a.rank == null && b.rank != null) return -1;
  if (a.rank != null && b.rank == null) return 1;
  if (a.rank != null && b.rank != null && a.rank !== b.rank) return a.rank - b.rank;
  return a.wallet.localeCompare(b.wallet);
}

type Cursor = { lastRank: number | null; lastWallet: string | null };

function afterCursor(w: SimWallet, cursor: Cursor): boolean {
  if (cursor.lastWallet == null && cursor.lastRank == null) return true;
  if (cursor.lastRank == null) {
    if (w.rank == null) return w.wallet > (cursor.lastWallet ?? '');
    return w.rank > TOP_N;
  }
  if (w.rank == null) return false;
  if (w.rank > cursor.lastRank) return true;
  return w.rank === cursor.lastRank && w.wallet > (cursor.lastWallet ?? '');
}

function pickBackground(rows: SimWallet[], limit: number, cursor: Cursor): { wallets: string[]; cursor: Cursor } {
  const eligible = rows
    .filter(
      (w) =>
        w.inCopyPool &&
        w.stage === 'COPY_POOL' &&
        (w.rank == null || w.rank > TOP_N) &&
        w.nextDeepAnalyzeAt <= nowMs &&
        afterCursor(w, cursor)
    )
    .sort(compareBg);

  let batch = eligible.slice(0, limit);
  let wrapped = false;
  if (batch.length === 0 && (cursor.lastWallet != null || cursor.lastRank != null)) {
    wrapped = true;
    batch = rows
      .filter(
        (w) =>
          w.inCopyPool &&
          w.stage === 'COPY_POOL' &&
          (w.rank == null || w.rank > TOP_N) &&
          w.nextDeepAnalyzeAt <= nowMs
      )
      .sort(compareBg)
      .slice(0, limit);
  }
  if (batch.length === 0) {
    return { wallets: [], cursor: wrapped ? { lastRank: null, lastWallet: null } : cursor };
  }
  const last = batch[batch.length - 1]!;
  return {
    wallets: batch.map((w) => w.wallet),
    cursor: { lastRank: last.rank, lastWallet: last.wallet },
  };
}

function pickRescoreSlots(
  rows: SimWallet[],
  limit: number,
  cursor: Cursor
): { wallets: string[]; channel: 'priority' | 'background'; cursor: Cursor; priorityDue: number } {
  const priorityDue = countPriorityDue(rows);
  if (priorityDue > 0) {
    const wallets = pickPriority(rows, limit);
    if (wallets.length > 0) {
      return { wallets, channel: 'priority', cursor, priorityDue };
    }
  }
  const bg = pickBackground(rows, limit, cursor);
  return { wallets: bg.wallets, channel: 'background', cursor: bg.cursor, priorityDue };
}

/** Deep 批：80% QUALIFIED 地板 + 复评份额 */
function pickDeepBatch(rows: SimWallet[], limit: number, cursor: Cursor, refreshShare = 0.25) {
  const qualifiedReady = rows.filter((w) => w.stage === 'QUALIFIED' && w.nextDeepAnalyzeAt <= nowMs).length;
  const minQualifiedShare = 0.8;
  const maxRefresh =
    qualifiedReady > 0 ? Math.max(0, limit - Math.ceil(limit * minQualifiedShare)) : limit;
  const refreshLimit = Math.max(0, Math.min(Math.floor(limit * refreshShare), maxRefresh));
  const pipelineLimit = Math.max(0, limit - refreshLimit);

  const rescore = pickRescoreSlots(rows, refreshLimit, cursor);
  const qualified = rows
    .filter((w) => w.stage === 'QUALIFIED' && w.nextDeepAnalyzeAt <= nowMs)
    .slice(0, pipelineLimit)
    .map((w) => w.wallet);

  return {
    wallets: [...rescore.wallets, ...qualified].slice(0, limit),
    channel: rescore.channel,
    cursor: rescore.cursor,
    refreshLimit,
    pipelineLimit,
    priorityDue: rescore.priorityDue,
  };
}

function rescoreWallet(rows: SimWallet[], wallet: string): void {
  const w = rows.find((r) => r.wallet === wallet);
  if (!w) return;
  w.lastScoredAt = nowMs;
  w.nextDeepAnalyzeAt = nowMs; // dual_channel: immediate eligible
  w.lastDeepQueuedAt = nowMs;
  if (w.stage === 'QUALIFIED') {
    // 仿真：一半入池
    const n = Number.parseInt(w.wallet.replace(/\D/g, '').slice(-1) || '0', 16);
    if (n % 2 === 0) {
      w.stage = 'COPY_POOL';
      w.inCopyPool = true;
      w.rank = 999; // 近似尾部，待正式 flush
    } else {
      w.stage = 'SCORED';
    }
  }
}

// —— incremental merge 纯函数复用 ——
async function runIncrementalUnit(): Promise<void> {
  const { mergeClosedRowsIncremental, computeNewestClosedAtMs } = await import(
    '../src/services/smartMoney/smartMoneyClosedIncremental.js'
  );
  type Pos = {
    asset: string;
    conditionId: string;
    redeemable: boolean;
    outcomeIndex: number;
    timestamp: string;
    size: number;
  };
  const row = (id: string, ts: string): Pos => ({
    asset: id,
    conditionId: id,
    redeemable: false,
    outcomeIndex: 0,
    timestamp: ts,
    size: 1,
  });
  const merged = mergeClosedRowsIncremental({
    existing: [row('a', '2026-07-20T00:00:00.000Z'), row('b', '2026-07-10T00:00:00.000Z')],
    incoming: [row('c', '2026-07-28T00:00:00.000Z'), row('a', '2026-07-20T00:00:00.000Z')],
    nowMs: Date.parse('2026-07-29T00:00:00.000Z'),
    windowDays: 365,
    maxRows: 100,
  });
  assert.equal(merged.length, 3);
  assert.equal(computeNewestClosedAtMs(merged as never), Date.parse('2026-07-28T00:00:00.000Z'));
}

async function main(): Promise<void> {
  const { CONFIG } = await import('../src/config/env.js');
  assert.equal(CONFIG.smartMoneyCopyPoolRescoreMode, 'dual_channel');
  assert.equal(CONFIG.smartMoneyClosedGateMaxPages, 30);
  assert.equal(CONFIG.smartMoneyCopyPoolDailyTopN, 100);

  await runIncrementalUnit();

  const rows = seedPool();
  let cursor: Cursor = { lastRank: null, lastWallet: null };
  const logs: string[] = [];

  // 1) 开盘：TopN 应抢占，cursor 不变
  const cursorBefore = { ...cursor };
  let due = countPriorityDue(rows);
  assert.equal(due, 100, `expected 100 top due, got ${due}`);

  const batch1 = pickDeepBatch(rows, 10, cursor, 0.25);
  assert.equal(batch1.channel, 'priority');
  assert.equal(batch1.refreshLimit, 2); // floor(10*0.25)=2, qualified floor keeps ≤2
  const rescoreOnly = batch1.wallets.slice(0, batch1.refreshLimit);
  assert.ok(rescoreOnly.length > 0);
  assert.ok(
    rescoreOnly.every((w) => {
      const row = rows.find((r) => r.wallet === w)!;
      return row.rank != null && row.rank <= TOP_N;
    }),
    'rescore slots must be TopN'
  );
  assert.deepEqual(batch1.cursor, cursorBefore, 'cursor must pause during priority');
  for (const w of rescoreOnly) rescoreWallet(rows, w);
  logs.push(`batch1 priority=${rescoreOnly.length} dueLeft=${countPriorityDue(rows)}`);

  // 2) 连续清 TopN（只跑复评槽，忽略 QUALIFIED 占用仿真加速）
  let guard = 0;
  while (countPriorityDue(rows) > 0 && guard < 200) {
    guard += 1;
    const picked = pickRescoreSlots(rows, 5, cursor);
    assert.equal(picked.channel, 'priority');
    assert.deepEqual(picked.cursor, cursor, 'cursor frozen while top due');
    assert.ok(picked.wallets.length > 0);
    for (const w of picked.wallets) rescoreWallet(rows, w);
  }
  assert.equal(countPriorityDue(rows), 0, 'TopN must clear');
  logs.push(`cleared topN in ${guard} micro-batches`);

  // 3) TopN 清零后 background 启动；无 rank 优先
  const bg1 = pickRescoreSlots(rows, 5, cursor);
  assert.equal(bg1.channel, 'background');
  cursor = bg1.cursor;
  const firstBg = bg1.wallets.map((w) => rows.find((r) => r.wallet === w)!);
  assert.ok(firstBg.some((w) => w.rank == null), 'null rank should be preferred in background');
  for (const w of bg1.wallets) rescoreWallet(rows, w);
  logs.push(`bg1 wallets=${bg1.wallets.length} cursor=${JSON.stringify(cursor)}`);

  // 4) cursor 连续前进并可绕回
  let seen = new Set<string>();
  for (let i = 0; i < 80; i += 1) {
    const bg = pickRescoreSlots(rows, 3, cursor);
    assert.equal(bg.channel, 'background');
    cursor = bg.cursor;
    for (const w of bg.wallets) {
      seen.add(w);
      rescoreWallet(rows, w);
    }
  }
  assert.ok(seen.size > 50, `background should rotate many wallets, seen=${seen.size}`);
  logs.push(`background rotated unique=${seen.size}`);

  // 5) QUALIFIED 地板：有就绪 QUALIFIED 时复评槽不超过 20%
  rows.push({
    wallet: '0xqualifiedready000000000000000000000001',
    stage: 'QUALIFIED',
    rank: null,
    inCopyPool: false,
    lastScoredAt: null,
    nextDeepAnalyzeAt: nowMs - 1,
    lastDeepQueuedAt: null,
  });
  // 再制造少量 Top due：把 rank1 拨回昨天
  const top1 = rows.find((r) => r.rank === 1)!;
  top1.lastScoredAt = nowMs - DAY;
  top1.nextDeepAnalyzeAt = nowMs - 1;
  const batchQ = pickDeepBatch(rows, 10, cursor, 0.25);
  assert.ok(batchQ.refreshLimit <= 2, `refreshLimit=${batchQ.refreshLimit}`);
  assert.ok(batchQ.pipelineLimit >= 8, `pipelineLimit=${batchQ.pipelineLimit}`);
  logs.push(`qualified floor refreshLimit=${batchQ.refreshLimit} pipelineLimit=${batchQ.pipelineLimit}`);

  // 6) priority 全冷却时不得饿死 background
  for (const w of rows) {
    if (w.rank != null && w.rank <= TOP_N) {
      w.lastScoredAt = nowMs - DAY;
      w.nextDeepAnalyzeAt = nowMs + 15 * 60_000; // cooling
    }
  }
  const starved = pickRescoreSlots(rows, 5, cursor);
  assert.equal(starved.channel, 'background', 'must fall through when priority cooling');
  assert.ok(starved.priorityDue > 0);
  logs.push(`cooling fallthrough channel=${starved.channel} due=${starved.priorityDue}`);

  // 7) CONFIG / 指标模块
  const { resetCopyPoolRescoreMetricsForTest, recordClosedIncrementalMetric, getCopyPoolRescoreMetricSnapshot } =
    await import('../src/services/smartMoney/smartMoneyCopyPoolRescoreMetrics.js');
  resetCopyPoolRescoreMetricsForTest();
  recordClosedIncrementalMetric('incremental');
  recordClosedIncrementalMetric('full_rebuild_needed');
  const snap = getCopyPoolRescoreMetricSnapshot();
  assert.equal(snap.incrementalHit, 1);
  assert.ok(snap.incrementalHitRate != null);

  console.log('[verify-dual-channel] OK');
  for (const line of logs) console.log('  -', line);
}

main().catch((err) => {
  console.error('[verify-dual-channel] FAIL', err);
  process.exit(1);
});
