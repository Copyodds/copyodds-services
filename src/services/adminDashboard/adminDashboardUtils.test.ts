import assert from 'node:assert/strict';
import {
  buildDailyMetricsTrend,
  buildExecutionTrend,
  buildUptimeHistory,
  computeOverviewTrend,
  containsSensitiveText,
  filterActivitiesForDashboard,
  formatCommissionUsdt,
  isAbnormalRoi,
  normalizeNodeStatus,
  normalizeSystemMode,
  rankTopLeaders,
  resolveSyncStatus,
} from './adminDashboardUtils';

assert.deepEqual(computeOverviewTrend(100, null), { dayChange: 0, dayChangePercent: 0 });
assert.deepEqual(computeOverviewTrend(110, 100), { dayChange: 10, dayChangePercent: 10 });

const trend = buildExecutionTrend(new Map());
assert.equal(trend.length, 7);
assert.equal(trend[0].successCount, 0);
assert.equal(trend[0].failureCount, 0);
assert.equal(trend[0].successRate, 0);

const daily = buildDailyMetricsTrend(new Map());
assert.equal(daily.length, 7);
assert.equal(daily[0].registeredUsers, 0);
assert.equal(daily[0].onlineUsers, 0);

const uptime = buildUptimeHistory(new Map(), 99.5);
assert.equal(uptime.length, 7);
assert.equal(uptime[0].value, 99.5);

assert.equal(normalizeNodeStatus('ok'), 'healthy');
assert.equal(normalizeNodeStatus('degraded'), 'warning');
assert.equal(normalizeSystemMode('NODE=x · MODE=PAUSED'), 'PAUSED');
assert.equal(formatCommissionUsdt('12.3'), '12.30');
assert.equal(formatCommissionUsdt(''), '0.00');

assert.equal(isAbnormalRoi(10001), true);
assert.equal(isAbnormalRoi(50), false);

assert.equal(resolveSyncStatus(120, false), 'syncing');
assert.equal(resolveSyncStatus(600, false), 'idle');
assert.equal(resolveSyncStatus(4000, false), 'error');

const leaders = rankTopLeaders([
  {
    leaderAddress: '0xabc',
    leaderId: '1',
    displayName: 'A',
    isVerified: true,
    roi: 50,
    winRate: 60,
    followersCount: 10,
    copyVolume: 0,
    riskLevel: 'low',
    roiSparkline: [50],
  },
  {
    leaderAddress: '0xdef',
    leaderId: '2',
    displayName: 'B',
    isVerified: false,
    roi: 99999,
    winRate: 90,
    followersCount: 100,
    copyVolume: 0,
    riskLevel: 'low',
    roiSparkline: [99999],
  },
]);
assert.equal(leaders.length, 1);
assert.equal(leaders[0].rank, 1);

const activities = filterActivitiesForDashboard(
  [
    {
      eventType: 'node.ping',
      title: 'ping1',
      content: null,
      level: 'info',
      createdAt: new Date('2026-05-27T10:00:00Z'),
      metadata: null,
    },
    {
      eventType: 'node.ping',
      title: 'ping2',
      content: null,
      level: 'info',
      createdAt: new Date('2026-05-27T09:00:00Z'),
      metadata: null,
    },
    {
      eventType: 'copy.success',
      title: 'ok',
      content: null,
      level: 'info',
      createdAt: new Date('2026-05-27T11:00:00Z'),
      metadata: { userAddress: '0x1234567890abcdef1234567890abcdef12345678' },
    },
  ],
  (a) => `${a.slice(0, 4)}****${a.slice(-4)}`
);
const pingCount = activities.filter((a) => a.eventType === 'node.ping').length;
assert.equal(pingCount, 1);
assert.equal(activities[0].level, 'success');
assert.ok(!containsSensitiveText(activities[0].description ?? ''));

console.log('[admin-dashboard-utils-test] ok');
