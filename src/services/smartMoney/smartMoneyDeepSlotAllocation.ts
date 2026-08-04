export type SmartMoneyDeepSlotAllocationInput = {
  limit: number;
  qualifiedDue: number;
  scoredDue: number;
  scoredReservedSlots: number;
  minQualifiedShare: number;
  refreshShare: number;
};

export type SmartMoneyDeepSlotAllocation = {
  qualifiedSlots: number;
  refreshSlots: number;
  scoredSlots: number;
};

/**
 * Deep 批次配额：
 * - 只要有足量 QUALIFIED 到期，严格保留 minQualifiedShare；
 * - 有到期 SCORED 时先保留 scoredReservedSlots，避免复评队列饿死；
 * - refresh 即使因 TopN 欠债临时抬升，也不能突破 QUALIFIED 地板；
 * - QUALIFIED 不足时先给 SCORED；剩余槽位不再无限回让 refresh（F5）。
 */
export function allocateSmartMoneyDeepSlots(
  input: SmartMoneyDeepSlotAllocationInput
): SmartMoneyDeepSlotAllocation {
  const limit = Math.max(0, Math.floor(input.limit));
  if (limit === 0) {
    return { qualifiedSlots: 0, refreshSlots: 0, scoredSlots: 0 };
  }

  const qualifiedDue = Math.max(0, Math.floor(input.qualifiedDue));
  const scoredDue = Math.max(0, Math.floor(input.scoredDue));
  const requestedScoredReservedSlots = Math.max(
    0,
    Math.floor(input.scoredReservedSlots)
  );
  const minQualifiedShare = Math.max(0, Math.min(1, input.minQualifiedShare));
  const refreshShare = Math.max(0, Math.min(1, input.refreshShare));
  const qualifiedFloor = Math.min(
    qualifiedDue,
    Math.ceil(limit * minQualifiedShare)
  );
  const scoredReservedSlots = Math.min(
    scoredDue,
    requestedScoredReservedSlots,
    Math.max(0, limit - qualifiedFloor)
  );
  const maxRefreshByQualifiedFloor = Math.max(
    0,
    limit - qualifiedFloor - scoredReservedSlots
  );
  let refreshSlots = Math.min(
    Math.floor(limit * refreshShare),
    maxRefreshByQualifiedFloor
  );
  let scoredSlots = scoredReservedSlots;
  const qualifiedSlots = Math.min(
    qualifiedDue,
    limit - refreshSlots - scoredSlots
  );
  let remaining = Math.max(
    0,
    limit - refreshSlots - qualifiedSlots - scoredSlots
  );
  const additionalScored = Math.min(scoredDue - scoredSlots, remaining);
  scoredSlots += additionalScored;

  return { qualifiedSlots, refreshSlots, scoredSlots };
}
