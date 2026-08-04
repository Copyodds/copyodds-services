/**
 * 排行榜入榜链路逐步模拟（无 DB）。
 * 复用真实纯函数：allocateSmartMoneyDeepSlots / resolveCopyPoolMetricScore / inferPipelineBottleneck
 * 覆盖 F1 游标 wrap、F2 榜源选取、F5 Deep 冷却/槽位上限与 SCORED_RECHECK。
 *
 * 跑：npx tsx src/services/smartMoney/smartMoneyPipelineStallSimulation.test.ts
 */
import assert from 'node:assert/strict';
import { allocateSmartMoneyDeepSlots } from './smartMoneyDeepSlotAllocation.js';
import { resolveCopyPoolMetricScore } from './smartMoneyPoolScore.js';
import { inferPipelineBottleneck } from './smartMoneyBatchObservability.js';
import { CONFIG } from '../../config/env.js';

type Stage =
  | 'RAW'
  | 'QUALIFIED'
  | 'SCORED'
  | 'COPY_POOL'
  | 'ELIMINATED'
  | 'WAITING_GATE';

type SimWallet = {
  id: string;
  stage: Stage;
  /** 展示/缓存 v4 分 */
  score: number;
  /** Deep 现场 TraderScore；null=未算 */
  traderScore: number | null;
  gateReady: boolean;
  nextDeepAt: number | null;
  lastSeenAt: number;
  lastLightQueuedAt: number | null;
  sources: string[];
  miss: number;
};

type TickReport = {
  tick: number;
  lightProcessed: number;
  lightElim: number;
  lightToQualified: number;
  gateReadyNew: number;
  deepPicked: { refresh: number; qualified: number; scored: number };
  deepFilteredOutNoGate: number;
  deepEntered: number;
  deepScoreBelow: number;
  deepScoredLocked: number;
  copyPoolSize: number;
  scoredDue: number;
  qualifiedDueReady: number;
  bottleneck: string | null;
};

const ENTER = CONFIG.smartMoneyCopyPoolEnterScore;
const EXIT = CONFIG.smartMoneyCopyPoolExitScore;
const TIER1_RETRY = CONFIG.smartMoneyTier1RetryMs;
const SCORED_RECHECK = CONFIG.smartMoneyScoredRecheckMs;
const BG_RESCORE = CONFIG.smartMoneyCopyPoolBgRescoreMs;
const MAX_MISS = CONFIG.smartMoneyScoredMaxMiss;
const BATCH = 12;
const REFRESH_SHARE = CONFIG.smartMoneyCopyPoolRefreshBatchShare;
const MIN_Q_SHARE = CONFIG.smartMoneyDeepMinQualifiedBatchShare;
const SCORED_RESERVED = CONFIG.smartMoneyScoredBatchReservedSlots;
const NOW0 = 1_700_000_000_000;

function log(step: string, detail: Record<string, unknown>) {
  console.log(`\n=== ${step} ===`);
  console.log(JSON.stringify(detail, null, 2));
}

/** F1：空切回绕到 0，禁止 offset+step 空推进 */
function simulateDiscoveryCursorEmptyAdvance(opts: {
  boardMaxRank: number;
  startCursor: number;
  step: number;
  ticks: number;
}): { finalCursor: number; emptyTicks: number; walletsFetched: number; wraps: number } {
  let cursor = opts.startCursor;
  let emptyTicks = 0;
  let walletsFetched = 0;
  let wraps = 0;
  for (let i = 0; i < opts.ticks; i++) {
    const from = cursor;
    const hit =
      from < opts.boardMaxRank
        ? Math.min(opts.step, Math.max(0, opts.boardMaxRank - from))
        : 0;
    walletsFetched += hit;
    if (hit === 0) {
      emptyTicks += 1;
      if (from > 0) wraps += 1;
      cursor = 0;
    } else {
      cursor = from + hit;
    }
  }
  return { finalCursor: cursor, emptyTicks, walletsFetched, wraps };
}

