/**
 * 榜单资格说明：入榜 / 不入榜原因（用户可读）
 */
import { CONFIG } from '../../config/env';
import { hasCopyPoolHardFlag } from './smartMoneyTierGate';
import {
  isCopyabilityComputed,
} from './smartMoneyCopyReady';
import { resolveCopyPoolMetricScore } from './smartMoneyPoolScore';

export type BoardEligibilityStatus = 'ON_BOARD' | 'NOT_ON_BOARD';

export type BoardEligibilityCode =
  | 'ON_BOARD'
  | 'TIER1L'
  | 'L1_EARLY'
  | 'L1'
  | 'HARD_FLAG'
  | 'SCORE_BELOW'
  | 'TIER2E'
  | 'COPY_NOT_READY'
  | 'COPY_TOO_LOW'
  | 'INACTIVE'
  | 'EXIT_SCORE'
  | 'UNKNOWN';

export type BoardEligibilityExplain = {
  status: BoardEligibilityStatus;
  /** 主因 code（前端可 i18n） */
  codes: BoardEligibilityCode[];
  /** 中文可读原因（卡片直接展示；前端再尝试 localize） */
  reasons: string[];
  /** 原始门禁 failReason（如 L1-CLOSED,L1-WR） */
  gateFailReason: string | null;
  traderScore: number | null;
  enterScore: number;
  exitScore: number;
};

const GATE_LABEL_ZH: Record<string, string> = {
  'T1L-2': '预测样本数不足',
  'T1L-3': '收益曲线点位不足',
  'T1L-SPARSE': '持仓与预测样本过稀',
  'T1L-DENSITY': '账户过新且交易密度异常',
  'T1L-DD': '回撤相对盈利过大（轻量预检）',
  'L-PNL1Y': '近一年窗口净盈不足',
  'L-DUAL-SHORT': '近 7/30 日连续亏损',
  'L-HARD-SHORT': '近窗大幅亏损',
  'L1-DATA': '缺少可靠收益曲线数据',
  'L1-PNL': '窗口净盈不足',
  'L1-RET': '总回报率未达门槛',
  'L1-DD': '同窗回撤相对净盈过大',
  'L1-CLOSED': '已平仓市场样本不足',
  'L1-WR': '已平仓胜率未达门槛',
  'L1-PF': '盈利因子未达门槛',
  'L1-TRADES30D': '近 30 日成交过少',
  'L1-VOLUME': '成交额过低',
  'L1-DUST': '粉尘小单占比过高（历史硬门；现改为 HIGH_DUST_SHARE 软扣分）',
  'L1-MDD-PCT': '最大回撤比例超硬门',
};

