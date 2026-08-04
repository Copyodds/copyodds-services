import { CONFIG } from '../../config/env';
import { runSmartMoneyLightAnalyzeBatch } from './smartMoneyLightAnalyze';
import { runSmartMoneyDeepAnalyzeBatch } from './smartMoneyDeepAnalyze';
import { getPipelineStageCounts } from './smartMoneyPipeline';
import {
  countCachedApiSmartMoneyLeaderboardRows,
  getSmartMoneyRankFlushLagSec,
} from './smartMoneyLeaderboardWriter';
import { countPendingGammaEnrichment, runSmartMoneyGammaEnrichmentBatch } from './smartMoneyGammaEnrichment';
import {
  countPendingCurveEnrichment,
  runSmartMoneyCurveEnrichmentBatch,
} from './smartMoneyDeepEnrich';
import { prisma } from '../../db';
import { isRankModelActive } from './smartMoneyRankModel';
import { countQualifiedOverCap, countScoredActive } from './smartMoneyPoolGovernance';
import { rawPoolActiveWhere } from './smartMoneyRawPoolActive';
import { SMART_MONEY_PNL_WINDOW_DAYS } from './smartMoneyPositionStats';
import { getCopyPoolDualChannelStats, businessDayKey, isScoredOnBusinessDay } from './smartMoneyCopyPoolRescoreChannels';
import { getCopyPoolRescoreMetricSnapshot } from './smartMoneyCopyPoolRescoreMetrics';
import { getDiscoveryCursor } from './smartMoneyDiscoveryCursor';
import { COPY_POOL_SLA_ALERT_SOURCE } from './smartMoneyCopyPoolSla';
import {
  aggregateReasonTop,
  finishSmartMoneyBatchRun,
  getRecentSmartMoneyBatchSummaries,
  inferPipelineBottleneck,
  startSmartMoneyBatchRun,
  type SmartMoneyBatchBacklog,
} from './smartMoneyBatchObservability';
import { snapshotConsumableBacklog } from './smartMoneyConsumableBacklog';

let lightRunning = false;
let deepRunning = false;

/** ANALYZING 超时自愈：只回收「无人认领」的僵尸，不回收正在跑的 batch */
export async function recoverStaleAnalyzingStages(): Promise<{ light: number; deep: number }> {
  const staleBefore = new Date(Date.now() - CONFIG.smartMoneyAnalyzingStaleMs);
  let lightCount = 0;
  let deepCount = 0;

  // Light 批在跑时不要重置 LIGHT_*：否则与 mapPool 中钱包互抢 stage
  if (!lightRunning) {
    // 历史状态分裂时，在榜地址不得回 RAW；恢复成 COPY_POOL 交给 Deep 复评。
    lightCount = Number(
      await prisma.$executeRaw`
        UPDATE "SmartMoneyRawAddress" ra
        SET
          "pipelineStage" = CASE
            WHEN EXISTS (
              SELECT 1
              FROM "SmartMoneyLeaderboardRow" lb
              WHERE lb.wallet = ra.wallet
                AND lb."inCopyPool" = true
            ) THEN 'COPY_POOL'
            ELSE 'RAW'
          END,
          "nextLightAnalyzeAt" = CASE
            WHEN EXISTS (
              SELECT 1
              FROM "SmartMoneyLeaderboardRow" lb
              WHERE lb.wallet = ra.wallet
                AND lb."inCopyPool" = true
            ) THEN NULL
            ELSE NOW()
          END,
          "nextDeepAnalyzeAt" = CASE
            WHEN EXISTS (
              SELECT 1
              FROM "SmartMoneyLeaderboardRow" lb
              WHERE lb.wallet = ra.wallet
                AND lb."inCopyPool" = true
            ) THEN NOW()
            ELSE ra."nextDeepAnalyzeAt"
          END,
          "updatedAt" = NOW()
        WHERE ra."pipelineStage" = 'LIGHT_ANALYZING'
          AND (
            ra."lastLightQueuedAt" < ${staleBefore}
            OR (ra."lastLightQueuedAt" IS NULL AND ra."updatedAt" < ${staleBefore})
          )
      `
    );
  }

  if (!deepRunning) {
    // Deep 临时阶段必须按在榜身份恢复，不能把 COPY_POOL 成员一律降成 QUALIFIED。
    deepCount = Number(
      await prisma.$executeRaw`
        UPDATE "SmartMoneyRawAddress" ra
        SET
          "pipelineStage" = CASE
            WHEN EXISTS (
              SELECT 1
              FROM "SmartMoneyLeaderboardRow" lb
              WHERE lb.wallet = ra.wallet
                AND lb."inCopyPool" = true
            ) THEN 'COPY_POOL'
            ELSE 'QUALIFIED'
          END,
          "nextDeepAnalyzeAt" = NOW(),
          "updatedAt" = NOW()
        WHERE ra."pipelineStage" = 'FULL_ANALYZING'
          AND (
            ra."lastDeepQueuedAt" < ${staleBefore}
            OR (ra."lastDeepQueuedAt" IS NULL AND ra."updatedAt" < ${staleBefore})
          )
      `
    );
  }

  if (lightCount > 0 || deepCount > 0) {
    console.warn('[smart-money-pipeline] recovered stale ANALYZING', {
      light: lightCount,
      deep: deepCount,
      staleBefore: staleBefore.toISOString(),
      skippedLight: lightRunning,
      skippedDeep: deepRunning,
    });
  }
  return { light: lightCount, deep: deepCount };
}

