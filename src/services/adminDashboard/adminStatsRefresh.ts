import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { getEffectiveSystemControl } from '../trading/tradingControl';
import {
  getRuntimeStatusMap,
  upsertRuntimeStatus,
  upsertStatSnapshot,
} from '../../repositories/adminStatsRepository';
import {
  getRobotControlNatsConnection,
  isRobotControlNatsEnabled,
} from '../../copyTrading/events/natsRobotControlClient';
import { ADMIN_STAT_KEYS, type AdminStatKey } from './types';
import {
  clampPercent,
  isAbnormalRoi,
  normalizeNodeStatus,
  resolveSyncStatus,
} from './adminDashboardUtils';

const processStartedAt = Date.now();
const processStartedAtIso = new Date(processStartedAt).toISOString();

function decimalSumToString(
  gas: { _sum: { commissionAmount: Prisma.Decimal | null } },
  mall: { _sum: { commissionAmount: Prisma.Decimal | null } }
): string {
  const g = gas._sum.commissionAmount ?? new Prisma.Decimal(0);
  const m = mall._sum.commissionAmount ?? new Prisma.Decimal(0);
  return g.plus(m).toFixed(2);
}

async function countRegisteredUsers(): Promise<number> {
  return prisma.user.count();
}

async function countWalletBoundUsers(): Promise<number> {
  return prisma.user.count({
    where: { wallets: { some: {} } },
  });
}

async function countActiveCopyTraders(): Promise<number> {
  return prisma.copySubscription.count({
    where: { enabled: true, deletedAt: null },
  });
}

async function countObservedTraders(): Promise<number> {
  const rows = await prisma.observedTrader.findMany({
    select: { wallet: true },
  });
  const unique = new Set(rows.map((r) => r.wallet.toLowerCase()));
  return unique.size;
}

async function countCopyExec24h(since: Date): Promise<number> {
  return prisma.copyTradeRow.count({
    where: { createdAt: { gte: since } },
  });
}

async function countFailedCopy24h(since: Date): Promise<number> {
  return prisma.copyTradeRow.count({
    where: {
      createdAt: { gte: since },
      status: { in: ['failed', 'dead'] },
    },
  });
}

async function countRiskBlocks24h(since: Date): Promise<number> {
  return prisma.riskEvent.count({
    where: { result: 'blocked', createdAt: { gte: since } },
  });
}

async function countGasPlans(): Promise<number> {
  return prisma.gasPackage.count({ where: { isActive: true } });
}

async function sumCommissionUsdt(): Promise<string> {
  const [gas, mall] = await Promise.all([
    prisma.gasCommission.aggregate({ _sum: { commissionAmount: true } }),
    prisma.mallOrderCommission.aggregate({ _sum: { commissionAmount: true } }),
  ]);
  return decimalSumToString(gas, mall);
}

async function countPendingPackageOrders(): Promise<number> {
  return prisma.gasPackageOrder.count({
    where: {
      OR: [
        { status: { in: ['PENDING', 'CREATED', 'UNPAID'] } },
        { status: { contains: 'pending', mode: 'insensitive' } },
      ],
    },
  });
}

async function countPausedCases(): Promise<number> {
  const now = new Date();
  return prisma.copySubscription.count({
    where: {
      deletedAt: null,
      OR: [
        { pausedUntil: { gt: now } },
        { enabled: false, pauseReason: { not: null } },
      ],
    },
  });
}

async function countDisabledLeaders(): Promise<number> {
  return prisma.leaderRiskState.count({ where: { status: 'DISABLED' } });
}

async function countOpenAlerts(): Promise<number> {
  return prisma.adminAlert.count({ where: { status: 'open' } });
}

