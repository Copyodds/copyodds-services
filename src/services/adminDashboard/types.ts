export type AdminActivityLevel = 'info' | 'warning' | 'error' | 'critical' | 'success';

export type DashboardActivityLevel = 'success' | 'warning' | 'error' | 'info';

export type AdminAlertStatus = 'open' | 'resolved' | 'ignored';

export type AdminActivityEventType =
  | 'wallet.linked'
  | 'copy.success'
  | 'copy.failed'
  | 'copy.paused'
  | 'risk.blocked'
  | 'node.ping'
  | 'sync.finished'
  | 'gas.order.created'
  | 'gas.order.paid'
  | 'commission.generated'
  | 'withdraw.requested'
  | 'withdraw.approved'
  | 'withdraw.failed'
  | 'user.frozen'
  | 'user.registered'
  | 'leader.disabled';

export type LeaderPerformancePeriod = '24h' | '7d' | '30d' | 'all';

export type LeaderRiskLevel = 'low' | 'medium' | 'high';

export type SyncStatus = 'syncing' | 'idle' | 'error';

export const ADMIN_STATS_PERIOD = 'current' as const;

export const ADMIN_STAT_KEYS = [
  'registered_users',
  'wallet_bound_users',
  'active_copy_traders',
  'observed_traders_total',
  'copy_exec_24h',
  'risk_block_24h',
  'gas_plan_total',
  'commission_usdt_total',
  'failed_copy_24h',
  'pending_package_orders',
  'paused_cases',
  'disabled_leaders',
  'all_alerts',
] as const;

export type AdminStatKey = (typeof ADMIN_STAT_KEYS)[number];

export type DashboardOverviewTrend = {
  dayChange: number;
  dayChangePercent: number;
};

export type DashboardOverview = {
  registeredUsers: number;
  registeredUsersTrend: DashboardOverviewTrend;
  walletBoundUsers: number;
  walletBoundUsersTrend: DashboardOverviewTrend;
  activeCopyTraders: number;
  activeCopyTradersTrend: DashboardOverviewTrend;
  observedTradersTotal: number;
  observedTradersTotalTrend: DashboardOverviewTrend;
  todayNewUsers: number;
};

export type DashboardSystem = {
  mode: string;
  nodeStatus: string;
  uptimePercent: number;
  copyExec24h: number;
  riskBlock24h: number;
  gasPlans: number;
  commissionUsdt: string;
  syncStatus: SyncStatus;
  runtime: string;
  uptimeHistory: DashboardSystemUptimePoint[];
};

export type DashboardSystemUptimePoint = {
  date: string;
  value: number;
};

export type DashboardSync = {
  lastSyncAt: string | null;
  freshnessSeconds: number | null;
  readyToScale: boolean;
  version: string;
};

export type DashboardAlerts = {
  failedCopy24h: number;
  pendingPackageOrders: number;
  pausedCases: number;
  disabledLeaders: number;
  allAlerts: number;
};

export type DashboardTopLeader = {
  rank: number;
  leaderId: string;
  displayName: string;
  isVerified: boolean;
  leaderAddress: string;
  roi: number;
  roiSparkline: number[];
  winRate: number;
  followersCount: number;
  riskLevel: LeaderRiskLevel;
};

export type DashboardActivity = {
  eventType: string;
  title: string;
  description: string;
  level: DashboardActivityLevel;
  createdAt: string;
};

export type DashboardExecutionTrendPoint = {
  date: string;
  successCount: number;
  failureCount: number;
  successRate: number;
};

export type DashboardDailyMetricsTrendPoint = {
  date: string;
  registeredUsers: number;
  onlineUsers: number;
  subscribedAddresses: number;
  gasPurchases: number;
};

export type AdminDashboardPayload = {
  overview: DashboardOverview;
  system: DashboardSystem;
  sync: DashboardSync;
  alerts: DashboardAlerts;
  executionTrend: DashboardExecutionTrendPoint[];
  dailyMetricsTrend: DashboardDailyMetricsTrendPoint[];
  topLeaders: DashboardTopLeader[];
  activities: DashboardActivity[];
};

