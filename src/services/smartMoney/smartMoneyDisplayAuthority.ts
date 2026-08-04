/**
 * 聪明钱对外展示权威源：
 * - 有榜行（LeaderboardRow）→ 列表与详情只信榜表
 * - 无榜行 → 才用 ScoreCache（未入榜已分析）
 *
 * ScoreCache 仍是管道/未入榜详情仓；不得与榜表并行充当入榜地址的展示真相源。
 */

export type SmartMoneyDisplayAuthoritySource = 'leaderboard' | 'score_cache' | 'none';

export function resolveSmartMoneyDisplayAuthority(input: {
  hasLeaderboardRow: boolean;
  hasScoreCache: boolean;
}): SmartMoneyDisplayAuthoritySource {
  if (input.hasLeaderboardRow) return 'leaderboard';
  if (input.hasScoreCache) return 'score_cache';
  return 'none';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把 scoreExplain.traderProfile（含 card）对齐到榜表权威列，兼容旧前端只读 card.tier。
 */
export function alignScoreExplainTraderProfileToBoard(input: {
  scoreExplain: unknown;
  tier: string | null;
  traderScore: string | number | null;
  traderType: string | null;
}): unknown {
  const { scoreExplain, tier, traderScore, traderType } = input;
  if (scoreExplain == null || !isRecord(scoreExplain)) return scoreExplain;
  if (tier == null && traderScore == null && traderType == null) return scoreExplain;

  const base = { ...scoreExplain };
  const traderProfile = isRecord(base.traderProfile) ? { ...base.traderProfile } : {};

  if (tier != null) traderProfile.tier = tier;
  if (traderType != null) traderProfile.traderType = traderType;
  if (traderScore != null) {
    const scoreNum = typeof traderScore === 'number' ? traderScore : Number(traderScore);
    if (Number.isFinite(scoreNum)) {
      const ts = isRecord(traderProfile.traderScore) ? { ...traderProfile.traderScore } : {};
      ts.score = scoreNum;
      traderProfile.traderScore = ts;
    }
  }

  if (isRecord(traderProfile.card)) {
    const card = { ...traderProfile.card };
    if (tier != null) card.tier = tier;
    if (traderType != null) card.traderType = traderType;
    if (traderScore != null) {
      const scoreNum = typeof traderScore === 'number' ? traderScore : Number(traderScore);
      if (Number.isFinite(scoreNum)) card.traderScore = scoreNum;
    }
    traderProfile.card = card;
  } else if (tier != null || traderScore != null || traderType != null) {
    // 旧快照可能缺 card；详情/列表 UI 常读 card.tier，补齐避免与 summary 分裂
    const card: Record<string, unknown> = {};
    if (tier != null) card.tier = tier;
    if (traderType != null) card.traderType = traderType;
    if (traderScore != null) {
      const scoreNum = typeof traderScore === 'number' ? traderScore : Number(traderScore);
      if (Number.isFinite(scoreNum)) card.traderScore = scoreNum;
    }
    traderProfile.card = card;
  }

  base.traderProfile = traderProfile;
  return base;
}

/** 派生写（如 copyability）时打上展示修订戳，便于排查双写一致性 */
export function stampSmartMoneyDisplayRevision(
  scoreExplain: unknown,
  at: Date = new Date()
): Record<string, unknown> {
  const base = isRecord(scoreExplain) ? { ...scoreExplain } : {};
  base.displayRevisionAt = at.toISOString();
  return base;
}