/** 刷新首页统计快照（每 5 分钟） */
export async function refreshAdminStatsSnapshots(): Promise<void> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [
    registeredUsers,
    walletBoundUsers,
    activeCopyTraders,
    observedTradersTotal,
    copyExec24h,
    riskBlock24h,
    gasPlanTotal,
    commissionUsdtTotal,
    failedCopy24h,
    pendingPackageOrders,
    pausedCases,
    disabledLeaders,
    allAlerts,
  ] = await Promise.all([
    countRegisteredUsers(),
    countWalletBoundUsers(),
    countActiveCopyTraders(),
    countObservedTraders(),
    countCopyExec24h(since24h),
    countRiskBlocks24h(since24h),
    countGasPlans(),
    sumCommissionUsdt(),
    countFailedCopy24h(since24h),
    countPendingPackageOrders(),
    countPausedCases(),
    countDisabledLeaders(),
    countOpenAlerts(),
  ]);

  const values: Record<AdminStatKey, string> = {
    registered_users: String(registeredUsers),
    wallet_bound_users: String(walletBoundUsers),
    active_copy_traders: String(activeCopyTraders),
    observed_traders_total: String(observedTradersTotal),
    copy_exec_24h: String(copyExec24h),
    risk_block_24h: String(riskBlock24h),
    gas_plan_total: String(gasPlanTotal),
    commission_usdt_total: commissionUsdtTotal,
    failed_copy_24h: String(failedCopy24h),
    pending_package_orders: String(pendingPackageOrders),
    paused_cases: String(pausedCases),
    disabled_leaders: String(disabledLeaders),
    all_alerts: String(allAlerts),
  };

  await Promise.all(
    ADMIN_STAT_KEYS.map((key) => upsertStatSnapshot(key, values[key]))
  );
}

/** 刷新 leader 表现榜（30d 周期，来自 Smart Money + 订阅数） */
export async function refreshLeaderPerformanceStats(): Promise<void> {
  const period = '30d';
  const leaders = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    orderBy: { score: 'desc' },
    take: 20,
    select: {
      wallet: true,
      externalTotalReturn: true,
      externalWinRate: true,
      riskPenalty: true,
      riskFlags: true,
    },
  });

  if (leaders.length === 0) {
    return;
  }

  const addresses = leaders.map((l) => l.wallet.toLowerCase());
  const leaderRows = await prisma.copyLeader.findMany({
    select: { id: true, address: true },
  });
  const leaderRowsFiltered = leaderRows.filter((l) => addresses.includes(l.address.toLowerCase()));
  const leaderIdByAddress = new Map(
    leaderRowsFiltered.map((l) => [l.address.toLowerCase(), l.id])
  );

  const followerCounts = await prisma.copySubscription.groupBy({
    by: ['leaderId'],
    where: {
      enabled: true,
      deletedAt: null,
      leaderId: { in: [...leaderIdByAddress.values()] },
    },
    _count: { _all: true },
  });
  const followersByLeaderId = new Map(
    followerCounts.map((g) => [g.leaderId, g._count._all])
  );

  for (const row of leaders) {
    const addr = row.wallet.toLowerCase();
    const leaderId = leaderIdByAddress.get(addr);
    const followers = leaderId ? (followersByLeaderId.get(leaderId) ?? 0) : 0;
    const roi = Number(row.externalTotalReturn ?? 0) * 100;
    const winRate = Number(row.externalWinRate ?? 0) * 100;
    if (followers <= 0 || isAbnormalRoi(roi)) {
      continue;
    }
    const riskLevel = resolveRiskLevel(row.riskPenalty, row.riskFlags);

    await prisma.leaderPerformanceStat.upsert({
      where: { leaderAddress_period: { leaderAddress: addr, period } },
      create: {
        leaderAddress: addr,
        period,
        roi: new Prisma.Decimal(Number.isFinite(roi) ? roi : 0),
        winRate: new Prisma.Decimal(Number.isFinite(winRate) ? winRate : 0),
        followersCount: followers,
        riskLevel,
      },
      update: {
        roi: new Prisma.Decimal(Number.isFinite(roi) ? roi : 0),
        winRate: new Prisma.Decimal(Number.isFinite(winRate) ? winRate : 0),
        followersCount: followers,
        riskLevel,
      },
    });
  }
}

function resolveRiskLevel(
  riskPenalty: Prisma.Decimal | null,
  riskFlags: string[]
): 'low' | 'medium' | 'high' {
  const penalty = Number(riskPenalty ?? 0);
  if (riskFlags.length > 2 || penalty >= 0.5) {
    return 'high';
  }
  if (riskFlags.length > 0 || penalty >= 0.2) {
    return 'medium';
  }
  return 'low';
}

