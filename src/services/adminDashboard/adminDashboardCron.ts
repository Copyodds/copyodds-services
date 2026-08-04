import { recordAdminActivity } from './adminActivityLog';
import {
  maybeRunDailyAdminStats,
  refreshAdminStatsSnapshots,
  refreshLeaderPerformanceStats,
  refreshSystemRuntimeStatus,
} from './adminStatsRefresh';

let lastNodePingStatus: string | null = null;

export async function runAdminDashboardRuntimeCron(): Promise<void> {
  const { nodeStatus } = await refreshSystemRuntimeStatus();
  if (lastNodePingStatus !== nodeStatus) {
    lastNodePingStatus = nodeStatus;
    recordAdminActivity({
      eventType: 'node.ping',
      title: 'Monitoring Node Ping',
      level: nodeStatus === 'healthy' ? 'info' : 'warning',
      actorType: 'system',
      actorId: 'cron',
      metadata: { nodeStatus },
    });
  }
}

export async function runAdminDashboardStatsCron(): Promise<void> {
  await refreshAdminStatsSnapshots();
  await refreshLeaderPerformanceStats();
}

export async function runAdminDashboardDailyCron(): Promise<void> {
  await maybeRunDailyAdminStats();
}
