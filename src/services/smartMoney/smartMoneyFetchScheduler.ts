import { prisma } from '../../db';

import { CONFIG } from '../../config/env';

import { isStrongReviveSource } from './smartMoneyEliminated';

import { allocateSmartMoneyDeepSlots } from './smartMoneyDeepSlotAllocation';

import { SMART_MONEY_PNL_WINDOW_DAYS } from './smartMoneyPositionStats';

import {
  countPriorityTopNDue,
  isDualChannelRescoreMode,
  pickCopyPoolRescoreSlots,
  recordDailyRescoreMeta,
} from './smartMoneyCopyPoolRescoreChannels';



function dedupeWallets(wallets: string[]): string[] {

  const seen = new Set<string>();

  const out: string[] = [];

  for (const wallet of wallets) {

    const normalized = wallet.toLowerCase();

    if (seen.has(normalized)) continue;

    seen.add(normalized);

    out.push(normalized);

  }

  return out;

}



function lightBoardPriorityShare(): number {

  if (CONFIG.smartMoneyDiscoveryBootstrapBoard) {

    return CONFIG.smartMoneyLightBootstrapBoardShare;

  }

  return 0.6;

}



async function pickStarvedLight(limit: number, exclude: ReadonlySet<string>): Promise<string[]> {

  const starvationSince = new Date(Date.now() - CONFIG.smartMoneyStarvationMs);
  const excludedWallets = [...exclude];

  const rows = await prisma.smartMoneyRawAddress.findMany({

    where: {

      dormant: false,

      pipelineStage: { in: ['RAW', 'LIGHT_ANALYZING'] },

      ...(excludedWallets.length > 0 ? { wallet: { notIn: excludedWallets } } : {}),

      OR: [{ lastLightQueuedAt: null }, { lastLightQueuedAt: { lt: starvationSince } }],

    },

    orderBy: [{ lastLightQueuedAt: { sort: 'asc', nulls: 'first' } }, { lastSeenAt: 'desc' }],

    take: limit,

    select: { wallet: true },

  });

  return rows.slice(0, limit).map((row) => row.wallet);

}



async function pickStarvedDeep(
  stages: string[],
  limit: number,
  exclude: ReadonlySet<string> = new Set()
): Promise<string[]> {

  const starvationSince = new Date(Date.now() - CONFIG.smartMoneyStarvationMs);
  const now = new Date();
  const excludedWallets = [...exclude];

  const orderBy =

    stages.length === 1 && stages[0] === 'QUALIFIED'

      ? ([

          { lastDeepQueuedAt: { sort: 'asc' as const, nulls: 'first' as const } },

          { lastSeenAt: 'desc' as const },

        ] as const)

      : ([

          { lastDeepQueuedAt: { sort: 'asc' as const, nulls: 'first' as const } },

          { lastSeenAt: 'desc' as const },

        ] as const);



  const rows = await prisma.smartMoneyRawAddress.findMany({

    where: {

      dormant: false,

      pipelineStage: { in: stages },

      ...(excludedWallets.length > 0 ? { wallet: { notIn: excludedWallets } } : {}),

      AND: [
        { OR: [{ lastDeepQueuedAt: null }, { lastDeepQueuedAt: { lt: starvationSince } }] },
        { OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }] },
      ],

    },

    orderBy: [...orderBy],

    take: limit * 3,

    select: { wallet: true },

  });

  return rows.slice(0, limit).map((row) => row.wallet);

}



async function pickFairLight(limit: number, exclude: ReadonlySet<string>): Promise<string[]> {

  const cursorRow = await prisma.smartMoneyPipelineCursor.findUnique({ where: { id: 1 } });

  const cursor = cursorRow?.lightRoundRobinCounter ?? BigInt(0);

  const now = new Date();
  const excludedWallets = [...exclude];

  const baseWhere = {

    dormant: false,

    pipelineStage: { in: ['RAW'] },

    ...(excludedWallets.length > 0 ? { wallet: { notIn: excludedWallets } } : {}),

    OR: [{ nextLightAnalyzeAt: null }, { nextLightAnalyzeAt: { lte: now } }],

  };



  const rows = await prisma.smartMoneyRawAddress.findMany({

    where: { ...baseWhere, lightAnalyzeCursor: { gte: cursor } },

    orderBy: [{ lightAnalyzeCursor: 'asc' }, { lastSeenAt: 'desc' }],

    take: limit,

    select: { wallet: true },

  });

  if (rows.length >= limit) return rows.map((row) => row.wallet);



  const wrap = await prisma.smartMoneyRawAddress.findMany({

    where: baseWhere,

    orderBy: [{ lightAnalyzeCursor: 'asc' }, { lastSeenAt: 'desc' }],

    take: limit,

    select: { wallet: true },

  });

  return dedupeWallets([...rows, ...wrap].map((row) => row.wallet)).slice(0, limit);

}



