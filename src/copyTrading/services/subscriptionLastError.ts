import type { CopySubscription } from '../../generated/prisma/client';
import { CopyTradeStatus } from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import { prisma } from '../../db';
import { formatUnderlyingFailureReason } from './copyExecutionErrorFormat';
import { isCopyTradeErrorRetryable } from './copyRetryPolicy';
import { describeCopyOrderErrorCode, describeRiskReason } from './riskService';

const TERMINAL_STATUSES: CopyTradeStatus[] = [
  CopyTradeStatus.failed,
  CopyTradeStatus.dead,
  CopyTradeStatus.skipped,
];

export type SubscriptionLastErrorDto = {
  status: string;
  lastErrorCode: string | null;
  lastErrorMsg: string | null;
  lastErrorAt: string;
  retryable?: boolean;
  suggestion?: string | null;
};

type LatestFailureRow = {
  subscriptionId: string;
  status: CopyTradeStatus;
  errorCode: string | null;
  errorMsg: string | null;
  updatedAt: Date;
  retryCount: number;
};

function truncateMsg(msg: string | null | undefined, maxLen = 500): string | null {
  const t = msg?.trim();
  if (!t) return null;
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

function buildSuggestion(
  errorCode: string | null,
  opts: { retryable: boolean; status: string }
): string | null {
  const code = errorCode?.trim();
  if (!code) return null;

  if (opts.retryable && opts.status === CopyTradeStatus.failed) {
    return '系统会按退避策略自动重试；也可在「执行记录」中查看详情。';
  }

  if (code === 'copy_funding_paused' || code === 'user_collateral_insufficient') {
    return '请充值 Polymarket 保证金或完成 USDC 授权后，在列表中点击「恢复跟单」。';
  }

  if (code === 'user_allowance_required' || code === 'user_token_approval_required') {
    return '请在钱包或 Polymarket 完成授权后重新开启跟单。';
  }

  const riskHint = describeRiskReason(code);
  if (riskHint) {
    return riskHint;
  }

  const orderHint = describeCopyOrderErrorCode(code);
  if (orderHint?.includes('建议') || orderHint?.includes('等待')) {
    return orderHint;
  }

  if (opts.status === CopyTradeStatus.dead) {
    return '该笔跟单已达最大重试次数，不会自动重试；请检查资金与参数后手动恢复跟单。';
  }

  if (opts.status === CopyTradeStatus.skipped) {
    return '本次 leader 成交已被跳过，通常无需处理；若持续出现请检查订阅限制与持仓。';
  }

  return null;
}

function fromSubscriptionFundingPause(sub: {
  fundingPausedAt: Date;
  fundingPausedCode: string | null;
  fundingPausedReason: string | null;
}): SubscriptionLastErrorDto {
  const code = sub.fundingPausedCode?.trim() || 'copy_funding_paused';
  const rawMsg = truncateMsg(sub.fundingPausedReason);
  return {
    status: 'funding_paused',
    lastErrorCode: code,
    lastErrorMsg: formatUnderlyingFailureReason(code, rawMsg),
    lastErrorAt: sub.fundingPausedAt.toISOString(),
    retryable: false,
    suggestion:
      buildSuggestion(code, { retryable: false, status: 'funding_paused' }) ??
      describeCopyOrderErrorCode(code),
  };
}

function fromTradeRow(row: LatestFailureRow): SubscriptionLastErrorDto {
  const code = row.errorCode?.trim() || null;
  const rawMsg = truncateMsg(row.errorMsg);
  const retryable =
    row.status === CopyTradeStatus.failed &&
    isCopyTradeErrorRetryable(code) &&
    row.retryCount < CONFIG.copyMaxRetries;

  return {
    status: row.status,
    lastErrorCode: code,
    lastErrorMsg: formatUnderlyingFailureReason(code, rawMsg),
    lastErrorAt: row.updatedAt.toISOString(),
    retryable,
    suggestion: buildSuggestion(code, { retryable, status: row.status }),
  };
}

async function loadLatestFailureBySubscriptionId(
  subscriptionIds: string[]
): Promise<Map<string, LatestFailureRow>> {
  if (subscriptionIds.length === 0) {
    return new Map();
  }

  // DISTINCT ON：每个订阅只取最近一条终态记录，避免 40 万+ copy_trades 全表扫入内存
  const rows = await prisma.$queryRaw<LatestFailureRow[]>`
    SELECT DISTINCT ON ("subscriptionId")
      "subscriptionId",
      status,
      "errorCode",
      "errorMsg",
      "updatedAt",
      "retryCount"
    FROM copy_trades
    WHERE "subscriptionId" IN (${Prisma.join(subscriptionIds)})
      AND status IN (${Prisma.join(TERMINAL_STATUSES)})
    ORDER BY "subscriptionId", "updatedAt" DESC
  `;

  return new Map(rows.map((row) => [row.subscriptionId, row]));
}

/**
 * 为订阅列表构建 lastError（funding pause 优先于最近失败/跳过行）。
 */
export async function buildLastErrorsForSubscriptions(
  subscriptions: Pick<
    CopySubscription,
    'id' | 'enabled' | 'fundingPausedAt' | 'fundingPausedCode' | 'fundingPausedReason'
  >[]
): Promise<Map<string, SubscriptionLastErrorDto | null>> {
  const result = new Map<string, SubscriptionLastErrorDto | null>();
  const failureBySub = await loadLatestFailureBySubscriptionId(subscriptions.map((s) => s.id));

  for (const sub of subscriptions) {
    const fundingPausedAt = sub.fundingPausedAt;
    if (!sub.enabled && fundingPausedAt) {
      result.set(
        sub.id,
        fromSubscriptionFundingPause({
          fundingPausedAt,
          fundingPausedCode: sub.fundingPausedCode,
          fundingPausedReason: sub.fundingPausedReason,
        })
      );
      continue;
    }

    const row = failureBySub.get(sub.id);
    if (!row) {
      result.set(sub.id, null);
      continue;
    }

    result.set(sub.id, fromTradeRow(row));
  }

  return result;
}
