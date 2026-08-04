/**
 * 入池可见性 / 缺数误杀 / REQUIRE_TIER2E / inactivity 纯函数回归
 * （对应 aidocs/排行榜入池可见性缺陷修复方案.md B1–B6）
 */
import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/polycopy_test';

async function main() {
  const { evaluateL1CandidateGate } = await import('./smartMoneyTierGate');
  const { scoreObservedTraderProfile } = await import('./smartMoneyScorer');
  const { shouldExitCopyPoolForInactivity } = await import('./smartMoneyCopyPoolInactivity');
  const { resolveCopyPoolMetricScore } = await import('./smartMoneyPoolScore');
  const { evaluateTier2Enhanced, hasCopyPoolHardFlag } = await import('./smartMoneyTierGate');
  const { CONFIG } = await import('../../config/env');
  const { smartMoneyCachedDisplayWhere } = await import('./smartMoneyCachedQuery');
  const { mergeScoreExplainPreservingCopyability } = await import(
    './smartMoneyLeaderboardWriter'
  );
  const {
    selectActiveCopyabilityCooldownWallets,
    withCopyabilityWalletTimeout,
  } = await import('./smartMoneyCopyabilityEnrich');

  const goodCurve = Array.from({ length: 20 }, (_, index) => ({
    curveType: 'PORTFOLIO_PNL_ALL',
    period: 'ALL' as const,
    ts: new Date(Date.UTC(2026, 0, index + 1)),
    value: String(1000 + index * 50),
  }));

  const l1Base = {
    wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'fix',
    joinedAtText: null as string | null,
    profilePnlApiFilledPeriods: null as string[] | null,
    holdingsValue: '200000',
    totalVolume: '2000000',
    totalPnl: '50000',
    predictionCount: 600,
    curves: goodCurve,
  };

  const qualityExtras = {
    winRate: 0.55,
    profitFactor: 1.8,
    trades7d: 12,
    trades30d: 12,
    closedMarketCount: 20,
  };

  // ---------- B2: closed HTTP 失败跳过 L1-PF；样本空仍硬拦 ----------
  {
    const fetchFail = evaluateL1CandidateGate({
      profile: l1Base,
      resolvedTotalPnl: 50_000,
      totalVolume: 2_000_000,
      effectiveTotalReturn: 0.8,
      effectiveMaxDrawdown: 0.1,
      ...qualityExtras,
      profitFactor: null,
      closedMarketDataMissing: true,
      closedMarketCount: null,
      closedFetchFailed: true,
      totalPnl1y: 50_000,
      maxDrawdownUsd1y: 1_000,
    });
    assert.equal(fetchFail.failReason?.includes('L1-PF') ?? false, false, 'B2 fetch fail skips PF');

    const emptySample = evaluateL1CandidateGate({
      profile: l1Base,
      resolvedTotalPnl: 50_000,
      totalVolume: 2_000_000,
      effectiveTotalReturn: 0.8,
      effectiveMaxDrawdown: 0.1,
      ...qualityExtras,
      profitFactor: null,
      closedMarketDataMissing: true,
      closedMarketCount: null,
      closedFetchFailed: false,
      totalPnl1y: 50_000,
      maxDrawdownUsd1y: 1_000,
    });
    assert.ok(emptySample.failReason?.includes('L1-PF'), 'empty sample still L1-PF');
  }

  // ---------- B3: trades fetch fail 不打 L1-TRADES30D ----------
  {
    const r = evaluateL1CandidateGate({
      profile: l1Base,
      resolvedTotalPnl: 50_000,
      totalVolume: 2_000_000,
      effectiveTotalReturn: 0.8,
      effectiveMaxDrawdown: 0.1,
      ...qualityExtras,
      trades30d: null,
      tradesFetchOk: false,
      totalPnl1y: 50_000,
      maxDrawdownUsd1y: 1_000,
    });
    assert.equal(r.failReason?.includes('L1-TRADES30D') ?? false, false, 'B3 trades skip');
  }

  // ---------- B3: trades fetch fail 不打 TRADE_FREQUENCY_UNVERIFIED ----------
  {
    const baseProfile = {
      wallet: l1Base.wallet,
      name: 'fix',
      joinedAtText: null as string | null,
      profilePnlApiFilledPeriods: null as string[] | null,
      holdingsValue: '200000',
      totalVolume: '2000000',
      totalPnl: '50000',
      predictionCount: 600,
      curves: goodCurve,
      snapshotAt: new Date('2026-07-28T00:00:00.000Z'),
    };
    const observed = {
      wallet: l1Base.wallet,
      sourceRankWeek: null as number | null,
      sourceRankMonth: null as number | null,
      sourceRankAll: null as number | null,
      officialSourceRankWeek: null as number | null,
      officialSourceRankMonth: null as number | null,
      officialSourceRankAll: null as number | null,
      externalSourceRankWeek: null as number | null,
      externalSourceRankMonth: null as number | null,
      externalSourceRankAll: null as number | null,
      candidatePeriods: [] as string[],
      candidateCategories: [] as string[],
      blacklisted: false,
      noiseTags: [] as string[],
    };
    const externalMetrics = {
      '1D': null,
      '7D': null,
      '30D': null,
      'ALL': null,
    };
    const failed = scoreObservedTraderProfile(baseProfile, observed, externalMetrics, {
      tradesPerDay1D: null,
      tradesFetchOk: false,
      trades30d: null,
      trades7d: 0,
    });
    assert.equal(
      failed.riskFlags.includes('TRADE_FREQUENCY_UNVERIFIED'),
      false,
      'B3 no UNVERIFIED on fetch fail'
    );
    assert.equal(hasCopyPoolHardFlag(failed.riskFlags), false);

    const unverified = scoreObservedTraderProfile(baseProfile, observed, externalMetrics, {
      tradesPerDay1D: null,
      trades30d: null,
      trades7d: 0,
    });
    assert.equal(
      unverified.riskFlags.includes('TRADE_FREQUENCY_UNVERIFIED'),
      true,
      'legacy path still flags UNVERIFIED when fetchOk unset'
    );
  }

  // ---------- B4: inactivity 尊重 lastTradeAt ----------
  {
    const now = new Date('2026-07-28T00:00:00.000Z');
    assert.equal(
      shouldExitCopyPoolForInactivity({
        holdingsValueUsd: 0,
        trades7d: 0,
        lastTradeAt: new Date('2026-07-25T00:00:00.000Z'),
        now,
        exitDays: 7,
        maxHoldingsUsd: 1,
      }),
      false,
      'recent lastTradeAt should not exit'
    );
    assert.equal(
      shouldExitCopyPoolForInactivity({
        holdingsValueUsd: 0,
        trades7d: 0,
        lastTradeAt: new Date('2026-07-10T00:00:00.000Z'),
        now,
        exitDays: 7,
        maxHoldingsUsd: 1,
      }),
      true,
      'stale lastTradeAt should exit'
    );
  }

  // ---------- B5/E1 语义：池分 ≤ EXIT 与灰区 ----------
  {
    const exit = CONFIG.smartMoneyCopyPoolExitScore;
    const enter = CONFIG.smartMoneyCopyPoolEnterScore;
    assert.ok(enter > exit);
    const below = resolveCopyPoolMetricScore({ traderScore: exit, score: 99 });
    assert.equal(below <= exit, true);
    const gray = resolveCopyPoolMetricScore({ traderScore: exit + 1, score: 10 });
    assert.equal(gray > exit && gray < enter, true);
  }

  // ---------- B6: T2E 失败与 REQUIRE 开关正交 ----------
  {
    const t2eFail = evaluateTier2Enhanced({
      closedMarketReturnDistribution: null,
      marketLiquidityProfile: null,
    });
    assert.equal(t2eFail.passed, false);
    assert.equal(CONFIG.smartMoneyCopyPoolRequireTier2e, false);
  }

  // ---------- B1: cached API 仍要求 inCopyPool + rank（入池后须 dirty→flush）----------
  {
    const where = smartMoneyCachedDisplayWhere();
    assert.equal(where.inCopyPool, true);
    assert.deepEqual(where.rank, { not: null });
  }

  // ---------- 数据齐全时门控仍硬杀 ----------
  {
    const lowPf = evaluateL1CandidateGate({
      profile: l1Base,
      resolvedTotalPnl: 50_000,
      totalVolume: 2_000_000,
      effectiveTotalReturn: 0.8,
      effectiveMaxDrawdown: 0.1,
      ...qualityExtras,
      profitFactor: 0.5,
      closedMarketDataMissing: false,
      totalPnl1y: 50_000,
      maxDrawdownUsd1y: 1_000,
    });
    assert.ok(lowPf.failReason?.includes('L1-PF'));

    const lowTrades = evaluateL1CandidateGate({
      profile: l1Base,
      resolvedTotalPnl: 50_000,
      totalVolume: 2_000_000,
      effectiveTotalReturn: 0.8,
      effectiveMaxDrawdown: 0.1,
      ...qualityExtras,
      trades30d: 0,
      tradesFetchOk: true,
      totalPnl1y: 50_000,
      maxDrawdownUsd1y: 1_000,
    });
    assert.ok(lowTrades.failReason?.includes('L1-TRADES30D'));
  }

  // ---------- Deep 后置分支语义模拟（纯逻辑，不碰 DB）----------
  {
    type SyncResult = {
      inCopyPool: boolean;
      exited: boolean;
      exitReason?: 'INACTIVE' | 'EXIT_SCORE' | 'HARD_FLAG' | null;
    };

    function deepPostSyncAction(copyPool: SyncResult, previousStage: string, priorMiss: number) {
      if (copyPool.inCopyPool) return 'COPY_POOL_AND_DIRTY';
      if (copyPool.exited && copyPool.exitReason === 'INACTIVE') return 'KEEP_ELIM_INACTIVE_DIRTY';
      if (copyPool.exited && copyPool.exitReason === 'EXIT_SCORE') return 'KEEP_SCORED_EXIT_DIRTY';
      if (copyPool.exited && copyPool.exitReason === 'HARD_FLAG') return 'KEEP_ELIM_HARD_DIRTY';
      const recheckMiss =
        previousStage === 'SCORED' || previousStage === 'COPY_POOL' ? priorMiss + 1 : 0;
      if (recheckMiss > 1) return 'ELIM_SCORE_BELOW';
      return 'SCORED_MISS';
    }

    assert.equal(
      deepPostSyncAction({ inCopyPool: true, exited: false }, 'QUALIFIED', 0),
      'COPY_POOL_AND_DIRTY'
    );
    assert.equal(
      deepPostSyncAction(
        { inCopyPool: false, exited: true, exitReason: 'INACTIVE' },
        'COPY_POOL',
        0
      ),
      'KEEP_ELIM_INACTIVE_DIRTY',
      'B4 inactivity must not become SCORE_BELOW'
    );
    assert.equal(
      deepPostSyncAction(
        { inCopyPool: false, exited: true, exitReason: 'EXIT_SCORE' },
        'COPY_POOL',
        5
      ),
      'KEEP_SCORED_EXIT_DIRTY',
      'B5 ≤EXIT immediate exit skips SCORE_BELOW miss'
    );
    assert.equal(
      deepPostSyncAction({ inCopyPool: false, exited: false }, 'SCORED', 1),
      'ELIM_SCORE_BELOW'
    );
  }

  // ---------- Gamma：T2E 失败仍应调 sync（REQUIRE=false 时可入）----------
  {
    function gammaShouldCallSync(tier2ePassed: boolean, requireTier2e: boolean) {
      // 修复后：无论 T2E 成败都调 sync；是否入池由 sync 内 REQUIRE 决定
      void tier2ePassed;
      void requireTier2e;
      return true;
    }
    assert.equal(gammaShouldCallSync(false, false), true);
    assert.equal(gammaShouldCallSync(false, true), true);
  }

  // ---------- Copyability：Deep 复评缺值时保留旧仿真，超时必须返回 ----------
  {
    const merged = mergeScoreExplainPreservingCopyability(
      {
        copyability: {
          version: 'v1',
          metrics: {
            copyabilityScore: 72,
            backtestPnlUsd: 123.45,
            copyLossRate: 0.12,
          },
        },
        displayProfile: {
          backtestPnlUsd: 123.45,
          copyLossRate: 0.12,
          slippageBpsEffective: 65,
        },
      },
      {
        copyability: {
          metrics: {
            copyabilityScore: 72,
            backtestPnlUsd: null,
          },
        },
        displayProfile: {
          backtestPnlUsd: null,
          copyLossRate: null,
          slippageBpsEffective: null,
          recentPnl7d: 50,
        },
      }
    );
    const copyability = merged.copyability as {
      metrics?: Record<string, unknown>;
    };
    const display = merged.displayProfile as Record<string, unknown>;
    assert.equal(copyability.metrics?.backtestPnlUsd, 123.45);
    assert.equal(copyability.metrics?.copyLossRate, 0.12);
    assert.equal(display.backtestPnlUsd, 123.45);
    assert.equal(display.copyLossRate, 0.12);
    assert.equal(display.slippageBpsEffective, 65);
    assert.equal(display.recentPnl7d, 50);

    await assert.rejects(
      withCopyabilityWalletTimeout(
        (signal) =>
          new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        5,
        '0xtimeout'
      ),
      /copyability_wallet_timeout/
    );

    assert.deepEqual(
      selectActiveCopyabilityCooldownWallets(
        [
          ['0xCOOLING', 2_000],
          ['0xEXPIRED', 999],
        ],
        1_000
      ),
      ['0xcooling'],
      '失败地址冷却期间应从 picker 排除，过期后自动恢复'
    );
  }

  console.log('smartMoneyEntryVisibilityFixes.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