/** 榜源优先插队（LEADERBOARD*）：按源条件查库，禁止 lastSeen 小窗过滤（F2） */
async function pickBoardPriorityLight(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const now = new Date();
  const rows = await prisma.$queryRaw<Array<{ wallet: string }>>`
    SELECT ra.wallet
    FROM "SmartMoneyRawAddress" ra
    WHERE ra.dormant = false
      AND ra."pipelineStage" = 'RAW'
      AND (ra."nextLightAnalyzeAt" IS NULL OR ra."nextLightAnalyzeAt" <= ${now})
      AND EXISTS (
        SELECT 1
        FROM unnest(ra.sources) AS src
        WHERE upper(src) LIKE '%LEADERBOARD%'
      )
    ORDER BY ra."lastLightQueuedAt" ASC NULLS FIRST, ra."lastSeenAt" DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows.map((row) => row.wallet);
}



/** 非榜强信号（BLOCK_SCAN / ADMIN / MANUAL）：按源查库，避免 lastSeen 小窗饿死（F2） */
async function pickScanPriorityLight(limit: number, exclude: Set<string>): Promise<string[]> {
  if (limit <= 0) return [];
  const now = new Date();
  const rows = await prisma.$queryRaw<Array<{ wallet: string; sources: string[] }>>`
    SELECT ra.wallet, ra.sources
    FROM "SmartMoneyRawAddress" ra
    WHERE ra.dormant = false
      AND ra."pipelineStage" = 'RAW'
      AND (ra."nextLightAnalyzeAt" IS NULL OR ra."nextLightAnalyzeAt" <= ${now})
      AND EXISTS (
        SELECT 1
        FROM unnest(ra.sources) AS src
        WHERE upper(src) LIKE '%BLOCK_SCAN%'
           OR upper(src) LIKE '%ADMIN%'
           OR upper(src) LIKE '%MANUAL%'
           OR upper(src) LIKE 'REVIVE|%'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(ra.sources) AS src
        WHERE upper(src) LIKE '%LEADERBOARD%'
      )
    ORDER BY ra."lastSeenAt" DESC NULLS LAST
    LIMIT ${Math.max(limit * 5, limit)}
  `;
  const out: string[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    if (exclude.has(row.wallet.toLowerCase())) continue;
    const sources = row.sources ?? [];
    if (
      sources.some(
        (source) => isStrongReviveSource(source) && !source.toUpperCase().includes('LEADERBOARD')
      )
    ) {
      out.push(row.wallet);
    }
  }
  return out;
}



async function pickFairDeep(
  stages: string[],
  limit: number,
  exclude: ReadonlySet<string> = new Set()
): Promise<string[]> {

  const cursorRow = await prisma.smartMoneyPipelineCursor.findUnique({ where: { id: 1 } });

  const cursor = cursorRow?.deepRoundRobinCounter ?? BigInt(0);

  const now = new Date();
  const excludedWallets = [...exclude];

  const baseWhere = {

    dormant: false,

    pipelineStage: { in: stages },

    ...(excludedWallets.length > 0 ? { wallet: { notIn: excludedWallets } } : {}),

    OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],

  };



  const orderBy =

    stages.length === 1 && stages[0] === 'QUALIFIED'

      ? ([
          { nextDeepAnalyzeAt: { sort: 'asc' as const, nulls: 'first' as const } },
          { lastDeepQueuedAt: { sort: 'asc' as const, nulls: 'first' as const } },
          { deepAnalyzeCursor: 'asc' as const },
          { lastSeenAt: 'desc' as const },
        ] as const)

      : ([{ deepAnalyzeCursor: 'asc' as const }, { lastSeenAt: 'desc' as const }] as const);



  const rows = await prisma.smartMoneyRawAddress.findMany({

    where: { ...baseWhere, deepAnalyzeCursor: { gte: cursor } },

    orderBy: [...orderBy],

    take: limit,

    select: { wallet: true },

  });

  if (rows.length >= limit) return rows.map((row) => row.wallet);



  const wrap = await prisma.smartMoneyRawAddress.findMany({

    where: baseWhere,

    orderBy: [...orderBy],

    take: limit,

    select: { wallet: true },

  });

  return dedupeWallets([...rows, ...wrap].map((row) => row.wallet)).slice(0, limit);

}



export async function pickLightAnalyzeBatch(limit = CONFIG.smartMoneyLightFetchBatchSize): Promise<string[]> {

  const priorityLimit = Math.min(CONFIG.smartMoneyLightPriorityBatchSlots, limit);

  const boardShare = lightBoardPriorityShare();

  const boardLimit = Math.min(priorityLimit, Math.max(0, Math.ceil(priorityLimit * boardShare)));

  const scanLimit = Math.max(0, priorityLimit - boardLimit);



  const board = await pickBoardPriorityLight(boardLimit);

  const boardSet = new Set(board.map((w) => w.toLowerCase()));

  const scan =

    scanLimit > 0 ? await pickScanPriorityLight(scanLimit, boardSet) : [];



  const priority = dedupeWallets([...board, ...scan]);

  const remainder = Math.max(0, limit - priority.length);

  const starvedLimit = Math.max(0, Math.ceil(remainder * CONFIG.smartMoneyStarvationBatchShare));

  const picked = new Set(priority);

  const starved = await pickStarvedLight(starvedLimit, picked);

  for (const wallet of starved) picked.add(wallet.toLowerCase());

  const fair = await pickFairLight(Math.max(0, limit - picked.size), picked);

  return [...priority, ...starved, ...fair].slice(0, limit);

}



async function countExecutableQualified(now: Date): Promise<number> {
  if (!CONFIG.smartMoneyClosedPrefetchEnabled || !CONFIG.smartMoneyDeepRequireClosedSnapshot) {
    return prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'QUALIFIED',
        dormant: false,
        OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],
      },
    });
  }

  const rows = await prisma.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "SmartMoneyRawAddress" ra
    WHERE ra."pipelineStage" = 'QUALIFIED'
      AND ra.dormant = false
      AND (ra."nextDeepAnalyzeAt" IS NULL OR ra."nextDeepAnalyzeAt" <= ${now})
      AND EXISTS (
        SELECT 1
        FROM "SmartMoneyClosedSnapshot" cs
        WHERE cs.wallet = ra.wallet
          AND cs.purpose = 'GATE'
          AND cs.status = 'READY'
          AND cs."expiresAt" > ${now}
          AND cs."windowDays" = ${SMART_MONEY_PNL_WINDOW_DAYS}
          AND (
            cs."windowComplete" = true
            OR cs."pageCount" >= GREATEST(1, cs."targetMaxPages")
          )
      )
  `;
  return Number(rows[0]?.count ?? 0);
}



