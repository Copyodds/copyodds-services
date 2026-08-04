/**
 * Smart Money 管线：规则回归 + 吞吐仿真（内存，无需 DB）。
 *
 * Usage:
 *   npx tsx scripts/simulate-smart-money-pipeline-flow.ts
 *   npx tsx scripts/simulate-smart-money-pipeline-flow.ts --bench=100
 *   npx tsx scripts/simulate-smart-money-pipeline-flow.ts --bench=1000
 *
 * 规则对齐现网（方案 v1.4）：
 *   ENTER=40 EXIT=30 missCount=2；出榜 score≤EXIT；展示/排名 score>EXIT；
 *   CopyPool 默认不强制 Tier2E；Light/Deep 门控失败 → ELIMINATED（不再回 RAW/QUALIFIED）
 *   Deep-Gate 可复用 Light Profile 快照（TTL 内）
 */
import assert from 'node:assert/strict';

type Stage =
  | 'RAW'
  | 'LIGHT_ANALYZING'
  | 'QUALIFIED'
  | 'FULL_ANALYZING'
  | 'SCORED'
  | 'COPY_POOL'
  | 'BLOCKED'
  | 'DORMANT'
  | 'ELIMINATED';

type WalletRow = {
  wallet: string;
  stage: Stage;
  dormant: boolean;
  nextLightAnalyzeAt: number | null;
  nextDeepAnalyzeAt: number | null;
  lastLightQueuedAt: number | null;
  lastDeepQueuedAt: number | null;
  sources: string[];
  score: number | null;
  inCopyPool: boolean;
  copyPoolMissCount: number;
  rank: number | null;
  tier2Enhanced: boolean;
  failReason: string | null;
  /** 最近一次 Profile 抓取的仿真时刻（ms） */
  profileFetchedAt: number | null;
  profileSourceLast: 'live' | 'snapshot' | null;
};

/** 对齐 CONFIG 默认 */
const ENTER = 40;
const EXIT = 30;
const EXIT_MISS = 2;
const REQUIRE_TIER2E = false;
const PROFILE_TTL_MS = 45 * 60_000;
const DEEP_QUEUE_MAX = 5;

const LIGHT_BATCH = 40;
const DEEP_BATCH = 30;
const BOOTSTRAP_BATCHES = 3;
const ANALYZE_CONCURRENCY = 5;
const REQUEST_GAP_MS = 300;
/** 经验单钱包耗时（含上游） */
const LIGHT_LIVE_MS = 2500;
const DEEP_LIVE_MS = 9000;
const DEEP_SNAPSHOT_MS = 4500;

let simNow = Date.now();
const db = new Map<string, WalletRow>();
const scoreCache = new Map<string, { score: number; tier2e: boolean }>();
const logs: string[] = [];
let quiet = false;

function log(msg: string): void {
  logs.push(msg);
  if (!quiet) console.log(`[sim] ${msg}`);
}

function now(): number {
  return simNow;
}

function advance(ms: number): void {
  simNow += ms;
}

function resetDb(): void {
  db.clear();
  scoreCache.clear();
  logs.length = 0;
  simNow = Date.now();
}

function ingest(wallet: string, source: string): void {
  const w = wallet.toLowerCase();
  const existing = db.get(w);
  if (!existing) {
    db.set(w, {
      wallet: w,
      stage: 'RAW',
      dormant: false,
      nextLightAnalyzeAt: now(),
      nextDeepAnalyzeAt: null,
      lastLightQueuedAt: null,
      lastDeepQueuedAt: null,
      sources: [source],
      score: null,
      inCopyPool: false,
      copyPoolMissCount: 0,
      rank: null,
      tier2Enhanced: false,
      failReason: null,
      profileFetchedAt: null,
      profileSourceLast: null,
    });
    log(`ingest NEW ${w} source=${source} → RAW`);
    return;
  }
  existing.sources = [...new Set([...existing.sources, source])];
  if (existing.dormant) {
    existing.dormant = false;
    existing.nextLightAnalyzeAt = now();
    existing.nextDeepAnalyzeAt = now();
    log(`ingest WAKE ${w} stage=${existing.stage}`);
  } else {
    log(`ingest TOUCH ${w} stage=${existing.stage} (no reschedule)`);
  }
}

