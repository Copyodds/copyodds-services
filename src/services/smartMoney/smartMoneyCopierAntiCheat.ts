/** 跟单反馈反作弊：纯函数，可单测 */

export function computeTopSubscriberNotionalShare(
  subscriberNotionals: ReadonlyArray<number>
): number | null {
  if (subscriberNotionals.length === 0) return null;
  const total = subscriberNotionals.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return null;
  const top = Math.max(...subscriberNotionals.map((value) => Math.max(0, value)));
  return Math.round((top / total) * 1e6) / 1e6;
}

export function isCopierWashSuspect(input: {
  topSubscriberNotionalShare: number | null;
  excludedSelfCopyCount: number;
  minTopShare?: number;
  minExcludedSelfCopy?: number;
}): boolean {
  const minTopShare = input.minTopShare ?? 0.85;
  const minExcludedSelfCopy = input.minExcludedSelfCopy ?? 1;
  if (input.excludedSelfCopyCount >= minExcludedSelfCopy) return true;
  if (input.topSubscriberNotionalShare != null && input.topSubscriberNotionalShare >= minTopShare) {
    return true;
  }
  return false;
}

export const COPIER_WASH_SUSPECT_FLAG = 'COPIER_WASH_SUSPECT';