export async function pickDeepAnalyzeBatch(limit = CONFIG.smartMoneyDeepFetchBatchSize): Promise<string[]> {

  const now = new Date();

  let refreshShare = CONFIG.smartMoneyCopyPoolRefreshBatchShare;

  const [qualifiedReady, scoredDue] = await Promise.all([
    countExecutableQualified(now),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'SCORED',
        dormant: false,
        OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],
      },
    }),
  ]);

  if (qualifiedReady > CONFIG.smartMoneyQualifiedDeepReadyPressure) {

    // 高压时仍至少保留 1 个 background 槽，避免 floor(limit * share) 变成 0。
    refreshShare = Math.max(0.1, refreshShare - 0.15);

  }

  // dual_channel：TopN 日欠债时临时抬高复评份额（仍受 QUALIFIED 地板约束）
  let priorityDue = 0;
  if (isDualChannelRescoreMode()) {
    priorityDue = await countPriorityTopNDue(now);
    if (priorityDue > 0) {
      refreshShare = Math.max(refreshShare, CONFIG.smartMoneyCopyPoolPriorityRefreshShare);
    }
    void recordDailyRescoreMeta({ priorityDue });
  }



  // QUALIFIED 硬配额与 CopyPool 复评分轨：普通 pipeline 槽禁止再混入 COPY_POOL。
  const slots = allocateSmartMoneyDeepSlots({
    limit,
    qualifiedDue: qualifiedReady,
    scoredDue,
    scoredReservedSlots: CONFIG.smartMoneyScoredBatchReservedSlots,
    minQualifiedShare: CONFIG.smartMoneyDeepMinQualifiedBatchShare,
    refreshShare,
  });

  const refreshWallets =
    slots.refreshSlots > 0 ? await pickCopyPoolStaleRefresh(slots.refreshSlots) : [];
  const selected = new Set(refreshWallets.map((wallet) => wallet.toLowerCase()));

  const qualifiedWallets =
    slots.qualifiedSlots > 0
      ? await pickDeepAnalyzeBatchForStages(
          ['QUALIFIED'],
          slots.qualifiedSlots,
          selected
        )
      : [];
  for (const wallet of qualifiedWallets) selected.add(wallet.toLowerCase());

  // QUALIFIED 数量不足时才允许到期 SCORED 补位；COPY_POOL 只走 refresh 通道。
  const scoredWallets =
    slots.scoredSlots > 0
      ? await pickDeepAnalyzeBatchForStages(
          ['SCORED'],
          slots.scoredSlots,
          selected
        )
      : [];
  for (const wallet of scoredWallets) selected.add(wallet.toLowerCase());

  // 某通道因并发变化或实际缺货少取时，优先用更多到期 SCORED 填满，避免批次空槽。
  const selectedCount = dedupeWallets([
    ...refreshWallets,
    ...qualifiedWallets,
    ...scoredWallets,
  ]).length;
  const overflowScoredWallets =
    selectedCount < limit
      ? await pickDeepAnalyzeBatchForStages(
          ['SCORED'],
          limit - selectedCount,
          selected
        )
      : [];

  return dedupeWallets([
    ...refreshWallets,
    ...qualifiedWallets,
    ...scoredWallets,
    ...overflowScoredWallets,
  ]).slice(0, limit);

}