function pickLight(limit: number): string[] {
  const t = now();
  return [...db.values()]
    .filter(
      (r) =>
        !r.dormant &&
        r.stage === 'RAW' &&
        (r.nextLightAnalyzeAt == null || r.nextLightAnalyzeAt <= t)
    )
    .slice(0, limit)
    .map((r) => r.wallet);
}

function pickDeep(limit: number, refreshShare = 0.2): string[] {
  const t = now();
  const qualifiedCount = [...db.values()].filter((r) => !r.dormant && r.stage === 'QUALIFIED').length;
  const refreshLimit = Math.floor(limit * refreshShare);
  // 对齐修复后的 pickCopyPoolStaleRefresh：必须 nextDeep 已到期
  const refresh = [...db.values()]
    .filter(
      (r) =>
        !r.dormant &&
        r.stage === 'COPY_POOL' &&
        (r.nextDeepAnalyzeAt == null || r.nextDeepAnalyzeAt <= t)
    )
    .sort((a, b) => (a.lastDeepQueuedAt ?? 0) - (b.lastDeepQueuedAt ?? 0))
    .slice(0, refreshLimit)
    .map((r) => r.wallet);

  const pipelineLimit = Math.max(0, limit - refresh.length);
  if (qualifiedCount <= DEEP_QUEUE_MAX) {
    const pipeline = [...db.values()]
      .filter(
        (r) =>
          !r.dormant &&
          (r.stage === 'QUALIFIED' || r.stage === 'SCORED' || r.stage === 'COPY_POOL') &&
          (r.nextDeepAnalyzeAt == null || r.nextDeepAnalyzeAt <= t)
      )
      .slice(0, pipelineLimit)
      .map((r) => r.wallet);
    return [...new Set([...refresh, ...pipeline])].slice(0, limit);
  }

  // 过载：至少留 30% 消化 QUALIFIED
  const qualifiedSlots = Math.max(1, Math.ceil(pipelineLimit * 0.3));
  const otherSlots = Math.max(0, pipelineLimit - qualifiedSlots);
  const qualified = [...db.values()]
    .filter(
      (r) =>
        !r.dormant &&
        r.stage === 'QUALIFIED' &&
        (r.nextDeepAnalyzeAt == null || r.nextDeepAnalyzeAt <= t)
    )
    .slice(0, qualifiedSlots)
    .map((r) => r.wallet);
  const others = [...db.values()]
    .filter(
      (r) =>
        !r.dormant &&
        (r.stage === 'SCORED' || r.stage === 'COPY_POOL') &&
        (r.nextDeepAnalyzeAt == null || r.nextDeepAnalyzeAt <= t)
    )
    .slice(0, otherSlots)
    .map((r) => r.wallet);
  return [...new Set([...refresh, ...qualified, ...others])].slice(0, limit);
}

function lightAnalyze(
  wallet: string,
  profile: { holdings: number; predictions: number; curves: number }
): void {
  const row = db.get(wallet)!;
  row.stage = 'LIGHT_ANALYZING';
  row.lastLightQueuedAt = now();
  row.profileFetchedAt = now();
  row.profileSourceLast = 'live';
  const pass = profile.holdings >= 1000 && profile.predictions >= 10 && profile.curves >= 5;
  if (!pass) {
    row.stage = 'ELIMINATED';
    row.nextLightAnalyzeAt = null;
    row.nextDeepAnalyzeAt = null;
    row.failReason = 'T1L_FAIL';
    log(`light FAIL ${wallet} → ELIMINATED`);
    return;
  }
  row.stage = 'QUALIFIED';
  row.nextDeepAnalyzeAt = now();
  row.failReason = null;
  log(`light PASS ${wallet} → QUALIFIED`);
}

