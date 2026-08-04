export type AnalyzeAction = 'skip' | 'enrich_only' | 'deep';

export function decideSmartMoneyAnalyzeAction(input: {
  exists: boolean;
  coreComplete: boolean;
  curvesComplete: boolean;
  fatalDataMissing: boolean;
  fresh: boolean;
}): AnalyzeAction {
  if (
    input.exists &&
    input.coreComplete &&
    input.curvesComplete &&
    !input.fatalDataMissing &&
    input.fresh
  ) {
    return 'skip';
  }
  if (
    input.exists &&
    input.coreComplete &&
    !input.curvesComplete &&
    !input.fatalDataMissing &&
    input.fresh
  ) {
    return 'enrich_only';
  }
  return 'deep';
}

export function canAcceptSmartMoneyAnalyzeJob(activeCount: number, queueMax: number): boolean {
  return activeCount >= 0 && queueMax > 0 && activeCount < queueMax;
}