/**
 * CopyPool 存量复核：
 * - dual_channel：TopN 日更抢占 + 非 TopN cursor 轮转
 * - legacy：最旧优先 + nextDeepAnalyzeAt 分层冷却
 */

async function pickCopyPoolStaleRefresh(limit: number): Promise<string[]> {

  if (limit <= 0) return [];

  if (isDualChannelRescoreMode()) {
    const picked = await pickCopyPoolRescoreSlots(limit);
    return picked.wallets;
  }

  const now = new Date();

  const rows = await prisma.smartMoneyRawAddress.findMany({

    where: {

      dormant: false,

      pipelineStage: 'COPY_POOL',

      OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],

    },

    orderBy: [

      { lastDeepQueuedAt: { sort: 'asc', nulls: 'first' } },

      { lastSeenAt: 'desc' },

    ],

    take: limit,

    select: { wallet: true },

  });

  return rows.map((row) => row.wallet);

}



async function pickDeepAnalyzeBatchForStages(
  stages: string[],
  limit: number,
  exclude: ReadonlySet<string> = new Set()
): Promise<string[]> {

  const starvedLimit = Math.max(1, Math.ceil(limit * CONFIG.smartMoneyStarvationBatchShare));

  const starved = await pickStarvedDeep(stages, starvedLimit, exclude);
  const fairExclude = new Set(exclude);
  for (const wallet of starved) fairExclude.add(wallet.toLowerCase());

  const fair = await pickFairDeep(
    stages,
    Math.max(0, limit - starved.length),
    fairExclude
  );

  return dedupeWallets([...starved, ...fair]).slice(0, limit);

}



export async function markLightQueued(wallets: string[]): Promise<void> {

  const now = new Date();

  if (wallets.length === 0) return;

  await prisma.smartMoneyRawAddress.updateMany({

    where: { wallet: { in: wallets } },

    data: { lastLightQueuedAt: now, pipelineStage: 'LIGHT_ANALYZING' },

  });

}



/** 标记 Deep 排队；返回各钱包进入 FULL 前的 stage，供失败回滚。 */

export async function markDeepQueued(wallets: string[]): Promise<Map<string, string>> {

  const previous = new Map<string, string>();

  if (wallets.length === 0) return previous;



  const rows = await prisma.smartMoneyRawAddress.findMany({

    where: { wallet: { in: wallets } },

    select: { wallet: true, pipelineStage: true },

  });

  for (const row of rows) {

    previous.set(row.wallet.toLowerCase(), row.pipelineStage);

  }



  const now = new Date();

  await prisma.smartMoneyRawAddress.updateMany({

    where: { wallet: { in: wallets } },

    data: { lastDeepQueuedAt: now, pipelineStage: 'FULL_ANALYZING' },

  });

  return previous;

}



/** 将卡在 FULL_ANALYZING 的地址纳入 Deep 调度（失败回滚遗漏时的自愈）。 */

export function deepPickStagesWithRecovery(baseStages: string[]): string[] {

  return [...new Set([...baseStages, 'FULL_ANALYZING'])];

}