/** 更新系统运行状态（每 1 分钟） */
export async function refreshSystemRuntimeStatus(): Promise<{ nodeStatus: string }> {
  const control = await getEffectiveSystemControl();
  const mode = control.mode;

  let nodeStatusRaw = 'healthy';
  let dbOk = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbOk = false;
    nodeStatusRaw = 'warning';
  }

  if (CONFIG.robotControlNatsEnabled) {
    try {
      if (isRobotControlNatsEnabled()) {
        const nc = await getRobotControlNatsConnection();
        if (nc.isClosed()) {
          nodeStatusRaw = 'warning';
        }
      }
    } catch {
      nodeStatusRaw = 'warning';
    }
  }

  const latestSync = await prisma.smartMoneyLeaderboardRow.findFirst({
    orderBy: { syncedAt: 'desc' },
    select: { syncedAt: true },
  });
  const lastSyncAt = latestSync?.syncedAt ?? null;
  const freshnessSeconds =
    lastSyncAt != null ? Math.max(0, Math.floor((Date.now() - lastSyncAt.getTime()) / 1000)) : null;

  const ranked = await prisma.smartMoneyLeaderboardRow.count({ where: { rank: { not: null } } });
  const nodeStatus = normalizeNodeStatus(nodeStatusRaw);
  const readyToScale =
    dbOk &&
    nodeStatus === 'healthy' &&
    freshnessSeconds != null &&
    freshnessSeconds < CONFIG.smartMoneyFetchIntervalMs / 1000 &&
    ranked >= Math.min(50, CONFIG.smartMoneyBootstrapTargetCount);

  const uptimeMs = Date.now() - processStartedAt;
  const uptimePercent = clampPercent(95 + Math.min(4.99, uptimeMs / (24 * 3600_000) * 5));
  const syncStatus = resolveSyncStatus(freshnessSeconds, !dbOk);

  const version = CONFIG.backendVersion;

  await Promise.all([
    upsertRuntimeStatus('system_mode', mode),
    upsertRuntimeStatus('node_status', nodeStatus),
    upsertRuntimeStatus('process_started_at', processStartedAtIso),
    upsertRuntimeStatus('last_sync_time', lastSyncAt?.toISOString() ?? ''),
    upsertRuntimeStatus(
      'sync_freshness_seconds',
      freshnessSeconds != null ? String(freshnessSeconds) : ''
    ),
    upsertRuntimeStatus('sync_status', syncStatus),
    upsertRuntimeStatus('ready_to_scale', readyToScale ? 'true' : 'false'),
    upsertRuntimeStatus('backend_version', version),
    upsertRuntimeStatus('uptime_percent', uptimePercent.toFixed(2)),
  ]);

  return { nodeStatus };
}

