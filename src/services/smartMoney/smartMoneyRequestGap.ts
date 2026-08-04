import { CONFIG } from '../../config/env';
import { sleep } from '../../copyTrading/services/mapPool';

/** Light 与 Gate/Deep 分车道，避免 Profile 快筛被 closed 多页拉取拖死。 */
export type SmartMoneyRequestGapLane = 'light' | 'heavy';

type GapLaneState = {
  lastRequestAt: number;
  chain: Promise<void>;
};

const lanes: Record<SmartMoneyRequestGapLane, GapLaneState> = {
  light: { lastRequestAt: 0, chain: Promise.resolve() },
  heavy: { lastRequestAt: 0, chain: Promise.resolve() },
};

function gapMsForLane(lane: SmartMoneyRequestGapLane): number {
  if (lane === 'light') {
    return CONFIG.smartMoneyLightRequestGapMs;
  }
  return CONFIG.smartMoneyRequestGapMs;
}

/**
 * 请求最小间隔。
 * - `light`：SMART_MONEY_LIGHT_REQUEST_GAP_MS（默认 300）
 * - `heavy` / 缺省：SMART_MONEY_REQUEST_GAP_MS（默认 600，Gate/Deep 等）
 * 同车道串行排队；异车道互不阻塞。
 */
export async function waitSmartMoneyRequestGap(
  lane: SmartMoneyRequestGapLane = 'heavy'
): Promise<void> {
  const gapMs = gapMsForLane(lane);
  if (gapMs <= 0) return;

  const state = lanes[lane];
  const run = async () => {
    const now = Date.now();
    const wait = Math.max(0, state.lastRequestAt + gapMs - now);
    if (wait > 0) await sleep(wait);
    state.lastRequestAt = Date.now();
  };

  const next = state.chain.then(run, run);
  state.chain = next.then(
    () => undefined,
    () => undefined
  );
  await next;
}
