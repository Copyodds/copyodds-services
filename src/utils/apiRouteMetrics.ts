import { logger } from './logger';

export type ApiRouteMetricsSnapshot = {
  durationMs: number;
  heapUsedMb: number;
  heapDeltaMb: number;
  resultCount?: number;
};

function heapUsedMb(): number {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

/** 记录接口耗时、返回条数与堆内存变化，便于定位 OOM。 */
export function logApiRouteMetrics(
  route: string,
  userId: number | undefined,
  startedAt: number,
  heapAtStart: number,
  extra?: { resultCount?: number; [key: string]: unknown }
): ApiRouteMetricsSnapshot {
  const durationMs = Date.now() - startedAt;
  const heapUsed = heapUsedMb();
  const heapDeltaMb = Math.round((heapUsed - heapAtStart) * 10) / 10;
  const snapshot: ApiRouteMetricsSnapshot = {
    durationMs,
    heapUsedMb: heapUsed,
    heapDeltaMb,
    resultCount: extra?.resultCount,
  };
  logger.info(
    {
      route,
      userId,
      ...snapshot,
      ...extra,
    },
    'api route metrics'
  );
  return snapshot;
}

export function startApiRouteMetrics(): { startedAt: number; heapAtStart: number } {
  return { startedAt: Date.now(), heapAtStart: heapUsedMb() };
}