function splitGateCodes(failReason: string | null | undefined): string[] {
  if (!failReason) return [];
  return failReason
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function formatGateFailReasonsZh(failReason: string | null | undefined): string[] {
  return splitGateCodes(failReason).map((code) => GATE_LABEL_ZH[code] ?? `未过门槛（${code}）`);
}

function uniqueReasons(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function buildBoardEligibilityExplain(input: {
  onBoard: boolean;
  blockedReason?: 'TIER1L' | 'L1_EARLY' | 'L1' | 'HARD_FLAG' | null;
  enterBlockedReason?:
    | 'SCORE_BELOW'
    | 'TIER2E'
    | 'HARD_FLAG'
    | 'COPY_NOT_READY'
    | 'COPY_TOO_LOW'
    | null;
  exitReason?: 'INACTIVE' | 'EXIT_SCORE' | 'HARD_FLAG' | 'COPY_TOO_LOW' | null;
  gateFailReason?: string | null;
  riskFlags?: string[] | null;
  traderScore?: number | null;
  score?: number | null;
  copyabilityScore?: number | null;
}): BoardEligibilityExplain {
  const enterScore = CONFIG.smartMoneyCopyPoolEnterScore;
  const exitScore = CONFIG.smartMoneyCopyPoolExitScore;
  const poolScore = resolveCopyPoolMetricScore({
    traderScore: input.traderScore,
    score: input.score ?? 0,
  });
  const traderScore =
    input.traderScore != null && Number.isFinite(input.traderScore)
      ? Math.round(input.traderScore * 100) / 100
      : poolScore;

  if (input.onBoard) {
    return {
      status: 'ON_BOARD',
      codes: ['ON_BOARD'],
      reasons: [],
      gateFailReason: null,
      traderScore,
      enterScore,
      exitScore,
    };
  }

  const codes: BoardEligibilityCode[] = [];
  const reasons: string[] = [];
  const gateLines = formatGateFailReasonsZh(input.gateFailReason);

  const push = (code: BoardEligibilityCode, line: string) => {
    codes.push(code);
    reasons.push(line);
  };

  if (input.blockedReason === 'TIER1L') {
    push('TIER1L', '未通过轻量入选门槛');
    reasons.push(...gateLines);
  } else if (input.blockedReason === 'L1_EARLY') {
    push('L1_EARLY', '收益曲线早筛未通过');
    reasons.push(...gateLines);
  } else if (input.blockedReason === 'L1') {
    push('L1', '未通过深度入选门槛');
    reasons.push(...gateLines);
  } else if (
    input.blockedReason === 'HARD_FLAG' ||
    input.enterBlockedReason === 'HARD_FLAG' ||
    input.exitReason === 'HARD_FLAG' ||
    hasCopyPoolHardFlag(input.riskFlags ?? [])
  ) {
    const flags = input.riskFlags ?? [];
    if (flags.includes('LOW_AVG_CLOSED_RETURN_RATE')) {
      const minPct = Math.round(CONFIG.smartMoneyMinAvgClosedReturnRate * 1000) / 10;
      push('HARD_FLAG', `平均盈利率低于 ${minPct}%，不适合进入推荐榜`);
    } else {
      push('HARD_FLAG', '触发硬风险旗标（如高频/对冲对等），不适合进入推荐榜');
    }
  } else if (input.exitReason === 'INACTIVE') {
    push('INACTIVE', '近期空仓且无成交，已退出推荐榜');
  } else if (
    input.exitReason === 'COPY_TOO_LOW' &&
    input.enterBlockedReason === 'COPY_NOT_READY'
  ) {
    push('COPY_NOT_READY', '仿跟单三情景尚未算完，暂不展示在推荐榜');
  } else if (input.exitReason === 'EXIT_SCORE' || input.exitReason === 'COPY_TOO_LOW') {
    if (input.exitReason === 'COPY_TOO_LOW') {
      push('COPY_TOO_LOW', '仿跟单得分过低，综合分未达要求，已退出推荐榜');
    } else {
      push(
        'EXIT_SCORE',
        `综合分 ${traderScore ?? '—'} 已低于出榜线 ${exitScore}，已退出推荐榜`
      );
    }
  } else if (input.enterBlockedReason === 'COPY_NOT_READY') {
    push('COPY_NOT_READY', '仿跟单三情景尚未算完，暂不展示在推荐榜');
  } else if (input.enterBlockedReason === 'COPY_TOO_LOW') {
    // 兼容旧数据：现网 copy=0 可入池，低分走 SCORE_BELOW；此码仅历史解释
    push('COPY_TOO_LOW', '仿跟单得分过低，综合分未达入榜要求');
  } else if (input.enterBlockedReason === 'TIER2E') {
    push('TIER2E', '增强层（流动性/收益分布）未通过');
  } else if (input.enterBlockedReason === 'SCORE_BELOW') {
    push(
      'SCORE_BELOW',
      `综合分 ${traderScore ?? '—'} 未达入榜线 ${enterScore}`
    );
  } else {
    // 只凭缓存指标推断（实时分析后读详情、或旧数据无 boardEligibility）
    if (hasCopyPoolHardFlag(input.riskFlags ?? [])) {
      const flags = input.riskFlags ?? [];
      if (flags.includes('LOW_AVG_CLOSED_RETURN_RATE')) {
        const minPct = Math.round(CONFIG.smartMoneyMinAvgClosedReturnRate * 1000) / 10;
        push('HARD_FLAG', `平均盈利率低于 ${minPct}%，不适合进入推荐榜`);
      } else {
        push('HARD_FLAG', '触发硬风险旗标，不适合进入推荐榜');
      }
    } else if (
      CONFIG.smartMoneyCopyReadyRequiredForPool &&
      !isCopyabilityComputed(input.copyabilityScore)
    ) {
      push('COPY_NOT_READY', '仿跟单三情景尚未算完，暂不展示在推荐榜');
    } else if (traderScore != null && traderScore < enterScore) {
      push('SCORE_BELOW', `综合分 ${traderScore} 未达入榜线 ${enterScore}`);
    } else if (gateLines.length > 0) {
      push('L1', '未通过入选门槛');
      reasons.push(...gateLines);
    } else {
      push('UNKNOWN', '已完成分析，但暂未达到跟单榜入榜条件');
    }
  }

  return {
    status: 'NOT_ON_BOARD',
    codes: codes.length ? codes : ['UNKNOWN'],
    reasons: uniqueReasons(reasons).slice(0, 8),
    gateFailReason: input.gateFailReason ?? null,
    traderScore,
    enterScore,
    exitScore,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** 从 scoreExplain 读取已持久化的资格说明 */
export function readBoardEligibilityFromExplain(
  scoreExplain: unknown
): BoardEligibilityExplain | null {
  if (!isRecord(scoreExplain)) return null;
  const raw = scoreExplain.boardEligibility;
  if (!isRecord(raw)) return null;
  const status = raw.status === 'ON_BOARD' ? 'ON_BOARD' : 'NOT_ON_BOARD';
  const codes = Array.isArray(raw.codes)
    ? (raw.codes.filter((c) => typeof c === 'string') as BoardEligibilityCode[])
    : [];
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((r): r is string => typeof r === 'string')
    : [];
  return {
    status,
    codes: codes.length ? codes : status === 'ON_BOARD' ? ['ON_BOARD'] : ['UNKNOWN'],
    reasons,
    gateFailReason: typeof raw.gateFailReason === 'string' ? raw.gateFailReason : null,
    traderScore:
      typeof raw.traderScore === 'number' && Number.isFinite(raw.traderScore)
        ? raw.traderScore
        : null,
    enterScore:
      typeof raw.enterScore === 'number' && Number.isFinite(raw.enterScore)
        ? raw.enterScore
        : CONFIG.smartMoneyCopyPoolEnterScore,
    exitScore:
      typeof raw.exitScore === 'number' && Number.isFinite(raw.exitScore)
        ? raw.exitScore
        : CONFIG.smartMoneyCopyPoolExitScore,
  };
}

/** 合并进 scoreExplain（不丢其它字段） */
export function mergeBoardEligibilityIntoExplain(
  scoreExplain: unknown,
  eligibility: BoardEligibilityExplain
): Record<string, unknown> {
  const base = isRecord(scoreExplain) ? { ...scoreExplain } : {};
  base.boardEligibility = eligibility;
  return base;
}
