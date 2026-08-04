/**
 * 多因子 / 档位 / 入榜原因展示是否「评分完成」：
 * Gate 分已有 + 仿跟单（三情景）已算出。
 */
import { isCopyabilityComputed } from './smartMoneyCopyReady';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function readCopyabilityScoreFromExplain(scoreExplain: unknown): number | null {
  if (!isRecord(scoreExplain)) return null;
  const copy = scoreExplain.copyability;
  if (!isRecord(copy)) return null;
  const multi = copy.multiScenario;
  if (isRecord(multi) && typeof multi.score === 'number' && Number.isFinite(multi.score)) {
    return multi.score;
  }
  const metrics = copy.metrics;
  if (isRecord(metrics) && typeof metrics.copyabilityScore === 'number') {
    return Number.isFinite(metrics.copyabilityScore) ? metrics.copyabilityScore : null;
  }
  if (typeof copy.score === 'number' && Number.isFinite(copy.score)) return copy.score;
  return null;
}

export function isCopyabilityDisplayReady(input: {
  scoreExplain: unknown;
  copyabilityScore?: number | null;
}): boolean {
  if (isCopyabilityComputed(input.copyabilityScore)) return true;
  const fromExplain = readCopyabilityScoreFromExplain(input.scoreExplain);
  if (isCopyabilityComputed(fromExplain)) return true;
  if (!isRecord(input.scoreExplain)) return false;
  const trader = input.scoreExplain.traderProfile;
  if (!isRecord(trader)) return false;
  const ts = trader.traderScore;
  if (isRecord(ts) && ts.copyabilityMissing === false) {
    // 明确标记已补齐，即使缺 multiScenario 也视为可展示
    return true;
  }
  return false;
}

/** 详情页多因子卡 / 档位 / 入榜原因门控 */
export function isTraderScoreDisplayComplete(input: {
  scoreExplain: unknown;
  copyabilityScore?: number | null;
  tier?: string | null;
  traderScore?: number | null;
}): boolean {
  if (!isRecord(input.scoreExplain)) return false;
  const trader = input.scoreExplain.traderProfile;
  if (!isRecord(trader)) return false;
  const card = trader.card;
  if (!isRecord(card)) return false;
  const tier =
    (typeof input.tier === 'string' && input.tier) ||
    (typeof card.tier === 'string' ? card.tier : null) ||
    (typeof trader.tier === 'string' ? trader.tier : null);
  const scoreRaw =
    input.traderScore ??
    (typeof card.traderScore === 'number' ? card.traderScore : null) ??
    (isRecord(trader.traderScore) && typeof trader.traderScore.score === 'number'
      ? trader.traderScore.score
      : null);
  if (typeof tier !== 'string' || !Number.isFinite(Number(scoreRaw))) return false;
  return isCopyabilityDisplayReady({
    scoreExplain: input.scoreExplain,
    copyabilityScore: input.copyabilityScore,
  });
}