export async function runSmartMoneyPipelineLightBatch(trigger = 'manual'): Promise<{
  trigger: string;
  picked: number;
  passedTier1L: number;
  failed: number;
  batches: number;
} | null> {
  if (lightRunning) {
    console.warn('[smart-money-pipeline] light batch skipped: already running', { trigger });
    finishSmartMoneyBatchRun(startSmartMoneyBatchRun('light', trigger), {
      skipped: true,
      skipReason: 'already_running',
    });
    return null;
  }
  lightRunning = true;
  const run = startSmartMoneyBatchRun('light', trigger);
  const backlogBefore = await snapshotConsumableBacklog().catch(
    (): SmartMoneyBatchBacklog => ({})
  );
  try {
    await recoverStaleAnalyzingStages();
    const maxBatches = CONFIG.smartMoneyBootstrapBatchesPerRun;
    let picked = 0;
    let passedTier1L = 0;
    let failed = 0;
    let batches = 0;
    let eliminated = 0;
    let deferred = 0;
    const outcomeReasons: string[] = [];
    for (let i = 0; i < maxBatches; i += 1) {
      const results = await runSmartMoneyLightAnalyzeBatch();
      batches += 1;
      picked += results.length;
      passedTier1L += results.filter((row) => row.passedTier1L).length;
      failed += results.filter((row) => !row.success).length;
      for (const row of results) {
        if (row.outcomeReason) outcomeReasons.push(row.outcomeReason);
        else if (row.error) outcomeReasons.push(`tech:${row.error}`);
        // F6：淘汰与真正延后分列（L-DUAL-SHORT / 技术错误冷却 = deferred）
        if (row.outcomeReason === 'L-DUAL-SHORT' || (!row.success && !row.passedTier1L)) {
          deferred += 1;
        } else if (row.success && !row.passedTier1L) {
          eliminated += 1;
        }
      }
      if (results.length === 0) break;
    }
    console.log('[smart-money-pipeline] light batch finished', {
      trigger,
      picked,
      passedTier1L,
      failed,
      eliminated,
      deferred,
      batches,
    });
    const backlogAfter = await snapshotConsumableBacklog().catch(
      (): SmartMoneyBatchBacklog => ({})
    );
    const { bottleneck, backpressure } = inferPipelineBottleneck({
      stage: 'light',
      backlogBefore,
      backlogAfter,
      produced: passedTier1L,
      consumed:
        Number(backlogAfter.qualifiedGateReady ?? 0) -
        Number(backlogBefore.qualifiedGateReady ?? 0),
    });
    finishSmartMoneyBatchRun(run, {
      picked,
      succeeded: Math.max(0, picked - failed),
      failed,
      passed: passedTier1L,
      converted: passedTier1L,
      deferred,
      eliminated,
      reasonTop: aggregateReasonTop(outcomeReasons),
      backlogBefore,
      backlogAfter,
      bottleneck,
      backpressure,
      extras: { batches },
    });
    return { trigger, picked, passedTier1L, failed, batches };
  } finally {
    lightRunning = false;
  }
}

