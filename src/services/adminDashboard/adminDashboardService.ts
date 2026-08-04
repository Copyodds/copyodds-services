import {
  countTodayNewUsers,
  fetchLeaderEnrichment,
  getDailyStatByDate,
  getRuntimeStatusMap,
  getStatSnapshotMap,
  listDailyStatsSince,
  listRecentActivitiesDetailed,
  listTopLeaderPerformanceRows,
} from '../../repositories/adminStatsRepository';
import { CONFIG } from '../../config/env';
import { maskWalletAddress } from './adminActivityLog';
import {
  buildExecutionTrend,
  buildDailyMetricsTrend,
  buildUptimeHistory,
  clampPercent,
  computeOverviewTrend,
  filterActivitiesForDashboard,
  formatCommissionUsdt,
  formatRuntimeDuration,
  lastNDaysUtc,
  normalizeNodeStatus,
  normalizeSystemMode,
  rankTopLeaders,
  resolveSyncStatus,
  round2,
  type TopLeaderCandidate,
} from './adminDashboardUtils';
import type {
  AdminDashboardPayload,
  DashboardDailyMetricsTrendPoint,
  DashboardOverview,
  LeaderRiskLevel,
} from './types';

function parseIntStat(map: Map<string, string>, key: string, fallback = 0): number {
  const raw = map.get(key);
  if (raw == null || raw === '') {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatStat(map: Map<string, string>, key: string, fallback = 0): number {
  const raw = map.get(key);
  if (raw == null || raw === '') {
    return fallback;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolStat(runtime: Map<string, string>, key: string): boolean {
  return runtime.get(key) === 'true';
}

function utcDayStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcYesterday(): Date {
  const today = utcDayStart();
  return new Date(today.getTime() - 24 * 60 * 60 * 1000);
}

async function buildOverview(stats: Map<string, string>): Promise<DashboardOverview> {
  const registeredUsers = parseIntStat(stats, 'registered_users');
  const walletBoundUsers = parseIntStat(stats, 'wallet_bound_users');
  const activeCopyTraders = parseIntStat(stats, 'active_copy_traders');
  const observedTradersTotal = parseIntStat(stats, 'observed_traders_total');

  const yesterdayStat = await getDailyStatByDate(utcYesterday()).catch(() => null);
  const todayNewUsers = await countTodayNewUsers(utcDayStart()).catch(() => 0);

  return {
    registeredUsers,
    registeredUsersTrend: computeOverviewTrend(
      registeredUsers,
      yesterdayStat?.registeredUsers ?? null
    ),
    walletBoundUsers,
    walletBoundUsersTrend: computeOverviewTrend(
      walletBoundUsers,
      yesterdayStat?.walletBoundUsers ?? null
    ),
    activeCopyTraders,
    activeCopyTradersTrend: computeOverviewTrend(
      activeCopyTraders,
      yesterdayStat?.activeCopyTraders ?? null
    ),
    observedTradersTotal,
    observedTradersTotalTrend: computeOverviewTrend(
      observedTradersTotal,
      yesterdayStat?.observedTradersTotal ?? null
    ),
    todayNewUsers,
  };
}

async function buildExecutionTrendFromDaily() {
  const since = lastNDaysUtc(7)[0];
  const rows = await listDailyStatsSince(since).catch(() => []);
  const byDate = new Map<string, { success: number; failed: number }>();
  for (const row of rows) {
    const key = row.statDate.toISOString().slice(0, 10);
    byDate.set(key, {
      success: row.copySuccessCount,
      failed: row.copyFailedCount,
    });
  }
  return buildExecutionTrend(byDate);
}

async function buildDailyMetricsTrendFromDaily(): Promise<DashboardDailyMetricsTrendPoint[]> {
  const since = lastNDaysUtc(7)[0];
  const rows = await listDailyStatsSince(since).catch(() => []);
  const byDate = new Map<
    string,
    { registeredUsers: number; onlineUsers: number; subscribedAddresses: number; gasPurchases: number }
  >();
  for (const row of rows) {
    const key = row.statDate.toISOString().slice(0, 10);
    byDate.set(key, {
      registeredUsers: row.newRegisteredUsers ?? 0,
      onlineUsers: row.onlineUsers ?? 0,
      subscribedAddresses: row.subscribedAddresses ?? 0,
      gasPurchases: row.gasPurchaseCount ?? 0,
    });
  }
  return buildDailyMetricsTrend(byDate) as DashboardDailyMetricsTrendPoint[];
}

async function buildTopLeaders() {
  const rows = await listTopLeaderPerformanceRows('30d', 30).catch(() => []);
  if (rows.length === 0) {
    return [];
  }

  const addresses = rows.map((r) => r.leaderAddress);
  const enrichment = await fetchLeaderEnrichment(addresses).catch(() => ({
    leaderIdByAddress: new Map<string, string>(),
    displayNameByAddress: new Map<string, string>(),
    verifiedByAddress: new Map<string, boolean>(),
  }));

  const candidates: TopLeaderCandidate[] = rows.map((row, index) => {
    const addr = row.leaderAddress.toLowerCase();
    const roi = Number(row.roi);
    const winRate = Number(row.winRate);
    const leaderId = enrichment.leaderIdByAddress.get(addr) ?? addr;
    const displayName =
      enrichment.displayNameByAddress.get(addr) ?? `Leader ${index + 1}`;
    return {
      leaderAddress: row.leaderAddress,
      leaderId,
      displayName,
      isVerified: enrichment.verifiedByAddress.get(addr) ?? false,
      roi: Number.isFinite(roi) ? roi : 0,
      winRate: Number.isFinite(winRate) ? winRate : 0,
      followersCount: row.followersCount,
      copyVolume: row.copyVolume != null ? Number(row.copyVolume) : 0,
      riskLevel: (row.riskLevel as LeaderRiskLevel) || 'medium',
      roiSparkline: [Number.isFinite(roi) ? roi : 0],
    };
  });

  return rankTopLeaders(candidates);
}

/** 聚合后台首页数据；无快照时返回 0 / 空数组，不抛错 */
export async function buildAdminDashboardPayload(): Promise<AdminDashboardPayload> {
  const stats = await getStatSnapshotMap().catch(() => new Map<string, string>());

  const [runtime, topLeaders, activitiesRaw, executionTrend, dailyMetricsTrend, overview] = await Promise.all([
    getRuntimeStatusMap().catch(() => new Map<string, string>()),
    buildTopLeaders(),
    listRecentActivitiesDetailed(50).catch(() => []),
    buildExecutionTrendFromDaily(),
    buildDailyMetricsTrendFromDaily(),
    buildOverview(stats).catch(() => buildOverview(new Map<string, string>())),
  ]);

  const lastSyncRaw = runtime.get('last_sync_time') ?? '';
  const freshnessRaw = runtime.get('sync_freshness_seconds') ?? '';
  const freshnessSeconds =
    freshnessRaw.length > 0 ? parseIntStat(runtime, 'sync_freshness_seconds', 0) : null;
  const syncError = runtime.get('sync_status') === 'error';

  const uptimePercent = clampPercent(parseFloatStat(runtime, 'uptime_percent', 99.9));
  const startedAtRaw = runtime.get('process_started_at') ?? '';
  const startedAtMs =
    startedAtRaw.length > 0 ? Date.parse(startedAtRaw) : Number.NaN;

  const dailySince = lastNDaysUtc(7)[0];
  const dailyRows = await listDailyStatsSince(dailySince).catch(() => []);
  const uptimeByDate = new Map<string, number>();
  for (const row of dailyRows) {
    uptimeByDate.set(row.statDate.toISOString().slice(0, 10), Number(row.uptimePercent));
  }

  const system = {
    mode: normalizeSystemMode(runtime.get('system_mode')),
    nodeStatus: normalizeNodeStatus(runtime.get('node_status')),
    uptimePercent: round2(uptimePercent),
    copyExec24h: parseIntStat(stats, 'copy_exec_24h'),
    riskBlock24h: parseIntStat(stats, 'risk_block_24h'),
    gasPlans: parseIntStat(stats, 'gas_plan_total'),
    commissionUsdt: formatCommissionUsdt(stats.get('commission_usdt_total')),
    syncStatus: resolveSyncStatus(freshnessSeconds, syncError),
    runtime: formatRuntimeDuration(Number.isFinite(startedAtMs) ? startedAtMs : null),
    uptimeHistory: buildUptimeHistory(uptimeByDate, uptimePercent),
  };

  const sync = {
    lastSyncAt: lastSyncRaw.length > 0 ? lastSyncRaw : null,
    freshnessSeconds,
    readyToScale: parseBoolStat(runtime, 'ready_to_scale'),
    version: runtime.get('backend_version') ?? CONFIG.backendVersion ?? 'dev',
  };

  const alerts = {
    failedCopy24h: parseIntStat(stats, 'failed_copy_24h'),
    pendingPackageOrders: parseIntStat(stats, 'pending_package_orders'),
    pausedCases: parseIntStat(stats, 'paused_cases'),
    disabledLeaders: parseIntStat(stats, 'disabled_leaders'),
    allAlerts: parseIntStat(stats, 'all_alerts'),
  };

  const activities = filterActivitiesForDashboard(
    activitiesRaw.map((a) => ({
      eventType: a.eventType,
      title: a.title,
      content: a.content,
      level: a.level,
      createdAt: a.createdAt,
      metadata: a.metadata,
    })),
    maskWalletAddress
  );

  return {
    overview,
    system,
    sync,
    alerts,
    executionTrend,
    dailyMetricsTrend,
    topLeaders,
    activities,
  };
}