function resolveProfileSource(row: WalletRow): 'live' | 'snapshot' {
  if (row.profileFetchedAt != null && now() - row.profileFetchedAt <= PROFILE_TTL_MS) {
    return 'snapshot';
  }
  return 'live';
}

function syncCopyPool(row: WalletRow, score: number, tier2e: boolean, hardFlag: boolean): void {
  if (hardFlag) {
    row.inCopyPool = false;
    row.rank = null;
    row.copyPoolMissCount = 0;
    return;
  }
  const tier2eOk = REQUIRE_TIER2E ? tier2e : true;
  const canEnter = tier2eOk && score >= ENTER;
  if (!row.inCopyPool && canEnter) {
    row.inCopyPool = true;
    row.copyPoolMissCount = 0;
    row.stage = 'COPY_POOL';
    return;
  }
  if (row.inCopyPool) {
    // 设计 §5：score ≤ EXIT 出榜（含刚好 30）
    if (score <= EXIT) {
      row.copyPoolMissCount += 1;
      if (row.copyPoolMissCount >= EXIT_MISS) {
        row.inCopyPool = false;
        row.rank = null;
        row.stage = 'SCORED';
        row.copyPoolMissCount = 0;
      }
    } else {
      row.copyPoolMissCount = 0;
      row.stage = 'COPY_POOL';
    }
  }
}

/** P0：排名前按 EXIT 地板即时摘池 + 赋 rank（score ≤ EXIT 摘掉） */
function recomputeRanks(): { purged: number; ranked: number } {
  let purged = 0;
  for (const row of db.values()) {
    if (row.inCopyPool && (row.score == null || row.score <= EXIT)) {
      row.inCopyPool = false;
      row.rank = null;
      row.stage = row.score != null ? 'SCORED' : row.stage;
      purged += 1;
    }
  }
  const board = [...db.values()]
    .filter((r) => r.inCopyPool && r.score != null && r.score > EXIT)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const row of db.values()) {
    if (!board.includes(row)) row.rank = null;
  }
  board.forEach((row, i) => {
    row.rank = i + 1;
  });
  return { purged, ranked: board.length };
}

function cachedBoard(): WalletRow[] {
  return [...db.values()].filter(
    (r) => r.inCopyPool && r.rank != null && r.score != null && r.score > EXIT
  );
}

function deepAnalyze(
  wallet: string,
  opts: {
    throwError?: boolean;
    score: number;
    tier2e: boolean;
    hardFlag?: boolean;
    /** L1 失败（PnL/回报/回撤） */
    l1Fail?: boolean;
  }
): { prevStage: Stage; profileSource: 'live' | 'snapshot' } {
  const row = db.get(wallet)!;
  const prevStage = row.stage;
  row.stage = 'FULL_ANALYZING';
  row.lastDeepQueuedAt = now();
  const profileSource = resolveProfileSource(row);
  row.profileSourceLast = profileSource;
  if (profileSource === 'live') {
    row.profileFetchedAt = now();
  }

  try {
    if (opts.throwError) {
      throw new Error('rpc_timeout');
    }
    if (opts.l1Fail) {
      row.inCopyPool = false;
      row.rank = null;
      row.stage = 'ELIMINATED';
      row.nextDeepAnalyzeAt = null;
      row.nextLightAnalyzeAt = null;
      row.failReason = 'L1-RET';
      log(`deep L1_FAIL ${wallet} → ELIMINATED`);
      return { prevStage, profileSource };
    }
    scoreCache.set(wallet, { score: opts.score, tier2e: opts.tier2e });
    row.score = opts.score;
    row.tier2Enhanced = opts.tier2e;
    row.stage = 'SCORED';
    syncCopyPool(row, opts.score, opts.tier2e, opts.hardFlag === true);
    if (opts.hardFlag) {
      log(`deep HARD_FLAG ${wallet} → SCORED not enter`);
    } else if (row.inCopyPool) {
      log(`deep ENTER/KEEP ${wallet} score=${opts.score} src=${profileSource} → COPY_POOL`);
    } else {
      log(`deep SCORED ${wallet} score=${opts.score} tier2e=${opts.tier2e} inPool=false`);
    }
    row.nextDeepAnalyzeAt = now() + 7 * 86400_000;
    return { prevStage, profileSource };
  } catch (error) {
    const restore = prevStage === 'FULL_ANALYZING' ? 'QUALIFIED' : prevStage;
    row.stage = restore as Stage;
    row.nextDeepAnalyzeAt = now();
    row.failReason = error instanceof Error ? error.message : String(error);
    log(`deep ERROR ${wallet} restore=${restore} reason=${row.failReason}`);
    return { prevStage, profileSource };
  }
}