export async function runSmartMoneyPipelineDeepBatch(trigger = 'manual'): Promise<{
  trigger: string;
  picked: number;
  scored: number;
  inCopyPool: number;
  l1Rejected: number;
  failed: number;
  batches: number;
  profileSnapshotHits: number;
  profileLiveFetches: number;
} | null> {
  if (deepRunning) {
    console.warn('[smart-money-pipeline] deep batch skipped: already running', { trigger });
    finishSmartMoneyBatchRun(startSmartMoneyBatchRun('deep', trigger), {
      skipped: true,
      skipReason: 'already_running',
    });
    return null;
  }
  deepRunning = true;
  const run = startSmartMoneyBatchRun('deep', trigger);
  const backlogBefore = await snapshotConsumableBacklog().catch(
    (): SmartMoneyBatchBacklog => ({})
  );
  try {
    await recoverStaleAnalyzingStages();
    const maxBatches = CONFIG.smartMoneyBootstrapBatchesPerRun;
    let picked = 0;
    let scored = 0;
    let inCopyPool = 0;
    let failed = 0;
    let l1Rejected = 0;
    let batches = 0;
    let profileSnapshotHits = 0;
    let profileLiveFetches = 0;
    const l1Reasons: string[] = [];
    const blockedReasons: string[] = [];
    for (let i = 0; i < maxBatches; i += 1) {
      const results = await runSmartMoneyDeepAnalyzeBatch();
      batches += 1;
      picked += results.length;
      scored += results.filter((row) => row.scored).length;
      inCopyPool += results.filter((row) => row.inCopyPool).length;
      failed += results.filter((row) => !row.success).length;
      l1Rejected += results.filter((row) => row.success && !row.scored).length;
      profileSnapshotHits += results.filter((row) => row.profileSource === 'snapshot').length;
      profileLiveFetches += results.filter((row) => row.profileSource === 'live').length;
      for (const row of results) {
        if (row.l1FailReason) l1Reasons.push(row.l1FailReason);
        if (row.copyPoolBlockedReason) blockedReasons.push(row.copyPoolBlockedReason);
        if (row.error) l1Reasons.push(`tech:${row.error}`);
      }
      if (results.length === 0) break;
    }
    console.log('[smart-money-pipeline] deep batch finished', {
      trigger,
      picked,
      scored,
      inCopyPool,
      l1Rejected,
      failed,
      batches,
      profileSnapshotHits,
      profileLiveFetches,
    });
    const backlogAfter = await snapshotConsumableBacklog().catch(
      (): SmartMoneyBatchBacklog => ({})
    );
    const { bottleneck, backpressure } = inferPipelineBottleneck({
      stage: 'deep',
      backlogBefore,
      backlogAfter,
      produced: scored,
      consumed: inCopyPool,
    });
    finishSmartMoneyBatchRun(run, {
      picked,
      succeeded: Math.max(0, picked - failed),
      failed,
      deferred: l1Rejected,
      passed: scored,
      converted: inCopyPool,
      reasonTop: aggregateReasonTop([...l1Reasons, ...blockedReasons]),
      backlogBefore,
      backlogAfter,
      bottleneck,
      backpressure,
      extras: {
        batches,
        scored,
        inCopyPool,
        l1Rejected,
        profileSnapshotHits,
        profileLiveFetches,
      },
    });
    return {
      trigger,
      picked,
      scored,
      inCopyPool,
      l1Rejected,
      failed,
      batches,
      profileSnapshotHits,
      profileLiveFetches,
    };
  } finally {
    deepRunning = false;
  }
}

