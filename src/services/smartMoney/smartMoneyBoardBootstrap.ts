import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { hasLeaderboardSource } from './smartMoneyRawSource';

/** 榜源 RAW 且尚未完成 Light（tier1l）的活跃地址数 */
export async function countBoardLightBacklog(): Promise<number> {
  const rows = await prisma.smartMoneyRawAddress.findMany({
    where: {
      dormant: false,
      pipelineStage: 'RAW',
      tier1lPassedAt: null,
    },
    select: { wallet: true, sources: true },
    take: 50_000,
  });
  return rows.filter((row) => hasLeaderboardSource(row.sources)).length;
}

/**
 * Bootstrap：批量 bump 榜 backlog 的 Light 调度（限频防 DB 尖峰）。
 */
export async function bumpBoardBacklogLightQueue(): Promise<number> {
  if (!CONFIG.smartMoneyDiscoveryBootstrapBoard) return 0;

  const max = CONFIG.smartMoneyBoardBacklogBumpMax;
  if (max <= 0) return 0;

  const rows = await prisma.smartMoneyRawAddress.findMany({
    where: {
      dormant: false,
      pipelineStage: 'RAW',
      tier1lPassedAt: null,
    },
    orderBy: [{ lastSeenAt: 'desc' }],
    take: Math.min(max * 3, 15_000),
    select: { wallet: true, sources: true },
  });

  const wallets = rows
    .filter((row) => hasLeaderboardSource(row.sources))
    .slice(0, max)
    .map((row) => row.wallet);

  if (wallets.length === 0) return 0;

  const now = new Date();
  await prisma.smartMoneyRawAddress.updateMany({
    where: { wallet: { in: wallets } },
    data: { nextLightAnalyzeAt: now, dormant: false },
  });
  return wallets.length;
}