/** 每日 UTC 0 点统计 */
export async function upsertAdminDailyStatsForDate(statDate: Date): Promise<void> {
  const dayStart = new Date(
    Date.UTC(statDate.getUTCFullYear(), statDate.getUTCMonth(), statDate.getUTCDate())
  );
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const [
    registeredUsers,
    newRegisteredUsers,
    walletBoundUsers,
    activeCopyTraders,
    observedTradersTotal,
    onlineUsers,
    subscribedAddresses,
    copySuccessCount,
    copyFailedCount,
    riskBlockCount,
    gasOrderCount,
    gasPurchaseAgg,
    commissionAgg,
    runtimeMap,
  ] = await Promise.all([
    prisma.user.count({ where: { createdAt: { lt: dayEnd } } }),
    prisma.user.count({ where: { createdAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.user.count({
      where: {
        createdAt: { lt: dayEnd },
        wallets: { some: { createdAt: { lt: dayEnd } } },
      },
    }),
    prisma.copySubscription.count({
      where: { enabled: true, deletedAt: null, createdAt: { lt: dayEnd } },
    }),
    countObservedTradersForDate(dayEnd),
    prisma.userDailyActivity
      .groupBy({
        by: ['userId'],
        where: { activityDate: dayStart },
        _count: { _all: true },
      })
      .then((rows) => rows.length)
      .catch(() => 0),
    countDailySubscribedAddresses(dayStart, dayEnd),
    prisma.copyTradeRow.count({
      where: { createdAt: { gte: dayStart, lt: dayEnd }, status: 'filled' },
    }),
    prisma.copyTradeRow.count({
      where: {
        createdAt: { gte: dayStart, lt: dayEnd },
        status: { in: ['failed', 'dead'] },
      },
    }),
    prisma.riskEvent.count({
      where: { result: 'blocked', createdAt: { gte: dayStart, lt: dayEnd } },
    }),
    prisma.gasPackageOrder.count({
      where: { createdAt: { gte: dayStart, lt: dayEnd } },
    }),
    prisma.gasPackageOrder.aggregate({
      where: { paymentConfirmedAt: { gte: dayStart, lt: dayEnd } },
      _count: { _all: true },
      _sum: { paidUsd: true },
    }),
    Promise.all([
      prisma.gasCommission.aggregate({
        where: { createdAt: { gte: dayStart, lt: dayEnd } },
        _sum: { commissionAmount: true },
      }),
      prisma.mallOrderCommission.aggregate({
        where: { createdAt: { gte: dayStart, lt: dayEnd } },
        _sum: { commissionAmount: true },
      }),
    ]),
    getRuntimeStatusMapForDaily(),
  ]);

  const commissionUsdt = decimalSumToString(commissionAgg[0], commissionAgg[1]);
  const uptimeRaw = runtimeMap.get('uptime_percent') ?? '99.9';
  const uptimePercent = clampPercent(Number.parseFloat(uptimeRaw));
  const gasPurchaseCount = gasPurchaseAgg._count._all ?? 0;
  const gasPurchaseAmountUsdt = gasPurchaseAgg._sum.paidUsd ?? new Prisma.Decimal(0);

  await prisma.adminDailyStat.upsert({
    where: { statDate: dayStart },
    create: {
      statDate: dayStart,
      registeredUsers,
      newRegisteredUsers,
      walletBoundUsers,
      activeCopyTraders,
      observedTradersTotal,
      onlineUsers,
      subscribedAddresses,
      copySuccessCount,
      copyFailedCount,
      riskBlockCount,
      gasOrderCount,
      gasPurchaseCount,
      gasPurchaseAmountUsdt,
      commissionUsdt: new Prisma.Decimal(commissionUsdt),
      uptimePercent: new Prisma.Decimal(uptimePercent),
    },
    update: {
      registeredUsers,
      newRegisteredUsers,
      walletBoundUsers,
      activeCopyTraders,
      observedTradersTotal,
      onlineUsers,
      subscribedAddresses,
      copySuccessCount,
      copyFailedCount,
      riskBlockCount,
      gasOrderCount,
      gasPurchaseCount,
      gasPurchaseAmountUsdt,
      commissionUsdt: new Prisma.Decimal(commissionUsdt),
      uptimePercent: new Prisma.Decimal(uptimePercent),
    },
  });
}

async function countDailySubscribedAddresses(dayStart: Date, dayEnd: Date): Promise<number> {
  const rows = await prisma.copySubscription.findMany({
    where: { createdAt: { gte: dayStart, lt: dayEnd } },
    select: { userId: true, leaderId: true },
  });
  const unique = new Set(rows.map((r) => `${r.userId}:${r.leaderId}`));
  return unique.size;
}

async function countObservedTradersForDate(dayEnd: Date): Promise<number> {
  const rows = await prisma.observedTrader.findMany({
    where: { createdAt: { lt: dayEnd } },
    select: { wallet: true },
  });
  return new Set(rows.map((r) => r.wallet.toLowerCase())).size;
}

async function getRuntimeStatusMapForDaily(): Promise<Map<string, string>> {
  return getRuntimeStatusMap().catch(() => new Map<string, string>());
}

/** 若已过 UTC 日界且尚无昨日记录，则写入昨日统计 */
export async function maybeRunDailyAdminStats(): Promise<void> {
  const now = new Date();
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)
  );
  const existing = await prisma.adminDailyStat.findUnique({
    where: { statDate: yesterday },
    select: { id: true },
  });
  if (!existing) {
    await upsertAdminDailyStatsForDate(yesterday);
  }
}
