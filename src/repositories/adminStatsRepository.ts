import { Prisma } from '../generated/prisma/client';
import { prisma } from '../db';
import { ADMIN_STATS_PERIOD, type AdminStatKey } from '../services/adminDashboard/types';

export async function upsertStatSnapshot(
  statKey: AdminStatKey | string,
  statValue: string,
  statExtra?: Prisma.InputJsonValue
): Promise<void> {
  await prisma.adminStatsSnapshot.upsert({
    where: {
      statKey_period: { statKey, period: ADMIN_STATS_PERIOD },
    },
    create: {
      statKey,
      statValue,
      period: ADMIN_STATS_PERIOD,
      statExtra: statExtra ?? undefined,
    },
    update: {
      statValue,
      statExtra: statExtra ?? undefined,
    },
  });
}

export async function getStatSnapshotMap(
  period = ADMIN_STATS_PERIOD
): Promise<Map<string, string>> {
  const rows = await prisma.adminStatsSnapshot.findMany({
    where: { period },
    select: { statKey: true, statValue: true },
  });
  return new Map(rows.map((r) => [r.statKey, r.statValue]));
}

export async function upsertRuntimeStatus(
  statusKey: string,
  statusValue: string,
  statusExtra?: Prisma.InputJsonValue
): Promise<void> {
  await prisma.systemRuntimeStatus.upsert({
    where: { statusKey },
    create: { statusKey, statusValue, statusExtra: statusExtra ?? undefined },
    update: { statusValue, statusExtra: statusExtra ?? undefined },
  });
}

export async function getRuntimeStatusMap(): Promise<Map<string, string>> {
  const rows = await prisma.systemRuntimeStatus.findMany({
    select: { statusKey: true, statusValue: true, statusExtra: true },
  });
  return new Map(rows.map((r) => [r.statusKey, r.statusValue]));
}

export async function getRuntimeStatusExtra(statusKey: string): Promise<Prisma.JsonValue | null> {
  const row = await prisma.systemRuntimeStatus.findUnique({
    where: { statusKey },
    select: { statusExtra: true },
  });
  return row?.statusExtra ?? null;
}

export async function getDailyStatByDate(statDate: Date) {
  return prisma.adminDailyStat.findUnique({
    where: { statDate },
  });
}

export async function listDailyStatsSince(sinceDate: Date) {
  return prisma.adminDailyStat.findMany({
    where: { statDate: { gte: sinceDate } },
    orderBy: { statDate: 'asc' },
  });
}

export async function countTodayNewUsers(dayStartUtc: Date): Promise<number> {
  return prisma.user.count({
    where: { createdAt: { gte: dayStartUtc } },
  });
}

export type LeaderPerformanceRow = {
  leaderAddress: string;
  roi: Prisma.Decimal;
  winRate: Prisma.Decimal;
  followersCount: number;
  copyVolume: Prisma.Decimal | null;
  riskLevel: string;
};

export async function listTopLeaderPerformanceRows(period = '30d', limit = 30): Promise<LeaderPerformanceRow[]> {
  return prisma.leaderPerformanceStat.findMany({
    where: { period },
    orderBy: { roi: 'desc' },
    take: limit,
    select: {
      leaderAddress: true,
      roi: true,
      winRate: true,
      followersCount: true,
      copyVolume: true,
      riskLevel: true,
    },
  });
}

export async function listRecentActivitiesDetailed(limit = 50) {
  return prisma.adminActivityLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      eventType: true,
      title: true,
      content: true,
      level: true,
      metadata: true,
      createdAt: true,
    },
  });
}

export async function listRecentActivities(limit = 20) {
  return prisma.adminActivityLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      eventType: true,
      title: true,
      level: true,
      createdAt: true,
    },
  });
}

export async function countOpenAlerts(): Promise<number> {
  return prisma.adminAlert.count({ where: { status: 'open' } });
}

export async function fetchLeaderEnrichment(addresses: string[]) {
  if (addresses.length === 0) {
    return {
      leaderIdByAddress: new Map<string, string>(),
      displayNameByAddress: new Map<string, string>(),
      verifiedByAddress: new Map<string, boolean>(),
    };
  }
  const normalized = addresses.map((a) => a.toLowerCase());
  const [leaders, smartRows] = await Promise.all([
    prisma.copyLeader.findMany({
      where: { address: { in: normalized, mode: 'insensitive' } },
      select: { id: true, address: true },
    }),
    prisma.smartMoneyLeaderboardRow.findMany({
      where: { wallet: { in: normalized, mode: 'insensitive' } },
      select: {
        wallet: true,
        displayName: true,
        xUsername: true,
        eligible: true,
        predictionCount: true,
      },
    }),
  ]);

  const leaderIdByAddress = new Map<string, string>();
  for (const row of leaders) {
    leaderIdByAddress.set(row.address.toLowerCase(), row.id);
  }

  const displayNameByAddress = new Map<string, string>();
  const verifiedByAddress = new Map<string, boolean>();
  for (const row of smartRows) {
    const addr = row.wallet.toLowerCase();
    const name = row.displayName?.trim() || row.xUsername?.trim() || '';
    if (name) {
      displayNameByAddress.set(addr, name);
    }
    verifiedByAddress.set(addr, Boolean(row.xUsername?.trim()) || row.eligible);
  }

  return { leaderIdByAddress, displayNameByAddress, verifiedByAddress };
}
