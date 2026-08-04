export function computeReplayPlanLimits(limit: number, backfillRatio: number): {
  hotLimit: number;
  backfillReserve: number;
} {
  const safeLimit = Math.max(1, Math.floor(limit));
  const ratio = Number.isFinite(backfillRatio) ? Math.max(0, Math.min(0.8, backfillRatio)) : 0.2;
  const backfillReserve = Math.min(safeLimit - 1, Math.floor(safeLimit * ratio));
  return {
    hotLimit: Math.max(1, safeLimit - backfillReserve),
    backfillReserve,
  };
}