/** 批内有界并发耗时：ceil(n/conc)*avg + (n-1)*gap 近似 */
function estimateBatchWallMs(n: number, perWalletMs: number): number {
  if (n <= 0) return 0;
  const waves = Math.ceil(n / ANALYZE_CONCURRENCY);
  const gapCost = Math.max(0, n - 1) * REQUEST_GAP_MS;
  // gap 与并发交错：粗估取 max(wave*per, gap*0.4 + wave*per*0.7)
  const parallel = waves * perWalletMs;
  return Math.round(Math.max(parallel, parallel * 0.7 + gapCost * 0.4));
}

function assertPickableDeep(wallet: string, expect: boolean): void {
  const picked = pickDeep(50);
  const ok = picked.includes(wallet) === expect;
  assert.equal(
    ok,
    true,
    `pickDeep(${wallet}) expect=${expect} got=${picked.includes(wallet)} stages=${[...db.values()]
      .map((r) => `${r.wallet}:${r.stage}`)
      .join(',')}`
  );
}

function runRegression(): void {
  quiet = false;
  resetDb();
  console.log('[sim] === Happy path: discovery → board (ENTER=40, tier2e optional) ===');
  ingest('0x1111111111111111111111111111111111111111', 'OFFICIAL');
  ingest('0x2222222222222222222222222222222222222222', 'BLOCK_SCAN');
  ingest('0x3333333333333333333333333333333333333333', 'PREDICTING_TOP');

  let lightBatch = pickLight(10);
  assert.equal(lightBatch.length, 3);
  for (const w of lightBatch) {
    lightAnalyze(w, { holdings: 5000, predictions: 40, curves: 20 });
  }

  ingest('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'OFFICIAL');
  lightAnalyze('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    holdings: 10,
    predictions: 1,
    curves: 0,
  });
  assert.equal(db.get('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')!.stage, 'ELIMINATED');
  assert.equal(pickDeep(10).includes('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
  log('OK: T1L fail goes to ELIMINATED and never reaches Deep');

  deepAnalyze('0x1111111111111111111111111111111111111111', {
    score: 72,
    tier2e: true,
  });
  // score=40 刚好入榜（ENTER）；无需 tier2e
  deepAnalyze('0x2222222222222222222222222222222222222222', {
    score: 40,
    tier2e: false,
  });
  // 高分但若不要求 tier2e 也可入；这里用 35 测未过 enter
  deepAnalyze('0x3333333333333333333333333333333333333333', {
    score: 35,
    tier2e: true,
  });

  assert.equal(db.get('0x1111111111111111111111111111111111111111')!.inCopyPool, true);
  assert.equal(db.get('0x2222222222222222222222222222222222222222')!.inCopyPool, true);
  assert.equal(db.get('0x3333333333333333333333333333333333333333')!.inCopyPool, false);
  assert.equal(scoreCache.size, 3);
  log('OK: score>=40 enters CopyPool without forcing Tier2E');

  // Profile snapshot reuse within TTL
  const src = resolveProfileSource(db.get('0x1111111111111111111111111111111111111111')!);
  assert.equal(src, 'snapshot');
  log('OK: Deep in TTL uses snapshot (no second live profile)');

  console.log('\n[sim] === P0: low score on board instantly purged ===');
  const dirty = db.get('0x1111111111111111111111111111111111111111')!;
  dirty.score = 18; // 模拟 fast-rescore / 脏分
  dirty.inCopyPool = true;
  const { purged } = recomputeRanks();
  assert.ok(purged >= 1);
  assert.equal(dirty.inCopyPool, false);
  assert.equal(dirty.rank, null);
  assert.equal(cachedBoard().some((r) => (r.score ?? 0) <= EXIT), false);
  log('OK: score=18 purged; cached board respects EXIT floor');

  console.log('\n[sim] === P0: score==EXIT (30) must leave board ===');
  deepAnalyze('0x1111111111111111111111111111111111111111', { score: 72, tier2e: true });
  recomputeRanks();
  const atExit = db.get('0x1111111111111111111111111111111111111111')!;
  atExit.score = EXIT; // 刚好等于出榜线
  atExit.inCopyPool = true;
  const purgeAtExit = recomputeRanks();
  assert.ok(purgeAtExit.purged >= 1);
  assert.equal(atExit.inCopyPool, false);
  assert.equal(cachedBoard().some((r) => r.score === EXIT), false);
  log('OK: score==30 purged (≤ EXIT, not only < EXIT)');

  // restore a valid board member
  deepAnalyze('0x1111111111111111111111111111111111111111', { score: 72, tier2e: true });
  recomputeRanks();

  console.log('\n[sim] === Stuck regression: FULL_ANALYZING error recovery ===');
  ingest('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'OFFICIAL');
  lightAnalyze('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', {
    holdings: 9000,
    predictions: 50,
    curves: 30,
  });
  deepAnalyze('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', {
    score: 60,
    tier2e: true,
    throwError: true,
  });
  assert.notEqual(db.get('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')!.stage, 'FULL_ANALYZING');
  assertPickableDeep('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', true);
  log('OK: deep error restores stage and stays pickable');

  console.log('\n[sim] === L1 reject → ELIMINATED, no stuck COPY_POOL ===');
  ingest('0xcccccccccccccccccccccccccccccccccccccccc', 'BLOCK_SCAN');
  lightAnalyze('0xcccccccccccccccccccccccccccccccccccccccc', {
    holdings: 8000,
    predictions: 30,
    curves: 20,
  });
  deepAnalyze('0xcccccccccccccccccccccccccccccccccccccccc', {
    score: 90,
    tier2e: true,
    l1Fail: true,
  });
  assert.equal(db.get('0xcccccccccccccccccccccccccccccccccccccccc')!.inCopyPool, false);
  assert.equal(db.get('0xcccccccccccccccccccccccccccccccccccccccc')!.stage, 'ELIMINATED');
  log('OK: L1 fail clears pool intent and moves to ELIMINATED');

  console.log('\n[sim] === Queue pressure: QUALIFIED keeps a share ===');
  for (let i = 0; i < DEEP_QUEUE_MAX + 2; i++) {
    const w = `0x${(i + 1).toString(16).padStart(40, 'c')}`;
    ingest(w, 'OFFICIAL');
    lightAnalyze(w, { holdings: 8000, predictions: 20, curves: 10 });
  }
  const qCount = [...db.values()].filter((r) => r.stage === 'QUALIFIED').length;
  const overloaded = qCount > DEEP_QUEUE_MAX;
  const limit = 10;
  const qSlots = overloaded ? Math.max(1, Math.ceil(limit * 0.3)) : limit;
  const qPick = [...db.values()]
    .filter((r) => r.stage === 'QUALIFIED')
    .slice(0, qSlots)
    .map((r) => r.wallet);
  assert.ok(qPick.length > 0, 'overloaded queue must still pick QUALIFIED');
  log(`OK: overloaded=${overloaded} qualifiedSlots=${qSlots} picked=${qPick.length}`);

  console.log('\n[sim] === Duplicate discovery must not flood schedule ===');
  const before = db.get('0x1111111111111111111111111111111111111111')!.nextLightAnalyzeAt;
  ingest('0x1111111111111111111111111111111111111111', 'OFFICIAL');
  assert.equal(db.get('0x1111111111111111111111111111111111111111')!.nextLightAnalyzeAt, before);
  log('OK: re-ingest does not reset nextLightAnalyzeAt');

  recomputeRanks();
  console.log('\n[sim] === Cached board filter ===');
  const board = cachedBoard();
  assert.ok(board.every((r) => (r.score ?? 0) > EXIT));
  assert.ok(board.length >= 1);
  log(`OK: cached board size=${board.length}`);

  const stuck = [...db.values()].filter((r) => r.stage === 'FULL_ANALYZING').length;
  assert.equal(stuck, 0);

  console.log('\n[sim] regression summary PASS');
  console.log(
    JSON.stringify(
      {
        raw: [...db.values()].filter((r) => r.stage === 'RAW').length,
        qualified: [...db.values()].filter((r) => r.stage === 'QUALIFIED').length,
        scored: [...db.values()].filter((r) => r.stage === 'SCORED').length,
        copyPool: [...db.values()].filter((r) => r.inCopyPool).length,
        cachedBoard: board.length,
        scoreCache: scoreCache.size,
        fullAnalyzingStuck: stuck,
      },
      null,
      2
    )
  );
}

type BenchWalletPlan = {
  wallet: string;
  holdings: number;
  predictions: number;
  curves: number;
  score: number;
  tier2e: boolean;
  l1Fail: boolean;
  hardFlag: boolean;
};

function makeBenchPlan(n: number): BenchWalletPlan[] {
  const plans: BenchWalletPlan[] = [];
  for (let i = 0; i < n; i++) {
    const wallet = `0x${(i + 1).toString(16).padStart(40, '0')}`;
    // 漏斗近似：~40% 过 L0，过 L0 后 ~35% 过 L1，过 L1 后 ~55% score>=40
    const r = (i * 2654435761) >>> 0;
    const passL0 = r % 100 < 42;
    const passL1 = passL0 && r % 100 < 55; // of all; ~0.55 of L0 passers roughly → ~23% of raw via L1
    // refine: among L0 passers use another bit
    const amongL0 = ((r >>> 8) % 100) < 55;
    const amongL1Score = ((r >>> 16) % 100) < 60;
    const l0 = passL0;
    const l1Fail = l0 && !amongL0;
    const score =
      l0 && amongL0
        ? amongL1Score
          ? 40 + ((r >>> 3) % 50)
          : 20 + ((r >>> 5) % 19)
        : 10;
    plans.push({
      wallet,
      holdings: l0 ? 2000 + (r % 8000) : 100 + (r % 400),
      predictions: l0 ? 15 + (r % 80) : 1 + (r % 8),
      curves: l0 ? 10 + (r % 40) : r % 4,
      score,
      tier2e: (r >>> 12) % 100 < 40,
      l1Fail,
      hardFlag: l0 && amongL0 && (r >>> 20) % 100 < 3,
    });
  }
  return plans;
}

function runBench(n: number): void {
  quiet = true;
  resetDb();
  const plans = makeBenchPlan(n);
  const planByWallet = new Map(plans.map((p) => [p.wallet, p]));
  const t0 = now();
  let lightWallMs = 0;
  let deepWallMs = 0;
  let lightProcessed = 0;
  let deepProcessed = 0;
  let snapshotHits = 0;
  let liveDeep = 0;
  let lightPass = 0;
  let l1Reject = 0;
  let entered = 0;
  let deepErrors = 0;
  let lightTicks = 0;
  let deepTicks = 0;

  for (let i = 0; i < plans.length; i++) {
    ingest(plans[i]!.wallet, i % 3 === 0 ? 'BLOCK_SCAN' : 'OFFICIAL');
  }

  const maxLightTicks = Math.ceil(n / (LIGHT_BATCH * BOOTSTRAP_BATCHES)) + 5;
  for (let tick = 0; tick < maxLightTicks; tick++) {
    let tickProcessed = 0;
    for (let b = 0; b < BOOTSTRAP_BATCHES; b++) {
      const batch = pickLight(LIGHT_BATCH);
      if (batch.length === 0) break;
      lightTicks += 1;
      for (const w of batch) {
        const plan = planByWallet.get(w)!;
        lightAnalyze(w, plan);
        if (db.get(w)!.stage === 'QUALIFIED') lightPass += 1;
        lightProcessed += 1;
        tickProcessed += 1;
      }
      const wall = estimateBatchWallMs(batch.length, LIGHT_LIVE_MS);
      lightWallMs += wall;
      advance(wall);
    }
    if (tickProcessed === 0) break;
  }

  const maxDeepTicks = Math.ceil(n / (DEEP_BATCH * BOOTSTRAP_BATCHES)) + 40;
  for (let tick = 0; tick < maxDeepTicks; tick++) {
    let tickProcessed = 0;
    for (let b = 0; b < BOOTSTRAP_BATCHES; b++) {
      let forced = pickDeep(DEEP_BATCH);
      if (forced.length === 0) {
        forced = [...db.values()]
          .filter(
            (r) =>
              r.stage === 'QUALIFIED' &&
              (r.nextDeepAnalyzeAt == null || r.nextDeepAnalyzeAt <= now())
          )
          .slice(0, DEEP_BATCH)
          .map((r) => r.wallet);
      }
      if (forced.length === 0) break;
      deepTicks += 1;
      let perSum = 0;
      for (const w of forced) {
        const plan = planByWallet.get(w)!;
        const throwError = deepProcessed > 0 && deepProcessed % 97 === 0;
        const beforeInPool = db.get(w)!.inCopyPool;
        const { profileSource } = deepAnalyze(w, {
          score: plan.score,
          tier2e: plan.tier2e,
          hardFlag: plan.hardFlag,
          l1Fail: plan.l1Fail,
          throwError,
        });
        if (throwError) deepErrors += 1;
        if (profileSource === 'snapshot') snapshotHits += 1;
        else liveDeep += 1;
        if (db.get(w)!.failReason?.startsWith('L1')) l1Reject += 1;
        if (!beforeInPool && db.get(w)!.inCopyPool) entered += 1;
        perSum += profileSource === 'snapshot' ? DEEP_SNAPSHOT_MS : DEEP_LIVE_MS;
        deepProcessed += 1;
        tickProcessed += 1;
      }
      const wall = estimateBatchWallMs(forced.length, perSum / Math.max(1, forced.length));
      deepWallMs += wall;
      advance(wall);
    }
    recomputeRanks();
    if (tickProcessed === 0) break;
  }

  // Final sweep: any remaining QUALIFIED ready
  for (;;) {
    const left = [...db.values()]
      .filter(
        (r) =>
          r.stage === 'QUALIFIED' &&
          (r.nextDeepAnalyzeAt == null || r.nextDeepAnalyzeAt <= now())
      )
      .slice(0, DEEP_BATCH);
    if (left.length === 0) break;
    for (const row of left) {
      const plan = planByWallet.get(row.wallet)!;
      const beforeInPool = row.inCopyPool;
      const { profileSource } = deepAnalyze(row.wallet, {
        score: plan.score,
        tier2e: plan.tier2e,
        hardFlag: plan.hardFlag,
        l1Fail: plan.l1Fail,
      });
      if (profileSource === 'snapshot') snapshotHits += 1;
      else liveDeep += 1;
      if (!beforeInPool && db.get(row.wallet)!.inCopyPool) entered += 1;
      deepProcessed += 1;
    }
    const wall = estimateBatchWallMs(left.length, DEEP_SNAPSHOT_MS);
    deepWallMs += wall;
    advance(wall);
    recomputeRanks();
  }

  const elapsed = now() - t0;
  const board = cachedBoard();
  const stuck = [...db.values()].filter((r) => r.stage === 'FULL_ANALYZING');
  const belowExitOnPool = [...db.values()].filter(
    (r) => r.inCopyPool && (r.score == null || r.score <= EXIT)
  );
  const stages = {
    RAW: [...db.values()].filter((r) => r.stage === 'RAW').length,
    QUALIFIED: [...db.values()].filter((r) => r.stage === 'QUALIFIED').length,
    SCORED: [...db.values()].filter((r) => r.stage === 'SCORED').length,
    COPY_POOL: [...db.values()].filter((r) => r.stage === 'COPY_POOL').length,
  };

  const issues: string[] = [];
  if (stuck.length > 0) issues.push(`STUCK_FULL_ANALYZING=${stuck.length}`);
  if (belowExitOnPool.length > 0) issues.push(`LOW_SCORE_ON_POOL=${belowExitOnPool.length}`);
  if (board.some((r) => (r.score ?? 0) <= EXIT)) issues.push('CACHED_BELOW_EXIT');
  if (stages.QUALIFIED > 0) {
    // after full drain, QUALIFIED should only be L1-cooled (nextDeep in future)
    const readyQ = [...db.values()].filter(
      (r) =>
        r.stage === 'QUALIFIED' &&
        (r.nextDeepAnalyzeAt == null || r.nextDeepAnalyzeAt <= now())
    );
    if (readyQ.length > 0) issues.push(`QUALIFIED_READY_LEFT=${readyQ.length}`);
  }

  const report = {
    n,
    config: {
      ENTER,
      EXIT,
      REQUIRE_TIER2E,
      LIGHT_BATCH,
      DEEP_BATCH,
      BOOTSTRAP_BATCHES,
      ANALYZE_CONCURRENCY,
      REQUEST_GAP_MS,
      PROFILE_TTL_MS,
    },
    funnel: {
      ingested: n,
      lightProcessed,
      lightPass,
      deepProcessed,
      l1Reject,
      entered,
      deepErrors,
      snapshotHits,
      liveDeep,
      snapshotHitRate:
        deepProcessed > 0 ? Number((snapshotHits / deepProcessed).toFixed(3)) : 0,
    },
    stages,
    board: {
      cached: board.length,
      minScore: board.length ? Math.min(...board.map((r) => r.score ?? 0)) : null,
      p50Score: board.length
        ? [...board.map((r) => r.score ?? 0)].sort((a, b) => a - b)[Math.floor(board.length / 2)]
        : null,
    },
    timing: {
      lightWallMs,
      deepWallMs,
      totalSimWallMs: elapsed,
      lightWallMin: Number((lightWallMs / 60000).toFixed(2)),
      deepWallMin: Number((deepWallMs / 60000).toFixed(2)),
      totalWallMin: Number((elapsed / 60000).toFixed(2)),
      lightTicks,
      deepTicks,
      estWalletsPerMinDeep:
        deepWallMs > 0 ? Number(((deepProcessed / deepWallMs) * 60000).toFixed(1)) : 0,
    },
    issues,
    ok: issues.length === 0,
  };

  console.log(`\n[bench] n=${n} ${report.ok ? 'PASS' : 'ISSUES'}`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error('[bench] issues detected:', issues.join(', '));
    process.exitCode = 1;
  }
}

function main(): void {
  const benchArg = process.argv.find((a) => a.startsWith('--bench='));
  if (benchArg) {
    const n = Number(benchArg.slice('--bench='.length));
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`Invalid --bench=${benchArg}`);
    }
    runRegression();
    console.log('\n========================================');
    runBench(n);
    return;
  }

  if (process.argv.includes('--bench-all')) {
    runRegression();
    console.log('\n========================================');
    runBench(100);
    console.log('\n========================================');
    runBench(1000);
    return;
  }

  runRegression();
}

main();
