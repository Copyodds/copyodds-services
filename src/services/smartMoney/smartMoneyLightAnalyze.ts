import { getPgPoolStats, prisma } from '../../db';

import { CONFIG } from '../../config/env';

import { evaluateTier1L, evaluateLightCheapReject, isLightDualShortDeferOnly } from './smartMoneyTierGate';

import { transitionPipelineStage } from './smartMoneyPipeline';

import {

  markLightQueued,

  pickLightAnalyzeBatch,

} from './smartMoneyFetchScheduler';

import { bumpPipelineCursor } from './smartMoneyPipeline';

import { persistPolymarketProfileSnapshot } from './smartMoneyProfilePersist';

import { mapPool } from '../../copyTrading/services/mapPool';

import { waitSmartMoneyRequestGap } from './smartMoneyRequestGap';

import { moveToEliminated } from './smartMoneyEliminated';

import { fetchPolymarketProfileForLight } from './smartMoneyLightProfileFetch';

import {
  readLightweightApiFallbackTimings,
  resetLightweightApiFallbackTimings,
} from '../polymarket/polymarketProfileApiFallback';

import { runSmartMoneyPoolGovernanceTick } from './smartMoneyPoolGovernance';

import { runLightL0DbForWallet } from './smartMoneyLightL0Db';

/**

 * Light 单地址内部分阶段耗时统计。批次汇总后打日志，用于定位 Light 吞吐瓶颈：

 * 抓取慢（fetch）、全局节流慢（gap）还是等 DB 连接慢（persist / dbOther + pool.waiting）。

 */

type LightPhase = 'l0Db' | 'gap' | 'fetch' | 'persist' | 'dbOther';

type LightPhaseStat = { totalMs: number; maxMs: number; count: number };

function createLightPhaseStats(): Record<LightPhase, LightPhaseStat> {

  return {

    l0Db: { totalMs: 0, maxMs: 0, count: 0 },

    gap: { totalMs: 0, maxMs: 0, count: 0 },

    fetch: { totalMs: 0, maxMs: 0, count: 0 },

    persist: { totalMs: 0, maxMs: 0, count: 0 },

    dbOther: { totalMs: 0, maxMs: 0, count: 0 },

  };

}

let lightPhaseStats = createLightPhaseStats();

let lightPhaseWallets = 0;

let lightPoolWaitingPeak = 0;

async function measureLightPhase<T>(phase: LightPhase, fn: () => Promise<T>): Promise<T> {

  const startedAt = Date.now();

  try {

    return await fn();

  } finally {

    const elapsedMs = Date.now() - startedAt;

    const stat = lightPhaseStats[phase];

    stat.totalMs += elapsedMs;

    stat.count += 1;

    if (elapsedMs > stat.maxMs) stat.maxMs = elapsedMs;

    const waiting = getPgPoolStats().waiting;

    if (waiting > lightPoolWaitingPeak) lightPoolWaitingPeak = waiting;

  }

}

function resetLightPhaseStats(wallets: number): void {

  lightPhaseStats = createLightPhaseStats();

  lightPhaseWallets = wallets;

  lightPoolWaitingPeak = 0;

  resetLightweightApiFallbackTimings();

}

function logLightPhaseStats(batchElapsedMs: number): void {

  if (lightPhaseWallets === 0) return;

  const phase = (name: LightPhase): { avgMs: number; maxMs: number; totalMs: number; count: number } => {

    const stat = lightPhaseStats[name];

    return {

      avgMs: stat.count > 0 ? Math.round(stat.totalMs / stat.count) : 0,

      maxMs: stat.maxMs,

      totalMs: stat.totalMs,

      count: stat.count,

    };

  };

  console.log('[smart-money-pipeline] light phase timing', {

    wallets: lightPhaseWallets,

    concurrency: CONFIG.smartMoneyAnalyzeConcurrency,

    batchElapsedMs,

    perWalletMs: Math.round(batchElapsedMs / lightPhaseWallets),

    l0Db: phase('l0Db'),

    gap: phase('gap'),

    fetch: phase('fetch'),

    persist: phase('persist'),

    dbOther: phase('dbOther'),

    apiFallback: readLightweightApiFallbackTimings(),

    pool: { ...getPgPoolStats(), waitingPeak: lightPoolWaitingPeak },

  });

}



export type LightAnalyzeResult = {

  wallet: string;

  success: boolean;

  passedTier1L: boolean;

  error?: string;

  skippedL0Db?: boolean;

  /** 淘汰/延后/错误原因，供批次 reasonTop 聚合 */
  outcomeReason?: string | null;

};



async function withWalletTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {

    return await Promise.race([

      fn(),

      new Promise<T>((_, reject) => {

        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);

      }),

    ]);

  } finally {

    if (timer) clearTimeout(timer);

  }

}



/**

 * L0-B 已删除（F3）：默认有 sources 即过，近乎空跑，不再影响判断。

 */