/** F2：榜源按源选取，不先按 lastSeen 小窗 */
function pickBoardPriorityLightSim(
  wallets: SimWallet[],
  boardLimit: number,
  now: number
): SimWallet[] {
  return wallets
    .filter(
      (w) =>
        w.stage === 'RAW' &&
        (w.nextDeepAt == null || w.nextDeepAt <= now) &&
        w.sources.some((s) => s.toUpperCase().includes('LEADERBOARD'))
    )
    .sort((a, b) => {
      const aq = a.lastLightQueuedAt ?? -1;
      const bq = b.lastLightQueuedAt ?? -1;
      if (aq !== bq) return aq - bq;
      return b.lastSeenAt - a.lastSeenAt;
    })
    .slice(0, boardLimit);
}

/** 旧 bug：先 lastSeen 小窗再滤榜源 */
function pickBoardViaLastSeenWindow(
  wallets: SimWallet[],
  boardLimit: number,
  windowMul = 30
): SimWallet[] {
  const window = wallets
    .filter((w) => w.stage === 'RAW')
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, boardLimit * windowMul);
  return window
    .filter((w) => w.sources.some((s) => s.toUpperCase().includes('LEADERBOARD')))
    .slice(0, boardLimit);
}

/** 与 filterDeepBatchByClosedReady 一致：COPY_POOL/SCORED 放行；QUALIFIED 必须 gateReady */
function filterDeepByGateReady(
  picked: SimWallet[],
  requireGate: boolean
): { pass: SimWallet[]; dropped: SimWallet[] } {
  if (!requireGate) return { pass: picked, dropped: [] };
  const pass: SimWallet[] = [];
  const dropped: SimWallet[] = [];
  for (const w of picked) {
    if (w.stage === 'COPY_POOL' || w.stage === 'SCORED') pass.push(w);
    else if (w.gateReady) pass.push(w);
    else dropped.push(w);
  }
  return { pass, dropped };
}

function canEnterPool(w: SimWallet): boolean {
  const pool = resolveCopyPoolMetricScore({
    traderScore: w.traderScore,
    score: w.score,
  });
  return pool >= ENTER;
}

