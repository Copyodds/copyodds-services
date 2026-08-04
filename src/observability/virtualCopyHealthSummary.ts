export type VirtualCopyHealthSummary = {
  status: 'ok' | 'degraded' | 'unhealthy';
  checkedAt: string;
  queue: {
    depth: number;
    oldestAgeSeconds: number;
    simulating: number;
    dead: number;
  };
  replayLagSeconds: number;
  staleClaims: number;
  buySafetyPaused: boolean;
  reasons: string[];
};

export function summarizeVirtualCopyHealth(input: Omit<VirtualCopyHealthSummary, 'status' | 'reasons'>): VirtualCopyHealthSummary {
  const reasons: string[] = [];
  if (input.buySafetyPaused) reasons.push('buy_safety_paused');
  if (input.queue.dead > 0) reasons.push('dead_executions');
  if (input.staleClaims > 0) reasons.push('stale_claims');
  if (input.queue.oldestAgeSeconds > 300) reasons.push('queue_lag_critical');
  else if (input.queue.oldestAgeSeconds > 60) reasons.push('queue_lag');
  if (input.replayLagSeconds > 300) reasons.push('replay_lag_critical');
  else if (input.replayLagSeconds > 60) reasons.push('replay_lag');
  const unhealthy = reasons.some((reason) => reason.endsWith('_critical'));
  return {
    ...input,
    status: unhealthy ? 'unhealthy' : reasons.length > 0 ? 'degraded' : 'ok',
    reasons,
  };
}
