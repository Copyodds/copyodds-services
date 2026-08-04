import assert from 'node:assert/strict';
import { maskWalletAddress } from './adminActivityLog';
import { buildAdminDashboardPayload } from './adminDashboardService';
import { containsSensitiveText } from './adminDashboardUtils';

assert.equal(maskWalletAddress('0x1234567890abcdef1234567890abcdef12345678'), '0x12****5678');

void (async () => {
  const payload = await buildAdminDashboardPayload();

  assert.ok(payload.overview);
  assert.equal(typeof payload.overview.registeredUsers, 'number');
  assert.ok(payload.overview.registeredUsersTrend);
  assert.equal(typeof payload.overview.registeredUsersTrend.dayChange, 'number');
  assert.equal(typeof payload.overview.todayNewUsers, 'number');

  assert.equal(typeof payload.system.commissionUsdt, 'string');
  assert.ok(['healthy', 'warning', 'error', 'unknown'].includes(payload.system.nodeStatus));
  assert.ok(['NORMAL', 'TRACK_ONLY', 'PAUSED'].includes(payload.system.mode));
  assert.ok(['syncing', 'idle', 'error'].includes(payload.system.syncStatus));
  assert.equal(typeof payload.system.runtime, 'string');
  assert.equal(payload.system.uptimeHistory.length, 7);

  assert.equal(payload.executionTrend.length, 7);
  for (const point of payload.executionTrend) {
    assert.equal(typeof point.date, 'string');
    assert.equal(typeof point.successCount, 'number');
    assert.equal(typeof point.failureCount, 'number');
    assert.equal(typeof point.successRate, 'number');
  }

  assert.equal(payload.dailyMetricsTrend.length, 7);
  for (const p of payload.dailyMetricsTrend) {
    assert.equal(typeof p.date, 'string');
    assert.equal(typeof p.registeredUsers, 'number');
    assert.equal(typeof p.onlineUsers, 'number');
    assert.equal(typeof p.subscribedAddresses, 'number');
    assert.equal(typeof p.gasPurchases, 'number');
  }

  for (const leader of payload.topLeaders) {
    assert.ok(leader.roi <= 10000);
    assert.ok(leader.roi >= -100);
    assert.ok(leader.followersCount > 0);
    assert.equal(typeof leader.rank, 'number');
    assert.ok(Array.isArray(leader.roiSparkline));
  }

  const pingCount = payload.activities.filter((a) => a.eventType === 'node.ping').length;
  const syncCount = payload.activities.filter((a) => a.eventType === 'sync.finished').length;
  assert.ok(pingCount <= 1);
  assert.ok(syncCount <= 1);
  assert.ok(payload.activities.length <= 10);

  for (const activity of payload.activities) {
    assert.equal(typeof activity.description, 'string');
    assert.ok(!containsSensitiveText(activity.description));
    assert.ok(['success', 'warning', 'error', 'info'].includes(activity.level));
  }

  console.log('[admin-dashboard-test] ok', {
    registeredUsers: payload.overview.registeredUsers,
    executionTrendDays: payload.executionTrend.length,
    topLeaders: payload.topLeaders.length,
    activities: payload.activities.length,
  });
})().catch((err) => {
  console.error('[admin-dashboard-test] failed', err);
  process.exitCode = 1;
});
