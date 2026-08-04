/**
 * 发现环水位预算：拉式补池（activeRaw < target 持续补；low 仅紧急告警）。
 * activeRaw 口径 = RAW + LIGHT_ANALYZING（见 smartMoneyRawPoolActive），不含已晋级池。
 *
 * 注意：暂停条件必须是 active >= target，不能是 active >= low。
 * 否则 perRun 偏小或本轮 ingest 部分失败时，会卡在 (low, target) 区间永远补不满。
 */
export type DiscoveryIngestBudget = {
  /** 本轮允许 ingest 的钱包数 */
  slots: number;
  /** 是否因水位过高暂停进货 */
  paused: boolean;
  /** 目标活跃上限 */
  targetCap: number;
  /** active 已低于触发线（运维告警 / 紧急补池） */
  belowLow?: boolean;
};

export function computeDiscoveryIngestBudget(options: {
  activeCount: number;
  maxActive: number;
  /** 0–1；legacy：active >= floor(maxActive * watermark) 则暂停 */
  watermark?: number;
  perRun: number;
  /** 拉式：低于该活跃数视为紧急触发（可观测）；补货一直持续到 target */
  refillLow?: number;
  /** 拉式：补到的目标活跃数 */
  refillTarget?: number;
}): DiscoveryIngestBudget {
  const perRun = Math.max(0, Math.floor(options.perRun));
  const activeCount = Math.max(0, Math.floor(options.activeCount));
  const maxActive = Math.max(0, Math.floor(options.maxActive));

  if (perRun <= 0) {
    const targetCap =
      options.refillTarget != null && options.refillTarget > 0
        ? Math.floor(options.refillTarget)
        : maxActive > 0
          ? maxActive
          : Number.POSITIVE_INFINITY;
    return {
      slots: 0,
      paused: true,
      targetCap,
      belowLow:
        options.refillLow != null ? activeCount < Math.floor(options.refillLow) : undefined,
    };
  }

  // 拉式模型（设计文档）：低于 target 则补；low 仅表示紧急水位
  if (options.refillLow != null && options.refillTarget != null && options.refillTarget > 0) {
    const low = Math.max(0, Math.floor(options.refillLow));
    const target = Math.floor(options.refillTarget);
    const belowLow = activeCount < low;
    if (activeCount >= target) {
      return { slots: 0, paused: true, targetCap: target, belowLow };
    }
    const room = Math.max(0, target - activeCount);
    return {
      slots: Math.min(room, perRun),
      paused: false,
      targetCap: target,
      belowLow,
    };
  }

  // legacy watermark
  if (maxActive <= 0) {
    return { slots: perRun, paused: false, targetCap: Number.POSITIVE_INFINITY };
  }
  const watermark = Math.min(1, Math.max(0, options.watermark ?? 0.9));
  const targetCap = Math.floor(maxActive * watermark);
  if (activeCount >= targetCap) {
    return { slots: 0, paused: true, targetCap };
  }
  const room = targetCap - activeCount;
  return { slots: Math.min(room, perRun), paused: false, targetCap };
}