export async function runLightAnalyzeForWallet(wallet: string): Promise<LightAnalyzeResult> {

  try {

    const l0 = await measureLightPhase('l0Db', () => runLightL0DbForWallet(wallet));

    if (l0.action === 'SKIP_DONE') {

      return {

        wallet: wallet.toLowerCase(),

        success: true,

        passedTier1L: l0.passedTier1L,

        skippedL0Db: true,

      };

    }



    await measureLightPhase('gap', () => waitSmartMoneyRequestGap('light'));

    const profile = await measureLightPhase('fetch', () => fetchPolymarketProfileForLight(wallet));



    const tier1l = evaluateTier1L(profile);



    if (!tier1l.passed) {

      await moveToEliminated(profile.wallet, tier1l.failReason ?? 'T1L_FAIL', {

        clearTier1l: true,

      });

      return {
        wallet: profile.wallet,
        success: true,
        passedTier1L: false,
        outcomeReason: tier1l.failReason ?? 'T1L_FAIL',
      };

    }



    const cheap = evaluateLightCheapReject(profile);

    if (!cheap.passed) {

      // L-DUAL-SHORT only：延后 Light，不进淘汰池（省 Deep，可逆）

      if (isLightDualShortDeferOnly(cheap)) {

        const deferMs = CONFIG.smartMoneyLightDualShortDeferDays * 24 * 60 * 60 * 1000;

        await transitionPipelineStage(profile.wallet, 'RAW', {

          tierFailReason: 'L-DUAL-SHORT',

          tier1lPassedAt: null,

          nextLightAnalyzeAt: new Date(Date.now() + deferMs),

        });

        return {
          wallet: profile.wallet,
          success: true,
          passedTier1L: false,
          outcomeReason: 'L-DUAL-SHORT',
        };

      }

      await moveToEliminated(profile.wallet, cheap.failReason ?? 'T1L_CHEAP', {

        clearTier1l: true,

      });

      return {
        wallet: profile.wallet,
        success: true,
        passedTier1L: false,
        outcomeReason: cheap.failReason ?? 'T1L_CHEAP',
      };

    }



    if (CONFIG.smartMoneyLightPersistSnapshot) {

      await measureLightPhase('persist', () => persistPolymarketProfileSnapshot(profile));

    }



    // F4：通过即进 QUALIFIED，禁止 FULL_HOLD 回灌 RAW

    await measureLightPhase('dbOther', () =>

      transitionPipelineStage(profile.wallet, 'QUALIFIED', {

        tierFailReason: null,

        tier1lPassedAt: new Date(),

        nextDeepAnalyzeAt: new Date(),

        elimFailCount: 0,

        elimFrozenUntil: null,

        nextElimCheckAt: null,

      })

    );

    return { wallet: profile.wallet, success: true, passedTier1L: true, outcomeReason: null };

  } catch (error) {

    const message = error instanceof Error ? error.message : String(error);

    // 瞬时错误：短冷却回 RAW，不立刻淘汰（避免上游抖动误杀）

    await transitionPipelineStage(wallet, 'RAW', {

      nextLightAnalyzeAt: new Date(Date.now() + 15 * 60 * 1000),

      tierFailReason: `light_error:${message}`.slice(0, 240),

    }).catch(() => undefined);

    return { wallet, success: false, passedTier1L: false, error: message, outcomeReason: `light_error:${message}` };

  }

}



export async function runSmartMoneyLightAnalyzeBatch(

  limit = CONFIG.smartMoneyLightFetchBatchSize

): Promise<LightAnalyzeResult[]> {

  await runSmartMoneyPoolGovernanceTick().catch((error) => {

    console.warn('[smart-money-pipeline] pool governance skipped', error);

  });



  const wallets = await pickLightAnalyzeBatch(limit);

  await bumpPipelineCursor('light', BigInt(wallets.length));



  resetLightPhaseStats(wallets.length);

  const batchStartedAt = Date.now();



  // 按钱包进入 worker 时再打标：并发数内才是 LIGHT_ANALYZING，避免整批预打标后挂死

  const results = await mapPool(wallets, CONFIG.smartMoneyAnalyzeConcurrency, async (wallet) => {

    await measureLightPhase('dbOther', () => markLightQueued([wallet]));

    return withWalletTimeout(

      () => runLightAnalyzeForWallet(wallet),

      CONFIG.smartMoneyLightWalletTimeoutMs,

      `light:${wallet}`

    ).catch(async (error) => {

      const message = error instanceof Error ? error.message : String(error);

      await transitionPipelineStage(wallet, 'RAW', {

        nextLightAnalyzeAt: new Date(Date.now() + 15 * 60 * 1000),

        tierFailReason: `light_error:${message}`.slice(0, 240),

      }).catch(() => undefined);

      return {
        wallet,
        success: false,
        passedTier1L: false,
        error: message,
        outcomeReason: `light_error:${message}`,
      } satisfies LightAnalyzeResult;

    });

  });



  logLightPhaseStats(Date.now() - batchStartedAt);

  return results;

}



export async function countRawPipelineAddresses(): Promise<number> {

  return prisma.smartMoneyRawAddress.count({ where: { pipelineStage: 'RAW', dormant: false } });

}