export async function getSmartMoneyPipelineStats(): Promise<{
  stages: Record<string, number>;
  copyPoolApiTotal: number;
  scoreCacheTotal: number;
  copyPoolEntered24h: number;
  copyPoolExited24h: number;
  rawActive: number;
  gammaEnrichmentPending: number;
  curveEnrichmentPending: number;
  enrichPending: number;
  /** 榜前待三情景 Copy（enrichPending 且未入池） */
  copyAwaitingReady: number;
  eliminatedTotal: number;
  elimReady: number;
  elimFrozen: number;
  copyPoolRescoreDue: number;
  rankModelEnabled: boolean;
  rankScorePopulated: number;
  scoreVersion: string;
  copyPoolEnterScore: number;
  copyPoolExitScore: number;
  /** QUALIFIED 且已到可再 Deep 的时间 */
  qualifiedDeepReady: number;
  /** QUALIFIED 但 nextDeepAnalyzeAt 未到（多为冷却） */
  qualifiedDeepCooling: number;
  lightRunning: boolean;
  deepRunning: boolean;
  /** Phase F：Light 是否 HTML-only */
  lightHtmlOnly: boolean;
  qualifiedMaxActive: number;
  qualifiedOverCap: number;
  scoredActive: number;
  scoredMaxActive: number;
  scoredMaxMiss: number;
  qualifiedReadyRatio: number;
  qualifiedReadyLatencyP50Sec: number;
  qualifiedReadyLatencyP90Sec: number;
  inCopyPoolNotRankedCount: number;
  rankFlushLagSec: number;
  gateReadyQualifiedCount: number;
  deepPicked30m: number;
  scorePass30m: number;
  enterRate30m: number;
  retryQueueCount: number;
  copyPoolRescoreMode: string;
  copyPoolDailyTopN: number;
  copyPoolPriorityDue: number;
  copyPoolBackgroundEligible: number;
  copyPoolTopnCompletedToday: number;
  copyPoolBgCursorLag: number;
  closedIncrementalHitRate: number | null;
  closedFullRebuildRate: number | null;
  closedIncrementalHit: number;
  closedFullRebuild: number;
  gateCappedSeen: number;
  deepRescorePriorityPicked: number;
  deepRescoreBackgroundPicked: number;
  approxRankAssigned: number;
  copyPoolSlaBreachedToday: boolean;
  /** 真正可消费库存（Light due / Gate missing|ready / Deep executable / SCORED 待入榜） */
  rawDue: number;
  qualifiedGateMissing: number;
  qualifiedGateReady: number;
  deepExecutable: number;
  scoredAwaitingEntry: number;
  scoredAll?: number;
  scoredDue?: number;
  /** 近 30 分钟粗吞吐（生产/消费近似） */
  lightProduced30m: number;
  gateReadyProduced30m: number;
  deepConsumed30m: number;
  copyPoolEntered30m: number;
  recentBatches: Array<Record<string, unknown>>;
}> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since30m = new Date(Date.now() - 30 * 60 * 1000);
  const now = new Date();
  const [
    stages,
    copyPoolApiTotal,
    scoreCacheTotal,
    copyPoolEntered24h,
    copyPoolExited24h,
    rawActive,
    gammaEnrichmentPending,
    curveEnrichmentPending,
    enrichPending,
    copyAwaitingReady,
    eliminatedTotal,
    elimReady,
    elimFrozen,
    copyPoolRescoreDue,
    rankScorePopulated,
    qualifiedDeepReady,
    qualifiedDeepCooling,
    qualifiedOverCap,
    scoredActive,
    scoredDue,
    inCopyPoolNotRankedCount,
    deepPicked30m,
    scorePass30m,
    lightProduced30m,
    copyPoolEntered30m,
    retryQueueCount,
    rawDue,
    gateReadyProduced30m,
  ] = await Promise.all([
    getPipelineStageCounts(),
    countCachedApiSmartMoneyLeaderboardRows(),
    prisma.smartMoneyScoreCache.count(),
    prisma.smartMoneyLeaderboardRow.count({
      where: { copyPoolEnteredAt: { gte: since24h } },
    }),
    prisma.smartMoneyLeaderboardRow.count({
      where: { copyPoolExitedAt: { gte: since24h } },
    }),
    prisma.smartMoneyRawAddress.count({
      where: rawPoolActiveWhere,
    }),
    countPendingGammaEnrichment(),
    countPendingCurveEnrichment(),
    prisma.smartMoneyLeaderboardRow.count({
      where: { enrichPending: true },
    }),
    prisma.smartMoneyLeaderboardRow.count({
      where: { inCopyPool: false, enrichPending: true },
    }),
    prisma.smartMoneyRawAddress.count({
      where: { pipelineStage: 'ELIMINATED' },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'ELIMINATED',
        dormant: false,
        AND: [
          { OR: [{ elimFrozenUntil: null }, { elimFrozenUntil: { lte: now } }] },
          { OR: [{ nextElimCheckAt: null }, { nextElimCheckAt: { lte: now } }] },
        ],
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'ELIMINATED',
        elimFrozenUntil: { gt: now },
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'COPY_POOL',
        dormant: false,
        OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],
      },
    }),
    prisma.smartMoneyLeaderboardRow.count({
      where: { inCopyPool: true, rankScore: { not: null } },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'QUALIFIED',
        dormant: false,
        OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'QUALIFIED',
        dormant: false,
        nextDeepAnalyzeAt: { gt: now },
      },
    }),
    countQualifiedOverCap(),
    countScoredActive(),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'SCORED',
        dormant: false,
        OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],
      },
    }),
    prisma.smartMoneyLeaderboardRow.count({
      where: { inCopyPool: true, rank: null },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        lastDeepQueuedAt: { gte: since30m },
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        tier1fPassedAt: { gte: since30m },
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        tier1lPassedAt: { gte: since30m },
      },
    }),
    prisma.smartMoneyLeaderboardRow.count({
      where: { copyPoolEnteredAt: { gte: since30m } },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: { in: ['QUALIFIED', 'SCORED', 'COPY_POOL'] },
        nextDeepAnalyzeAt: { gt: now },
        tierFailReason: { startsWith: 'data_fetch:' },
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        ...rawPoolActiveWhere,
        pipelineStage: 'RAW',
        OR: [{ nextLightAnalyzeAt: null }, { nextLightAnalyzeAt: { lte: now } }],
      },
    }),
    prisma.smartMoneyClosedSnapshot.count({
      where: {
        purpose: 'GATE',
        windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
        status: 'READY',
        readyAt: { gte: since30m },
      },
    }),
  ]);
  const [gateReadyQualifiedRow] = await prisma.$queryRaw<Array<{ cnt: bigint }>>`
    SELECT COUNT(*)::bigint AS cnt
    FROM "SmartMoneyRawAddress" ra
    WHERE ra."pipelineStage" = 'QUALIFIED'
      AND ra.dormant = false
      AND EXISTS (
        SELECT 1
        FROM "SmartMoneyClosedSnapshot" s
        WHERE s.wallet = ra.wallet
          AND s.purpose = 'GATE'
          AND s.status = 'READY'
          AND s."expiresAt" > NOW()
          AND s."windowDays" = ${SMART_MONEY_PNL_WINDOW_DAYS}
      )
  `;
  const gateReadyQualifiedCount = Number(gateReadyQualifiedRow?.cnt ?? 0);

  const [readyLatencyRow] = await prisma.$queryRaw<
    Array<{ p50_sec: number | null; p90_sec: number | null }>
  >`
    WITH ready_wallets AS (
      SELECT DISTINCT s.wallet
      FROM "SmartMoneyClosedSnapshot" s
      WHERE s."windowDays" = ${SMART_MONEY_PNL_WINDOW_DAYS}
        AND s.status = 'READY'
        AND s."expiresAt" > NOW()
        AND s.purpose IN ('GATE', 'FULL')
    ),
    qualified_base AS (
      SELECT ra.wallet, ra."updatedAt"
      FROM "SmartMoneyRawAddress" ra
      WHERE ra."pipelineStage" = 'QUALIFIED'
        AND ra.dormant = false
    )
    SELECT
      percentile_disc(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (NOW() - qb."updatedAt"))
      )::float8 AS p50_sec,
      percentile_disc(0.9) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (NOW() - qb."updatedAt"))
      )::float8 AS p90_sec
    FROM qualified_base qb
    INNER JOIN ready_wallets rw ON rw.wallet = qb.wallet
  `;

  const qualifiedTotal = qualifiedDeepReady + qualifiedDeepCooling;
  const qualifiedReadyRatio = qualifiedTotal > 0 ? qualifiedDeepReady / qualifiedTotal : 0;
  const enterRate30m = deepPicked30m > 0 ? copyPoolEntered30m / deepPicked30m : 0;
  const dualChannel = await getCopyPoolDualChannelStats().catch(() => null);
  const metrics = getCopyPoolRescoreMetricSnapshot();
  const topN = dualChannel?.dailyTopN ?? CONFIG.smartMoneyCopyPoolDailyTopN;
  const topNRows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: {
      inCopyPool: true,
      rank: { gte: 1, lte: topN },
    },
    select: { lastScoredAt: true },
  });
  const copyPoolTopnCompletedToday = topNRows.filter((r) =>
    isScoredOnBusinessDay(r.lastScoredAt)
  ).length;
  const slaMeta = await getDiscoveryCursor(COPY_POOL_SLA_ALERT_SOURCE).catch(() => null);
  const copyPoolSlaBreachedToday =
    slaMeta?.meta != null &&
    typeof slaMeta.meta === 'object' &&
    (slaMeta.meta as { dayKey?: string; alerted?: boolean }).dayKey === businessDayKey() &&
    (slaMeta.meta as { alerted?: boolean }).alerted === true;

  return {
    stages,
    copyPoolApiTotal,
    scoreCacheTotal,
    copyPoolEntered24h,
    copyPoolExited24h,
    rawActive,
    gammaEnrichmentPending,
    curveEnrichmentPending,
    enrichPending,
    copyAwaitingReady,
    eliminatedTotal,
    elimReady,
    elimFrozen,
    copyPoolRescoreDue,
    rankModelEnabled: isRankModelActive(),
    rankScorePopulated,
    scoreVersion: CONFIG.smartMoneyScoreVersion,
    copyPoolEnterScore: CONFIG.smartMoneyCopyPoolEnterScore,
    copyPoolExitScore: CONFIG.smartMoneyCopyPoolExitScore,
    qualifiedDeepReady,
    qualifiedDeepCooling,
    lightRunning,
    deepRunning,
    lightHtmlOnly: CONFIG.smartMoneyLightHtmlOnly,
    qualifiedMaxActive: CONFIG.smartMoneyQualifiedMaxActive,
    qualifiedOverCap,
    scoredActive,
    scoredMaxActive: CONFIG.smartMoneyScoredMaxActive,
    scoredMaxMiss: CONFIG.smartMoneyScoredMaxMiss,
    qualifiedReadyRatio,
    qualifiedReadyLatencyP50Sec: Math.round(readyLatencyRow?.p50_sec ?? 0),
    qualifiedReadyLatencyP90Sec: Math.round(readyLatencyRow?.p90_sec ?? 0),
    inCopyPoolNotRankedCount,
    rankFlushLagSec: getSmartMoneyRankFlushLagSec(),
    gateReadyQualifiedCount,
    deepPicked30m,
    scorePass30m,
    enterRate30m,
    retryQueueCount,
    copyPoolRescoreMode: dualChannel?.mode ?? CONFIG.smartMoneyCopyPoolRescoreMode,
    copyPoolDailyTopN: topN,
    copyPoolPriorityDue: dualChannel?.priorityDue ?? 0,
    copyPoolBackgroundEligible: dualChannel?.backgroundEligible ?? 0,
    copyPoolTopnCompletedToday,
    copyPoolBgCursorLag: dualChannel?.backgroundEligible ?? 0,
    closedIncrementalHitRate: metrics.incrementalHitRate,
    closedFullRebuildRate: metrics.fullRebuildRate,
    closedIncrementalHit: metrics.incrementalHit,
    closedFullRebuild: metrics.fullRebuild,
    gateCappedSeen: metrics.gateCappedSeen,
    deepRescorePriorityPicked: metrics.priorityPicked,
    deepRescoreBackgroundPicked: metrics.backgroundPicked,
    approxRankAssigned: metrics.approxRankAssigned,
    copyPoolSlaBreachedToday,
    rawDue,
    qualifiedGateMissing: Math.max(0, (stages.QUALIFIED ?? 0) - gateReadyQualifiedCount),
    qualifiedGateReady: gateReadyQualifiedCount,
    deepExecutable: gateReadyQualifiedCount,
    scoredAwaitingEntry: scoredDue,
    scoredAll: stages.SCORED ?? 0,
    scoredDue,
    lightProduced30m,
    gateReadyProduced30m,
    deepConsumed30m: deepPicked30m,
    copyPoolEntered30m,
    recentBatches: getRecentSmartMoneyBatchSummaries(12),
  };
}

export { runSmartMoneyGammaEnrichmentBatch, runSmartMoneyCurveEnrichmentBatch };

/** 兼容旧调用名；周期调度只执行 Light，Deep 由独立 cron 负责。 */
export async function runSmartMoneyPipelineTick(trigger = 'manual'): Promise<void> {
  await runSmartMoneyPipelineLightBatch(`${trigger}:light`);
}
