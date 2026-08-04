import { prisma } from '../../db';

export type LeaderboardPreset = {
  category: string;
  timePeriod: string;
  orderBy: string;
};

export const OFFICIAL_LEADERBOARD_PERIODS = ['WEEK', 'MONTH', 'ALL'] as const;
export const OFFICIAL_LEADERBOARD_CATEGORIES = [
  'OVERALL',
  'POLITICS',
  'SPORTS',
  'ESPORTS',
  'CRYPTO',
  'CULTURE',
  'MENTIONS',
  'WEATHER',
  'ECONOMICS',
  'TECH',
  'FINANCE',
] as const;

export type OfficialLeaderboardCategory = (typeof OFFICIAL_LEADERBOARD_CATEGORIES)[number];

type CompleteBatchCandidate = {
  batchId: string;
  syncedAt: Date;
  periods: Set<string>;
};

export async function listLatestCachedLeaderboardRows(preset: LeaderboardPreset) {
  const latest = await prisma.leaderboardRow.findFirst({
    where: preset,
    orderBy: [{ syncedAt: 'desc' }, { batchId: 'desc' }, { syncVersion: 'desc' }],
    select: {
      batchId: true,
      syncedAt: true,
      syncVersion: true,
    },
  });
  if (!latest) {
    return {
      batchId: null,
      syncedAt: null,
      syncVersion: null,
      rows: [] as Awaited<ReturnType<typeof prisma.leaderboardRow.findMany>>,
    };
  }

  const rows = await prisma.leaderboardRow.findMany({
    where: {
      ...preset,
      batchId: latest.batchId,
    },
    orderBy: { rank: 'asc' },
  });

  return {
    batchId: latest.batchId,
    syncedAt: latest.syncedAt,
    syncVersion: latest.syncVersion,
    rows,
  };
}

export async function getLatestCompleteOfficialLeaderboardBatch(
  category = 'OVERALL',
  orderBy = 'PNL'
): Promise<{ batchId: string; syncedAt: Date } | null> {
  const rows = await prisma.leaderboardRow.findMany({
    where: {
      category,
      orderBy,
      timePeriod: { in: [...OFFICIAL_LEADERBOARD_PERIODS] },
    },
    select: {
      batchId: true,
      syncedAt: true,
      timePeriod: true,
    },
    orderBy: [{ syncedAt: 'desc' }, { batchId: 'desc' }],
  });

  const requiredPeriods = new Set<string>(OFFICIAL_LEADERBOARD_PERIODS);
  const batches = new Map<string, CompleteBatchCandidate>();

  for (const row of rows) {
    const existing = batches.get(row.batchId) ?? {
      batchId: row.batchId,
      syncedAt: row.syncedAt,
      periods: new Set<string>(),
    };
    existing.periods.add(row.timePeriod);
    if (row.syncedAt > existing.syncedAt) {
      existing.syncedAt = row.syncedAt;
    }
    batches.set(row.batchId, existing);
  }

  for (const row of rows) {
    const batch = batches.get(row.batchId);
    if (!batch) continue;
    const isComplete = [...requiredPeriods].every((period) => batch.periods.has(period));
    if (isComplete) {
      return {
        batchId: batch.batchId,
        syncedAt: batch.syncedAt,
      };
    }
  }

  return null;
}

/** 读取最新官方榜批次全量行（无 TopN 截断；limit 参数忽略，保留签名兼容）。 */
export async function listLatestOfficialLeaderboardCandidateRows(_limit?: number) {
  void _limit;
  const latestBatch = await getLatestCompleteOfficialLeaderboardBatch();
  if (!latestBatch) {
    return {
      batchId: null,
      syncedAt: null,
      rows: [] as Array<{ proxyWallet: string; timePeriod: string; rank: number }>,
    };
  }

  const rows = await prisma.leaderboardRow.findMany({
    where: {
      category: 'OVERALL',
      orderBy: 'PNL',
      timePeriod: { in: [...OFFICIAL_LEADERBOARD_PERIODS] },
      batchId: latestBatch.batchId,
    },
    select: {
      proxyWallet: true,
      timePeriod: true,
      rank: true,
    },
    orderBy: [{ timePeriod: 'asc' }, { rank: 'asc' }],
  });

  return {
    batchId: latestBatch.batchId,
    syncedAt: latestBatch.syncedAt,
    rows,
  };
}

/** 读取各 category 最新批次全量行（无 TopN 截断）。 */
export async function listLatestOfficialLeaderboardCategoryCandidateRows(_limit?: number) {
  void _limit;
  const output: Array<{
    proxyWallet: string;
    category: OfficialLeaderboardCategory;
    timePeriod: string;
    rank: number;
  }> = [];

  for (const category of OFFICIAL_LEADERBOARD_CATEGORIES) {
    const latestBatch = await getLatestCompleteOfficialLeaderboardBatch(category);
    if (!latestBatch) continue;

    const rows = await prisma.leaderboardRow.findMany({
      where: {
        category,
        orderBy: 'PNL',
        timePeriod: { in: [...OFFICIAL_LEADERBOARD_PERIODS] },
        batchId: latestBatch.batchId,
      },
      select: {
        proxyWallet: true,
        timePeriod: true,
        rank: true,
      },
      orderBy: [{ timePeriod: 'asc' }, { rank: 'asc' }],
    });

    output.push(
      ...rows.map((row) => ({
        ...row,
        category,
      }))
    );
  }

  return { rows: output };
}

export async function getLatestOfficialLeaderboardIdentity(wallet: string): Promise<{
  batchId: string | null;
  syncedAt: Date | null;
  userName: string | null;
  xUsername: string | null;
  profileImage: string | null;
}> {
  const latestBatch = await getLatestCompleteOfficialLeaderboardBatch();
  if (!latestBatch) {
    return {
      batchId: null,
      syncedAt: null,
      userName: null,
      xUsername: null,
      profileImage: null,
    };
  }

  const rows = await prisma.leaderboardRow.findMany({
    where: {
      category: 'OVERALL',
      orderBy: 'PNL',
      timePeriod: { in: [...OFFICIAL_LEADERBOARD_PERIODS] },
      batchId: latestBatch.batchId,
      proxyWallet: wallet,
    },
    select: {
      userName: true,
      xUsername: true,
      profileImage: true,
      rank: true,
      timePeriod: true,
    },
    orderBy: [{ rank: 'asc' }, { timePeriod: 'asc' }],
  });

  return {
    batchId: latestBatch.batchId,
    syncedAt: latestBatch.syncedAt,
    userName: rows.find((row) => row.userName)?.userName ?? null,
    xUsername: rows.find((row) => row.xUsername)?.xUsername ?? null,
    profileImage: rows.find((row) => row.profileImage)?.profileImage ?? null,
  };
}
