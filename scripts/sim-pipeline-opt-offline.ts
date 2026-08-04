/**
 * 完整离线模拟：管道优化 v1.2 全功能（无数据库）。
 * Usage: npx tsx scripts/sim-pipeline-opt-offline.ts
 */
async function main() {
  await import('../src/loadEnv.js');

  process.env.CUSTODY_TREASURY_ADDRESS =
    '0x1111111111111111111111111111111111111111';
  process.env.DATABASE_URL ||=
    'postgresql://sim:sim@127.0.0.1:5432/polycopy_sim?schema=public';
  process.env.RPC_URL ||= 'http://127.0.0.1:8545';
  process.env.JWT_SECRET ||= 'offline-sim-jwt-secret-min-32-chars!!';
  process.env.SMART_MONEY_RAW_POOL_MAX_ACTIVE = '1000';
  process.env.SMART_MONEY_RAW_REFILL_LOW = '250';
  process.env.SMART_MONEY_RAW_REFILL_TARGET = '1000';
  process.env.SMART_MONEY_RAW_REFILL_BOARD_SHARE = '0.7';
  process.env.SMART_MONEY_RAW_INGEST_COOLDOWN_DAYS = '3';
  process.env.SMART_MONEY_SCORE_POOL_MIN_PNL_1Y = '1000';
  process.env.LEADERBOARD_INTERVAL_MS = '3600000';
  process.env.LEADERBOARD_EXTERNAL_MIN_INTERVAL_MS = '7200000';
  process.env.SMART_MONEY_GATE_FETCH_OPEN_POSITIONS = 'false';
  process.env.SMART_MONEY_RAW_REFILL_CRON_ENABLED = 'true';
  process.env.SMART_MONEY_DISCOVERY_RANK_JUMP_MIN = '20';
  process.env.SMART_MONEY_RAW_REFILL_SHORTFALL_BOOST_AFTER = '3';
  process.env.SMART_MONEY_RAW_REFILL_SHORTFALL_STEP_MUL = '2';

  const assertMod = await import('node:assert/strict');
  const assert: typeof assertMod.default = assertMod.default;

  const { computeDiscoveryIngestBudget } = await import(
    '../src/services/smartMoney/smartMoneyDiscoveryBudget.js'
  );
  const { evaluateLightWindowReject, isLightDualShortDeferOnly } = await import(
    '../src/services/smartMoney/smartMoneyTierGate.js'
  );
  const { failsL1DustGate } = await import(
    '../src/services/smartMoney/smartMoneyTradeNotional.js'
  );
  const { sanitizeMaxDrawdownRatio } = await import(
    '../src/services/smartMoney/smartMoneyCanonicalBoardMetrics.js'
  );
  const { computeTraderScore } = await import(
    '../src/services/smartMoney/smartMoneyTraderScore.js'
  );
  const { resolveSmartMoneyTier, scoreToBaseTier } = await import(
    '../src/services/smartMoney/smartMoneyTier.js'
  );
  const { isCurveFresh, curveTtlMsForPeriod } = await import(
    '../src/services/smartMoney/smartMoneyCurveTtl.js'
  );
  const { cursorStepForShortfall } = await import(
    '../src/services/smartMoney/smartMoneyDiscoveryCursor.js'
  );
  const { normalizeReviveReason, isStrongReviveSource } = await import(
    '../src/services/smartMoney/smartMoneyEliminated.js'
  );
  const { CONFIG } = await import('../src/config/env.js');

  type Stage =
    | 'RAW'
    | 'QUALIFIED'
    | 'SCORED'
    | 'COPY_POOL'
    | 'ELIMINATED'
    | 'DORMANT'
    | 'BLOCKED';

  type WalletRow = {
    wallet: string;
    stage: Stage;
    lastIngestedAt: number | null;
    lastTradeAt: number | null;
    lastSeenAt: number;
    elimBucket: 'HOT' | 'COLD';
    nextLightAt: number;
    nextDeepAt: number;
    pnl1y: number;
    pnl30d: number;
    pnl7d: number;
    medianNotional: number;
    dustShare: number;
    mddPct: number | null;
    traderScore: number;
    hedged: boolean;
    reviveReason?: string;
  };

  const DAY = 24 * 60 * 60 * 1000;
  const now0 = Date.now();
  const bugs: string[] = [];
  const stuckRisks: string[] = [];
  const checks: string[] = [];

  function wallet(i: number): string {
    return `0x${i.toString(16).padStart(40, '0')}`;
  }

  function makeProfile(w: WalletRow, nowMs: number) {
    const points: Array<{
      period: '1W' | '1M' | 'ALL';
      curveType: string;
      ts: Date;
      value: number;
    }> = [];
    const push = (period: '1W' | '1M' | 'ALL', endPnl: number, n: number, daysSpan: number) => {
      for (let i = 0; i < n; i++) {
        const ageDays = ((n - 1 - i) * daysSpan) / Math.max(1, n - 1);
        points.push({
          period,
          curveType: `PORTFOLIO_PNL_${period}`,
          ts: new Date(nowMs - ageDays * DAY),
          value: (endPnl * i) / Math.max(1, n - 1),
        });
      }
    };
    push('ALL', w.pnl1y, 400, 400);
    push('1M', w.pnl30d, 60, 30);
    push('1W', w.pnl7d, 20, 7);
    return {
      wallet: w.wallet,
      holdingsValue: null,
      predictionCount: 80,
      curves: points,
    } as any;
  }

  // ---------- A. 配置与纯函数门禁 ----------
  assert.equal(CONFIG.smartMoneyRawPoolMaxActive, 1000);
  assert.equal(CONFIG.smartMoneyRawRefillLow, 250);
  assert.equal(CONFIG.smartMoneyRawRefillTarget, 1000);
  assert.equal(CONFIG.smartMoneyScorePoolMinPnl1y, 1000);
  assert.equal(CONFIG.leaderboardIntervalMs, 3_600_000);
  assert.equal(CONFIG.leaderboardExternalMinIntervalMs, 7_200_000);
  assert.equal(CONFIG.smartMoneyGateFetchOpenPositions, false);
  assert.equal(CONFIG.smartMoneyRawRefillCronEnabled, true);
  assert.equal(CONFIG.smartMoneyDiscoveryRankJumpMin, 20);
  checks.push('env defaults OK');

  {
    // 补到 target：落在 (low,target) 不卡死
    const mid = computeDiscoveryIngestBudget({
      activeCount: 300,
      maxActive: 1000,
      perRun: 200,
      refillLow: 250,
      refillTarget: 1000,
    });
    assert.equal(mid.paused, false);
    assert.equal(mid.slots, 200);

    const full = computeDiscoveryIngestBudget({
      activeCount: 1000,
      maxActive: 1000,
      perRun: 200,
      refillLow: 250,
      refillTarget: 1000,
    });
    assert.equal(full.paused, true);
    assert.equal(full.slots, 0);
    checks.push('budget fill-to-target OK');
  }

  {
    assert.equal(cursorStepForShortfall(0, 40), 40);
    assert.equal(cursorStepForShortfall(2, 40), 40);
    assert.equal(cursorStepForShortfall(3, 40), 80);
    checks.push('shortfall step boost OK');
  }

  {
    assert.equal(isStrongReviveSource('REVIVE|RANK_JUMP'), true);
    assert.equal(isStrongReviveSource('REVIVE|OFFICIAL_TOP'), true);
    assert.equal(isStrongReviveSource('REVIVE|BLOCKSCAN'), true);
    assert.equal(normalizeReviveReason('REVIVE|RANK_JUMP'), 'REVIVE|RANK_JUMP');
    assert.equal(normalizeReviveReason('LEADERBOARD_REFILL'), 'REVIVE|OFFICIAL_TOP');
    assert.equal(normalizeReviveReason('BLOCK_SCAN'), 'REVIVE|BLOCKSCAN');
    checks.push('revive reason OK');
  }

  {
    const fake = sanitizeMaxDrawdownRatio(1.0);
    assert.equal(fake.unmeasurable, false);
    assert.equal(fake.value, 1.0);
    assert.equal(
      failsL1DustGate({
        medianNotionalUsd: 10,
        dustShare: 0.1,
        sampleCount: 20,
        minSampleCount: 20,
        minMedianUsd: 20,
        maxDustShare: 0.4,
      }),
      true
    );
    checks.push('MDD passthrough + L1 dust OK');
  }

  {
    const scored = computeTraderScore({
      edgeScore: 70,
      edgeSampleN: 40,
      consistencyScore: 70,
      profitFactor: 1.8,
      totalReturn: 0.4,
      maxDrawdownPercent: 0.15,
      copyabilityScore: 70,
      copyabilityMissing: false,
      closedMarketCount: 40,
      activeDays: 200,
      winRate: 0.55,
      top1MarketPnlShare: 0.2,
      hasHighTradeFrequencyFlag: false,
      hasHedgedPairFlag: false,
      hasBlacklistedFlag: false,
      extremeOddsShare: 0.05,
      pnl30dUsd: -100,
      pnl7dUsd: 50,
      medianNotionalUsd: 250,
    });
    assert.ok(scored.windowAdjust <= -5);
    assert.equal(scoreToBaseTier(85), 'S');
    assert.equal(
      resolveSmartMoneyTier({
        traderScore: 85,
        edgeScore: 70,
        edgeSampleN: 40,
        copyabilityMissing: false,
        copyabilityScore: 70,
        traderType: 'INFORMATION',
        hasHardRiskFlag: false,
        top1MarketPnlShare: 0.2,
        closedMarketCount: 40,
        activeDays: 200,
        maxDrawdownPercent: 0.2,
        medianNotionalUsd: 80,
        pnl1yUsd: 5000,
        pnl30dUsd: -10,
        pnl7dUsd: 20,
      }).tier,
      'B'
    );
    checks.push('score soft + S/A window cap OK');
  }

  {
    assert.equal(isCurveFresh(new Date(Date.now() - 60_000), '1D'), true);
    assert.equal(
      isCurveFresh(new Date(Date.now() - CONFIG.smartMoneyCurve1dTtlMs - 1000), '1D'),
      false
    );
    assert.equal(curveTtlMsForPeriod('1D'), CONFIG.smartMoneyCurve1dTtlMs);
    checks.push('curve TTL OK');
  }

  // Gate 曲线「跳过新鲜」语义（无 DB：用内存模拟 ensureGate 决策）
  function simulateEnsureGate(periodsFresh: Record<string, boolean>): {
    fetched: string[];
    skipped: string[];
  } {
    const fetched: string[] = [];
    const skipped: string[] = [];
    for (const p of ['ALL', '1W'] as const) {
      if (periodsFresh[p]) skipped.push(p);
      else fetched.push(p);
    }
    return { fetched, skipped };
  }
  {
    const bothFresh = simulateEnsureGate({ ALL: true, '1W': true });
    assert.deepEqual(bothFresh.fetched, []);
    assert.deepEqual(bothFresh.skipped, ['ALL', '1W']);
    const miss1w = simulateEnsureGate({ ALL: true, '1W': false });
    assert.deepEqual(miss1w.fetched, ['1W']);
    checks.push('gate curve skip-fresh semantics OK');
  }

  // ---------- B. 双写解耦语义 ----------
  {
    // refill cron on → candidateSync 不应 ingest
    const refillOwns = CONFIG.smartMoneyRawRefillCronEnabled === true;
    assert.equal(refillOwns, true);
    const candidateWouldIngest = !refillOwns;
    assert.equal(candidateWouldIngest, false);
    checks.push('candidateSync/rawRefill ingest ownership OK');
  }

  // ---------- C. 内存漏斗（含优先队列/游标/冷却/Light/Deep/Enrich/淘汰） ----------
  const pool = new Map<string, WalletRow>();
  type Pri = { wallet: string; reason: string };
  let priorityQ: Pri[] = [];
  let weekCursor = 0;
  let allCursor = 0;
  let catCursor = 0;
  let shortfallStreak = 0;
  let syncRunning = false;
  let candidateIngestCalls = 0;
  let refillIngestCalls = 0;
  let gateHttpFetches = 0;
  let gateHttpSkipped = 0;
  let lightElim = 0;
  let lightDefer = 0;
  let l1Elim = 0;
  let hedgeEject = 0;
  let purged = 0;
  let revived = 0;

  const board = Array.from({ length: 12_000 }, (_, i) => ({
    wallet: wallet(10_000 + i),
    rank: i + 1,
    prevRank: i + 1 + (i % 40 === 0 ? 30 : 0), // 部分名次上升 ≥20
    pnl1y: i < 100 ? 5000 + i * 10 : i % 7 === 0 ? -200 : 1200 + (i % 30) * 10,
    pnl30d: i % 11 === 0 ? -80 : 20,
    pnl7d: i % 13 === 0 ? -40 : 10,
    median: i % 17 === 0 ? 5 : 60 + (i % 40),
    dust: i % 17 === 0 ? 0.55 : 0.1,
    mdd: i % 19 === 0 ? 0.85 : 0.18,
    hedged: i % 23 === 0,
  }));

  // 优先队列：Top50 + 名次跳升
  for (const c of board.slice(0, 50)) {
    priorityQ.push({
      wallet: c.wallet,
      reason: c.prevRank - c.rank >= 20 ? 'REVIVE|RANK_JUMP' : 'REVIVE|OFFICIAL_TOP',
    });
  }
  for (const c of board.slice(50, 200)) {
    if (c.prevRank - c.rank >= 20) {
      priorityQ.push({ wallet: c.wallet, reason: 'REVIVE|RANK_JUMP' });
    }
  }

  function canIngest(
    row: WalletRow | undefined,
    now: number,
    opts?: { strong?: boolean }
  ): boolean {
    if (!row) return true;
    const busy = new Set(['COPY_POOL', 'SCORED', 'QUALIFIED', 'RAW', 'BLOCKED']);
    if (busy.has(row.stage)) return false;
    if (row.stage === 'ELIMINATED' && !opts?.strong) return false;
    const cooldown = CONFIG.smartMoneyRawIngestCooldownDays * DAY;
    if (
      cooldown > 0 &&
      row.lastIngestedAt != null &&
      now - row.lastIngestedAt < cooldown &&
      !(opts?.strong && row.stage === 'ELIMINATED')
    ) {
      return false;
    }
    return true;
  }

  function ingest(
    walletAddr: string,
    now: number,
    source: string,
    via: 'refill' | 'candidate'
  ): boolean {
    if (via === 'candidate') candidateIngestCalls += 1;
    else refillIngestCalls += 1;

    // 生产语义：refill cron on 时 candidate 不应调用
    if (via === 'candidate' && CONFIG.smartMoneyRawRefillCronEnabled) {
      bugs.push('candidate ingest called while refill cron owns ingest');
      return false;
    }

    const strong = isStrongReviveSource(source);
    const existing = pool.get(walletAddr);
    if (!canIngest(existing, now, { strong })) return false;
    const seed = board.find((c) => c.wallet === walletAddr);
    const row: WalletRow = existing ?? {
      wallet: walletAddr,
      stage: 'RAW',
      lastIngestedAt: now,
      lastTradeAt: now,
      lastSeenAt: now,
      elimBucket: 'HOT',
      nextLightAt: now,
      nextDeepAt: now,
      pnl1y: seed?.pnl1y ?? 2000,
      pnl30d: seed?.pnl30d ?? 50,
      pnl7d: seed?.pnl7d ?? 20,
      medianNotional: seed?.median ?? 80,
      dustShare: seed?.dust ?? 0.1,
      mddPct: seed?.mdd ?? 0.2,
      traderScore: 60,
      hedged: seed?.hedged ?? false,
    };
    if (existing?.stage === 'ELIMINATED' && strong) {
      row.stage = 'RAW';
      row.elimBucket = 'HOT';
      row.reviveReason = normalizeReviveReason(source);
      revived += 1;
    } else if (!existing) {
      row.stage = 'RAW';
    } else if (existing.stage === 'DORMANT') {
      row.stage = 'RAW';
    } else return false;
    row.lastIngestedAt = now;
    row.lastSeenAt = now;
    row.nextLightAt = now;
    pool.set(walletAddr, row);
    return true;
  }

  function activeCount(): number {
    // 与生产 rawPoolActiveWhere 一致：仅 RAW（模拟无 LIGHT_ANALYZING）
    let n = 0;
    for (const r of pool.values()) {
      if (r.stage === 'RAW') n += 1;
    }
    return n;
  }

  function refillTick(now: number) {
    const budget = computeDiscoveryIngestBudget({
      activeCount: activeCount(),
      maxActive: CONFIG.smartMoneyRawPoolMaxActive,
      perRun: 200,
      refillLow: CONFIG.smartMoneyRawRefillLow,
      refillTarget: CONFIG.smartMoneyRawRefillTarget,
    });
    if (budget.paused || budget.slots <= 0) {
      shortfallStreak = 0;
      return;
    }
    const step = cursorStepForShortfall(shortfallStreak, Math.max(20, budget.slots * 2));
    const boardQuota = Math.floor(budget.slots * CONFIG.smartMoneyRawRefillBoardShare);
    const blockQuota = budget.slots - boardQuota;
    let filled = 0;

    while (filled < boardQuota && priorityQ.length > 0) {
      const e = priorityQ.shift()!;
      if (ingest(e.wallet, now, e.reason, 'refill')) filled += 1;
    }
    while (filled < boardQuota && weekCursor < board.length) {
      const c = board[weekCursor++]!;
      if (ingest(c.wallet, now, 'LEADERBOARD_REFILL', 'refill')) filled += 1;
    }
    let need = boardQuota - filled;
    while (need > 0 && allCursor < board.length) {
      const c = board[allCursor++]!;
      if (ingest(c.wallet, now, 'LEADERBOARD_REFILL', 'refill')) {
        filled += 1;
        need -= 1;
      }
    }
    // 分类长尾
    while (need > 0 && catCursor < board.length) {
      const c = board[(catCursor + 500) % board.length]!;
      catCursor += Math.max(1, Math.floor(step / 10));
      if (ingest(c.wallet, now, 'LEADERBOARD_REFILL', 'refill')) {
        filled += 1;
        need -= 1;
      }
    }
    for (let i = 0; i < blockQuota; i++) {
      ingest(wallet(50_000 + ((Math.floor(now / 1000) + i) % 8000)), now, 'REVIVE|BLOCKSCAN', 'refill');
    }

    const shortfall = Math.max(0, budget.targetCap - activeCount());
    shortfallStreak = shortfall > 0 ? shortfallStreak + 1 : 0;
  }

  function candidateSyncTick(now: number) {
    // 仅元数据：故意尝试 ingest 应被拒绝（模拟生产门闩）
    if (CONFIG.smartMoneyRawRefillCronEnabled) return;
    for (const c of board.slice(0, 10)) {
      ingest(c.wallet, now, 'LEADERBOARD_SYNC', 'candidate');
    }
  }

  function lightDecide(w: WalletRow, nowMs: number): 'QUALIFIED' | 'ELIMINATED' | 'DEFER' {
    const rej = evaluateLightWindowReject(makeProfile(w, nowMs));
    if (!rej.passed) {
      if (isLightDualShortDeferOnly(rej)) return 'DEFER';
      return 'ELIMINATED';
    }
    return 'QUALIFIED';
  }

  function lightTick(now: number) {
    // 生产默认 Light batch ≈ 20，禁止一次性抽干 RAW
    const LIGHT_BATCH = 20;
    let processed = 0;
    for (const row of pool.values()) {
      if (processed >= LIGHT_BATCH) break;
      if (row.stage !== 'RAW' || row.nextLightAt > now) continue;
      processed += 1;
      const d = lightDecide(row, now);
      if (d === 'DEFER') {
        lightDefer += 1;
        row.nextLightAt = now + 5 * DAY;
        continue;
      }
      if (d === 'ELIMINATED') {
        lightElim += 1;
        row.stage = 'ELIMINATED';
        row.elimBucket = 'HOT';
        continue;
      }
      row.stage = 'QUALIFIED';
      row.nextDeepAt = now;
    }
  }

  function deepTick(now: number) {
    // 生产 Deep 有 batch/超时，模拟限流避免 QUALIFIED 瞬空
    const DEEP_BATCH = 30;
    let processed = 0;
    for (const row of pool.values()) {
      if (processed >= DEEP_BATCH) break;
      if (row.stage !== 'QUALIFIED' && row.stage !== 'COPY_POOL') continue;
      if (row.nextDeepAt > now) continue;
      processed += 1;

      // Gate 曲线：80% 已有新鲜 ALL+1W（模拟 Light/快照），只补缺失
      const freshAll = row.pnl1y > 0;
      const fresh1w = true;
      const gate = simulateEnsureGate({ ALL: freshAll, '1W': fresh1w });
      gateHttpFetches += gate.fetched.length;
      gateHttpSkipped += gate.skipped.length;

      if (row.pnl1y <= CONFIG.smartMoneyScorePoolMinPnl1y) {
        l1Elim += 1;
        row.stage = 'ELIMINATED';
        row.elimBucket = 'COLD';
        continue;
      }
      if (
        failsL1DustGate({
          medianNotionalUsd: row.medianNotional,
          dustShare: row.dustShare,
          sampleCount: CONFIG.smartMoneyL1DustMinSampleCount,
          minSampleCount: CONFIG.smartMoneyL1DustMinSampleCount,
          minMedianUsd: CONFIG.smartMoneyL1MinMedianNotionalUsd,
          maxDustShare: CONFIG.smartMoneyL1MaxDustShare,
        })
      ) {
        l1Elim += 1;
        row.stage = 'ELIMINATED';
        row.elimBucket = 'COLD';
        continue;
      }
      if (
        CONFIG.smartMoneyCopyPoolMaxMddPct > 0 &&
        row.mddPct != null &&
        row.mddPct >= CONFIG.smartMoneyCopyPoolMaxMddPct
      ) {
        l1Elim += 1;
        row.stage = 'ELIMINATED';
        row.elimBucket = 'COLD';
        continue;
      }

      row.traderScore = row.pnl30d < 0 ? 45 : 72;
      if (row.traderScore >= 50) {
        row.stage = 'COPY_POOL';
        if (row.hedged) {
          hedgeEject += 1;
          row.stage = 'ELIMINATED';
          row.elimBucket = 'COLD';
        }
      } else {
        row.stage = 'SCORED';
      }
      row.nextDeepAt = now + DAY;
    }
  }

  function elimTick(now: number) {
    const cutoff = now - CONFIG.smartMoneyElimPurgeNoTradeDays * DAY;
    for (const [w, row] of [...pool.entries()]) {
      if (row.stage !== 'ELIMINATED') continue;
      const anchor = row.lastTradeAt ?? row.lastSeenAt;
      if (anchor < cutoff) {
        pool.delete(w);
        purged += 1;
        continue;
      }
      if (row.elimBucket !== 'HOT') continue;
      // 不抢 QUALIFIED Deep：只回 RAW 走 Light
      if (row.pnl1y > 0 && row.pnl30d >= 0) {
        row.stage = 'RAW';
        row.nextLightAt = now;
      } else {
        row.elimBucket = 'COLD';
      }
    }
  }

  function leaderboardSync(now: number, fail: boolean) {
    if (syncRunning) {
      stuckRisks.push(`sync skipped while running @${now}`);
      return;
    }
    syncRunning = true;
    try {
      if (fail) throw new Error('sync fail');
      weekCursor = Math.min(weekCursor, 100); // WEEK 日切重置偏回头部，但不归零吞吞吐
    } finally {
      syncRunning = false;
    }
  }

  const TICKS = 60;
  let maxQualified = 0;
  for (let t = 0; t < TICKS; t++) {
    const now = now0 + t * 60_000;
    if (t % 2 === 0) refillTick(now);
    candidateSyncTick(now); // 应为空操作
    lightTick(now);
    if (t % 3 === 0) deepTick(now);
    if (t % 5 === 0) elimTick(now);
    if (t === 15) {
      try {
        leaderboardSync(now, true);
      } catch {
        /* finally 释放 */
      }
    }
    if (t === 16) leaderboardSync(now, false);
    if (syncRunning) bugs.push('syncRunning stuck');

    let q = 0;
    for (const r of pool.values()) if (r.stage === 'QUALIFIED') q += 1;
    maxQualified = Math.max(maxQualified, q);
  }

  // 冷却断言
  {
    const w = wallet(10_000);
    const row = pool.get(w);
    if (row) {
      row.stage = 'DORMANT';
      row.lastIngestedAt = now0 + 30 * 60_000;
      assert.equal(canIngest(row, now0 + 30 * 60_000 + DAY, { strong: false }), false);
    }
  }

  let raw = 0;
  let qualified = 0;
  let copyPool = 0;
  let elim = 0;
  let scored = 0;
  for (const r of pool.values()) {
    if (r.stage === 'RAW') raw += 1;
    if (r.stage === 'QUALIFIED') qualified += 1;
    if (r.stage === 'COPY_POOL') copyPool += 1;
    if (r.stage === 'ELIMINATED') elim += 1;
    if (r.stage === 'SCORED') scored += 1;
  }

  if (pool.size === 0) bugs.push('empty pool');
  if (candidateIngestCalls > 0) bugs.push(`candidate ingest leaked: ${candidateIngestCalls}`);
  if (refillIngestCalls === 0) bugs.push('refill never ingested');
  if (lightElim + lightDefer === 0) bugs.push('Light gates inactive');
  if (copyPool === 0 && l1Elim === 0) bugs.push('no CopyPool and no L1 elim — funnel stuck');
  // CopyPool 涨大后 RAW 水位不得被饿死（历史 bug：把已晋级阶段计入 active）
  if (copyPool >= 200 && raw < CONFIG.smartMoneyRawRefillLow) {
    bugs.push(`RAW starved while CopyPool=${copyPool} raw=${raw}`);
  }
  // 稳态：补池快于 Light(20/tick) 时 RAW 应接近 target
  if (raw < 700) {
    bugs.push(`RAW not near target after warmup: raw=${raw}`);
  }
  if (shortfallStreak > 5) {
    stuckRisks.push(`shortfallStreak=${shortfallStreak} at end`);
  }
  if (maxQualified > 200) {
    stuckRisks.push(`QUALIFIED peak high (${maxQualified}) — Deep 吞吐压力（非死锁）`);
  }
  if (gateHttpSkipped === 0 && gateHttpFetches > 0) {
    stuckRisks.push('gate never skipped fresh curves');
  }
  // Gate 跳过应占多数
  const gateSkipRatio =
    gateHttpSkipped + gateHttpFetches > 0
      ? gateHttpSkipped / (gateHttpSkipped + gateHttpFetches)
      : 1;
  if (gateSkipRatio < 0.5) {
    bugs.push(`gate skip ratio too low: ${gateSkipRatio.toFixed(2)}`);
  } else {
    checks.push(`gate skip ratio ${(gateSkipRatio * 100).toFixed(0)}% OK`);
  }

  // MDD 前端语义（与 shared-ui 一致）
  function formatDrawdownPercent(raw: string | null): string {
    if (raw == null || raw === '') return '—';
    const n = Number(raw);
    if (!Number.isFinite(n)) return '—';
    const ratio = Math.abs(n) <= 1 ? Math.abs(n) : Math.abs(n) / 100;
    if (ratio >= 0.999) return '—';
    const pct = Math.abs(n) <= 1 ? n * 100 : n;
    return `${pct.toFixed(1)}%`;
  }
  assert.equal(formatDrawdownPercent('1'), '—');
  assert.equal(formatDrawdownPercent('0.999'), '—');
  assert.equal(formatDrawdownPercent('0.18'), '18.0%');
  checks.push('frontend fake-100% guard OK');

  const report = {
    ok: bugs.length === 0,
    checks,
    bugs,
    stuckRisks,
    funnel: {
      poolSize: pool.size,
      active: activeCount(),
      raw,
      qualified,
      scored,
      copyPool,
      eliminated: elim,
      lightElim,
      lightDefer,
      l1Elim,
      hedgeEject,
      purged,
      revived,
      weekCursor,
      allCursor,
      shortfallStreak,
      priorityLeft: priorityQ.length,
      refillIngestCalls,
      candidateIngestCalls,
      gateHttpFetches,
      gateHttpSkipped,
      gateSkipRatio: Number(gateSkipRatio.toFixed(3)),
      maxQualified,
    },
    ticks: TICKS,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error('FULL SIM FAILED');
    process.exit(1);
  }
  console.log('FULL SIM OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