function pickLightStarved(wallets: SimWallet[], limit: number, now: number, starvationMs: number): SimWallet[] {
  const since = now - starvationMs;
  return wallets
    .filter(
      (w) =>
        w.stage === 'RAW' &&
        (w.lastLightQueuedAt == null || w.lastLightQueuedAt < since)
    )
    .sort((a, b) => {
      const aq = a.lastLightQueuedAt ?? -1;
      const bq = b.lastLightQueuedAt ?? -1;
      if (aq !== bq) return aq - bq;
      return b.lastSeenAt - a.lastSeenAt; // 与源码 orderBy lastSeenAt desc 一致
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// STEP 1: 游标空切回绕（F1）
// ---------------------------------------------------------------------------
{
  const r = simulateDiscoveryCursorEmptyAdvance({
    boardMaxRank: 500,
    startCursor: 480,
    step: 50,
    ticks: 20,
  });
  log('STEP1 discovery empty wrap (F1)', {
    boardMaxRank: 500,
    after20Ticks: r,
    claim: '空切回绕 cursor=0，不再冲飞到榜外',
  });
  assert.ok(r.finalCursor <= 500, 'cursor 不得冲飞出榜尾');
  assert.ok(r.wraps >= 1);
  assert.ok(r.walletsFetched > 0);
}

// ---------------------------------------------------------------------------
// STEP 1b: Light 榜源选取 — block 刷 lastSeen 时 board 仍可捞到（F2）
// ---------------------------------------------------------------------------
{
  const now = NOW0;
  const wallets: SimWallet[] = [];
  for (let i = 0; i < 450; i++) {
    wallets.push({
      id: `block_${i}`,
      stage: 'RAW',
      score: 0,
      traderScore: null,
      gateReady: false,
      nextDeepAt: null,
      lastSeenAt: now - i,
      lastLightQueuedAt: null,
      sources: ['BLOCK_SCAN'],
      miss: 0,
    });
  }
  for (let i = 0; i < 30; i++) {
    wallets.push({
      id: `board_${i}`,
      stage: 'RAW',
      score: 0,
      traderScore: null,
      gateReady: false,
      nextDeepAt: null,
      lastSeenAt: now - 1_000_000 - i,
      lastLightQueuedAt: null,
      sources: ['LEADERBOARD_OFFICIAL'],
      miss: 0,
    });
  }
  const viaWindow = pickBoardViaLastSeenWindow(wallets, 15);
  const viaSource = pickBoardPriorityLightSim(wallets, 15, now);
  log('STEP1b board pick under block lastSeen flood', {
    viaLastSeenWindow: viaWindow.length,
    viaSourceFilter: viaSource.length,
  });
  assert.equal(viaWindow.length, 0, '旧 lastSeen 小窗会饿死榜源');
  assert.equal(viaSource.length, 15, 'F2 按源查询仍能捞到榜源');
}

// ---------------------------------------------------------------------------
// STEP 2: 入池双轨 — score≥ENTER 但 traderScore 低 → SCORE_BELOW
// ---------------------------------------------------------------------------
{
  const score = 55.6;
  const traderScore = 38;
  const poolPrimary = resolveCopyPoolMetricScore({ traderScore, score });
  const poolFallback = (() => {
    // 模拟关闭 TRADER_SCORE_AS_PRIMARY 时（直接用 score）
    return score;
  })();
  log('STEP2 enter metric split', {
    traderScoreAsPrimary: CONFIG.smartMoneyTraderScoreAsPrimary,
    enterLine: ENTER,
    exitLine: EXIT,
    score,
    traderScore,
    poolScoreUsed: poolPrimary,
    wouldEnterWithTsPrimary: poolPrimary >= ENTER,
    wouldEnterWithV4Only: poolFallback >= ENTER,
  });
  assert.equal(CONFIG.smartMoneyTraderScoreAsPrimary, true);
  assert.ok(poolPrimary < ENTER, 'TS primary must block this candidate');
  assert.ok(poolFallback >= ENTER, 'v4 alone would enter');
}

// ---------------------------------------------------------------------------
// STEP 3: Deep 槽位 — QUALIFIED=0 + SCORED 全冷却 → 100% 复评
// ---------------------------------------------------------------------------
{
  const slots = allocateSmartMoneyDeepSlots({
    limit: BATCH,
    qualifiedDue: 0,
    scoredDue: 0,
    scoredReservedSlots: SCORED_RESERVED,
    minQualifiedShare: MIN_Q_SHARE,
    refreshShare: REFRESH_SHARE,
  });
  log('STEP3 deep slots when no new candidates due', {
    config: { BATCH, REFRESH_SHARE, MIN_Q_SHARE, SCORED_RESERVED },
    slots,
    claim: 'F5：QUALIFIED/SCORED 都不可用时，refresh 仍受 share 上限，不得吞满整批',
  });
  assert.equal(slots.qualifiedSlots, 0);
  assert.equal(slots.scoredSlots, 0);
  assert.equal(slots.refreshSlots, Math.floor(BATCH * REFRESH_SHARE));
  assert.ok(slots.refreshSlots < BATCH);
}

// ---------------------------------------------------------------------------
// STEP 4: Gate 过滤 — QUALIFIED 无 READY 被踢出；Deep 仍忙着跑 COPY_POOL
// ---------------------------------------------------------------------------
{
  const now = NOW0;
  const picked: SimWallet[] = [
    {
      id: 'q1',
      stage: 'QUALIFIED',
      score: 60,
      traderScore: null,
      gateReady: false,
      nextDeepAt: null,
      lastSeenAt: now,
      lastLightQueuedAt: now,
      sources: ['LEADERBOARD'],
      miss: 0,
    },
    {
      id: 'q2',
      stage: 'QUALIFIED',
      score: 62,
      traderScore: null,
      gateReady: false,
      nextDeepAt: null,
      lastSeenAt: now,
      lastLightQueuedAt: now,
      sources: ['LEADERBOARD'],
      miss: 0,
    },
    {
      id: 'c1',
      stage: 'COPY_POOL',
      score: 70,
      traderScore: 65,
      gateReady: true,
      nextDeepAt: null,
      lastSeenAt: now,
      lastLightQueuedAt: now,
      sources: ['LEADERBOARD'],
      miss: 0,
    },
  ];
  const { pass, dropped } = filterDeepByGateReady(picked, true);
  const bottleneckGate = inferPipelineBottleneck({
    stage: 'deep',
    backlogBefore: { qualifiedGateReady: 0, qualifiedGateMissing: 80, scoredAwaitingEntry: 150 },
    consumed: 3,
  });
  // Gate 已就绪但 SCORED 堆积时，诊断标 scored_entry_lag（生产常见另一面）
  const bottleneckScored = inferPipelineBottleneck({
    stage: 'deep',
    backlogBefore: { qualifiedGateReady: 20, qualifiedGateMissing: 5, scoredAwaitingEntry: 150 },
    consumed: 3,
  });
  log('STEP4 gate filter + bottleneck label', {
    picked: picked.map((w) => w.id + ':' + w.stage),
    pass: pass.map((w) => w.id),
    dropped: dropped.map((w) => w.id),
    bottleneckGate,
    bottleneckScored,
    claim:
      'DeepRequireClosedSnapshot=true 时无 Gate 的 QUALIFIED 被踢出；诊断会报 deep_waiting_gate / scored_entry_lag，但 Deep 仍在复评 COPY_POOL',
  });
  assert.equal(pass.length, 1);
  assert.equal(pass[0]!.id, 'c1');
  assert.equal(dropped.length, 2);
  assert.equal(bottleneckGate.bottleneck, 'deep_waiting_gate');
  assert.equal(bottleneckScored.bottleneck, 'scored_entry_lag');
}

// ---------------------------------------------------------------------------
// STEP 5: 多 tick — TS 主分仍拦入榜；F5 后复评不再永到期
// ---------------------------------------------------------------------------
{
  const now = { t: NOW0 };
  const wallets: SimWallet[] = [];

  // 既有 CopyPool 老人 40 个
  for (let i = 0; i < 40; i++) {
    wallets.push({
      id: `old_${i}`,
      stage: 'COPY_POOL',
      score: 70,
      traderScore: 68,
      gateReady: true,
      nextDeepAt: null,
      lastSeenAt: NOW0 - i * 1000,
      lastLightQueuedAt: NOW0,
      sources: ['LEADERBOARD'],
      miss: 0,
    });
  }

  // 150 个 SCORED：v4 够线，TS 不够；卡在 SCORED_RECHECK 冷却内
  for (let i = 0; i < 150; i++) {
    wallets.push({
      id: `scored_${i}`,
      stage: 'SCORED',
      score: 55 + (i % 10) * 0.5,
      traderScore: 35 + (i % 8),
      gateReady: true,
      nextDeepAt: NOW0 + SCORED_RECHECK - 60_000,
      lastSeenAt: NOW0,
      lastLightQueuedAt: NOW0,
      sources: ['LEADERBOARD'],
      miss: 1,
    });
  }

  // 80 个 QUALIFIED：无 Gate READY（prefetch 滞后）
  for (let i = 0; i < 80; i++) {
    wallets.push({
      id: `qual_${i}`,
      stage: 'QUALIFIED',
      score: 58,
      traderScore: null,
      gateReady: false,
      nextDeepAt: null,
      lastSeenAt: NOW0,
      lastLightQueuedAt: NOW0,
      sources: ['BLOCK_SCAN'],
      miss: 0,
    });
  }

  // RAW：200 新地址（多数会被 Light 杀）+ 少量好地址；队头 lastSeen 很新
  for (let i = 0; i < 180; i++) {
    wallets.push({
      id: `junk_${i}`,
      stage: 'RAW',
      score: 0,
      traderScore: null,
      gateReady: false,
      nextDeepAt: null,
      lastSeenAt: NOW0 + i, // 越新越靠前
      lastLightQueuedAt: null,
      sources: ['BLOCK_SCAN'],
      miss: 0,
    });
  }
  for (let i = 0; i < 20; i++) {
    wallets.push({
      id: `good_raw_${i}`,
      stage: 'RAW',
      score: 0,
      traderScore: null,
      gateReady: false,
      nextDeepAt: null,
      lastSeenAt: NOW0 - 86_400_000 - i, // 最老，队尾
      lastLightQueuedAt: null,
      sources: ['LEADERBOARD'],
      miss: 0,
    });
  }

  const reports: TickReport[] = [];
  let totalEntered = 0;

  for (let tick = 1; tick <= 30; tick++) {
    now.t += 60_000; // 每 tick 1 分钟
    const report: TickReport = {
      tick,
      lightProcessed: 0,
      lightElim: 0,
      lightToQualified: 0,
      gateReadyNew: 0,
      deepPicked: { refresh: 0, qualified: 0, scored: 0 },
      deepFilteredOutNoGate: 0,
      deepEntered: 0,
      deepScoreBelow: 0,
      deepScoredLocked: 0,
      copyPoolSize: 0,
      scoredDue: 0,
      qualifiedDueReady: 0,
      bottleneck: null,
    };

    // --- Light：每批 20，优先 starved（null lastLight），但同组按 lastSeenAt desc ---
    const lightBatch = pickLightStarved(wallets, 20, now.t, 6 * 60 * 60 * 1000);
    for (const w of lightBatch) {
      report.lightProcessed += 1;
      w.lastLightQueuedAt = now.t;
      if (w.id.startsWith('junk_')) {
        w.stage = 'ELIMINATED';
        report.lightElim += 1;
      } else if (w.id.startsWith('good_raw_')) {
        w.stage = 'QUALIFIED';
        w.gateReady = false; // 需等 Gate
        w.score = 60;
        report.lightToQualified += 1;
      }
    }

    // --- Gate prefetch：每 tick 只就绪 2 个（模拟慢/让路）---
    const needGate = wallets.filter((w) => w.stage === 'QUALIFIED' && !w.gateReady);
    for (const w of needGate.slice(0, 2)) {
      w.gateReady = true;
      report.gateReadyNew += 1;
    }

    // --- Deep pick（镜像 allocateSmartMoneyDeepSlots + filter）---
    const qualifiedDueReady = wallets.filter(
      (w) => w.stage === 'QUALIFIED' && w.gateReady && (w.nextDeepAt == null || w.nextDeepAt <= now.t)
    ).length;
    const scoredDue = wallets.filter(
      (w) => w.stage === 'SCORED' && (w.nextDeepAt == null || w.nextDeepAt <= now.t)
    ).length;
    report.qualifiedDueReady = qualifiedDueReady;
    report.scoredDue = scoredDue;
    report.deepScoredLocked = wallets.filter((w) => w.stage === 'SCORED').length - scoredDue;

    let refreshShare = REFRESH_SHARE;
    // dual_channel TopN 欠债抬升（常见生产态）
    if (tick % 3 === 0) refreshShare = Math.max(refreshShare, CONFIG.smartMoneyCopyPoolPriorityRefreshShare);

    const slots = allocateSmartMoneyDeepSlots({
      limit: BATCH,
      qualifiedDue: qualifiedDueReady,
      scoredDue,
      scoredReservedSlots: SCORED_RESERVED,
      minQualifiedShare: MIN_Q_SHARE,
      refreshShare,
    });

    // 实际挑人（简化：按 stage 取前 N）
    const refreshPool = wallets
      .filter((w) => w.stage === 'COPY_POOL' && (w.nextDeepAt == null || w.nextDeepAt <= now.t))
      .slice(0, slots.refreshSlots);
    const qualPool = wallets
      .filter((w) => w.stage === 'QUALIFIED' && w.gateReady && (w.nextDeepAt == null || w.nextDeepAt <= now.t))
      .slice(0, slots.qualifiedSlots);
    const scoredPool = wallets
      .filter((w) => w.stage === 'SCORED' && (w.nextDeepAt == null || w.nextDeepAt <= now.t))
      .slice(0, slots.scoredSlots);

    report.deepPicked = {
      refresh: refreshPool.length,
      qualified: qualPool.length,
      scored: scoredPool.length,
    };

    // 若误把无 gate 的 QUALIFIED 选入（调度侧按 due 数，过滤侧再踢）
    const phantomQual = wallets
      .filter((w) => w.stage === 'QUALIFIED' && !w.gateReady)
      .slice(0, Math.max(0, slots.qualifiedSlots - qualPool.length));
    const { dropped } = filterDeepByGateReady([...qualPool, ...phantomQual], true);
    report.deepFilteredOutNoGate = dropped.length;

    const deepWork = [...refreshPool, ...qualPool, ...scoredPool];
    for (const w of deepWork) {
      if (w.stage === 'COPY_POOL') {
        // F5 dual_channel：成功后非零冷却（background）
        w.nextDeepAt = now.t + BG_RESCORE;
        continue;
      }
      // 新人：赋 TS（与现场观测类似：低于 v4）
      if (w.traderScore == null) w.traderScore = 38;
      if (canEnterPool(w)) {
        w.stage = 'COPY_POOL';
        w.miss = 0;
        w.nextDeepAt = now.t + BG_RESCORE;
        report.deepEntered += 1;
        totalEntered += 1;
      } else {
        report.deepScoreBelow += 1;
        w.stage = 'SCORED';
        w.miss += 1;
        if (w.miss > MAX_MISS) {
          w.stage = 'ELIMINATED';
        } else {
          // F5：SCORE_BELOW → SCORED_RECHECK_MS（默认 6h）
          w.nextDeepAt = now.t + SCORED_RECHECK;
        }
      }
    }

    report.copyPoolSize = wallets.filter((w) => w.stage === 'COPY_POOL').length;
    report.bottleneck = inferPipelineBottleneck({
      stage: 'deep',
      backlogBefore: {
        qualifiedGateReady: qualifiedDueReady,
        qualifiedGateMissing: needGate.length,
        scoredAwaitingEntry: wallets.filter((w) => w.stage === 'SCORED').length,
        deepExecutable: deepWork.length,
      },
      consumed: report.deepEntered,
    }).bottleneck;

    reports.push(report);
  }

  const first = reports[0]!;
  const mid = reports[14]!;
  const last = reports[29]!;
  const neverLightGood = wallets.filter(
    (w) => w.id.startsWith('good_raw_') && w.lastLightQueuedAt == null
  ).length;
  const lightHitsOnJunkFirst10 = reports.slice(0, 10).reduce((s, r) => s + r.lightElim, 0);
  const lightHitsOnGoodFirst10 = reports.slice(0, 10).reduce((s, r) => s + r.lightToQualified, 0);

  log('STEP5 multi-tick funnel summary', {
    configDefaults: {
      enter: ENTER,
      traderScoreAsPrimary: CONFIG.smartMoneyTraderScoreAsPrimary,
      scoredRecheckMs: SCORED_RECHECK,
      bgRescoreMs: BG_RESCORE,
      tier1RetryMs: TIER1_RETRY,
      deepRequireClosedSnapshot: CONFIG.smartMoneyDeepRequireClosedSnapshot,
      refreshShare: REFRESH_SHARE,
      priorityRefreshShare: CONFIG.smartMoneyCopyPoolPriorityRefreshShare,
    },
    tick1: first,
    tick15: mid,
    tick30: last,
    totalEnteredIn30Ticks: totalEntered,
    neverLightGoodRemaining: neverLightGood,
    first10Light: { junkElim: lightHitsOnJunkFirst10, goodPromoted: lightHitsOnGoodFirst10 },
    claim:
      'TS primary 仍拦低分入榜；F5 后 CopyPool 复评带冷却，refresh 不再永占满槽',
  });

  assert.ok(totalEntered === 0, `expected 0 enters, got ${totalEntered}`);
  assert.ok(last.scoredDue === 0, 'SCORED 在 6h recheck 窗内仍锁');
  assert.ok(
    last.deepPicked.refresh <= Math.floor(BATCH * REFRESH_SHARE),
    'F5: refresh 受 share 上限'
  );
  assert.ok(
    mid.deepPicked.refresh === 0 || last.deepPicked.refresh === 0,
    'F5: dual_channel 冷却后 copy_rescore_due 应下降'
  );
  assert.ok(last.deepEntered === 0 && mid.deepEntered === 0);
  assert.ok(last.deepScoreBelow > 0 || mid.deepScoreBelow > 0, 'QUALIFIED drip fails SCORE_BELOW');
  assert.ok(lightHitsOnJunkFirst10 > lightHitsOnGoodFirst10, 'Light prefers fresh junk over old good');
  assert.ok(last.deepScoredLocked > 150, 'failed enters pile into locked SCORED');
}

// ---------------------------------------------------------------------------
// STEP 6: 对照 — 只改代码级三处，入榜恢复（证明因果）
// ---------------------------------------------------------------------------
{
  const now = { t: NOW0 };
  let entered = 0;
  const scored: SimWallet[] = [];
  for (let i = 0; i < 40; i++) {
    scored.push({
      id: `fix_${i}`,
      stage: 'SCORED',
      score: 56,
      traderScore: 38, // TS 仍低
      gateReady: true,
      nextDeepAt: null, // 短冷却 / 到期
      lastSeenAt: NOW0,
      lastLightQueuedAt: NOW0,
      sources: ['LEADERBOARD'],
      miss: 0,
    });
  }
  // 修复 A：入池用 v4 score（等价关闭 TS primary）
  // 修复 B：SCORED 到期可进 Deep（不绑 2 天 TIER1）
  // 修复 C：Deep 配额优先 SCORED（refreshShare=0 模拟）
  for (let tick = 0; tick < 5; tick++) {
    now.t += 60_000;
    const slots = allocateSmartMoneyDeepSlots({
      limit: BATCH,
      qualifiedDue: 0,
      scoredDue: scored.filter((w) => w.stage === 'SCORED').length,
      scoredReservedSlots: SCORED_RESERVED,
      minQualifiedShare: MIN_Q_SHARE,
      refreshShare: 0,
    });
    const batch = scored.filter((w) => w.stage === 'SCORED').slice(0, slots.scoredSlots);
    for (const w of batch) {
      const pool = w.score; // 用 v4
      if (pool >= ENTER) {
        w.stage = 'COPY_POOL';
        entered += 1;
      }
    }
  }
  log('STEP6 counterfactual: fix metric+cooldown+slots', {
    enteredIn5Ticks: entered,
    claim: '同一批人，只改三处语义即可恢复入榜 → 罢工来自这三处耦合，不是“没人干活”',
  });
  assert.ok(entered >= 40);
}

console.log('\nsmartMoneyPipelineStallSimulation.test.ts: ALL STEPS OK');
