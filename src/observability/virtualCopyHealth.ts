import { prisma } from '../db';
import {
  summarizeVirtualCopyHealth,
  type VirtualCopyHealthSummary,
} from './virtualCopyHealthSummary';
import { boundedStatus, virtualCopyMetrics } from './virtualCopyMetrics';

export { summarizeVirtualCopyHealth, type VirtualCopyHealthSummary };

export async function collectVirtualCopyHealth(now = new Date()): Promise<VirtualCopyHealthSummary> {
  const [statusGroups, oldestDue, checkpoint, staleClaims, safety] = await Promise.all([
    prisma.virtualCopyExecution.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prisma.virtualCopyExecution.findFirst({
      where: { status: 'QUEUED', scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    }),
    prisma.virtualCopyReplayCheckpoint.findUnique({
      where: { key: 'virtual-copy-leader-trades-v1' },
      select: { lastCreatedAt: true },
    }),
    prisma.virtualCopyExecution.count({
      where: { status: 'SIMULATING', claimExpiresAt: { lt: now } },
    }),
    prisma.systemControl.findUnique({
      where: { key: 'virtual-copy-safety' },
      select: { mode: true },
    }),
  ]);

  const counts = new Map(statusGroups.map((row) => [String(row.status), row._count._all]));
  for (const status of ['QUEUED', 'SIMULATING', 'FILLED', 'PARTIALLY_FILLED', 'SKIPPED', 'DEAD', 'SETTLED']) {
    virtualCopyMetrics.queueDepth.labels(boundedStatus(status)).set(counts.get(status) ?? 0);
  }
  const oldestAgeSeconds = oldestDue
    ? Math.max(0, (now.getTime() - oldestDue.scheduledAt.getTime()) / 1_000)
    : 0;
  const replayLagSeconds = checkpoint
    ? Math.max(0, (now.getTime() - checkpoint.lastCreatedAt.getTime()) / 1_000)
    : 0;
  virtualCopyMetrics.queueOldestAgeSeconds.set(oldestAgeSeconds);
  virtualCopyMetrics.replayLagSeconds.set(replayLagSeconds);

  return summarizeVirtualCopyHealth({
    checkedAt: now.toISOString(),
    queue: {
      depth: counts.get('QUEUED') ?? 0,
      oldestAgeSeconds,
      simulating: counts.get('SIMULATING') ?? 0,
      dead: counts.get('DEAD') ?? 0,
    },
    replayLagSeconds,
    staleClaims,
    buySafetyPaused: safety?.mode === 'PAUSED',
  });
}
