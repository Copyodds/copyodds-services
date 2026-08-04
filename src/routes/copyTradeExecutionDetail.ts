/** 跟单执行/结算详情：仅持仓中或已结算可查看。 */

/** Keep in sync with `COPY_LOT_DUST_SHARES` in copyPositionLots.ts */
const OPEN_LOT_DUST_SHARES = 0.01;

export type ExecutionDetailViewState = 'open' | 'settled';

export type ExecutionDetailViewInput = {
  status: string;
  side: string;
  openLotRemaining?: string | null;
  settlementType?: string | null;
  _lifecycle?: unknown;
};

export type ExecutionDetailTimelineEvent = {
  phase: 'buy' | 'settlement';
  title: string;
  at: string;
  side?: string;
  price?: string | null;
  size?: string | null;
  /** Leader / trade wallet address for buy fills. */
  leaderAddress?: string | null;
  settlementType?: string | null;
  realizedPnlUsd?: string | null;
  settlementResult?: string | null;
};

function isSettledForDetail(item: ExecutionDetailViewInput): boolean {
  if (item.settlementType) return true;
  if (item._lifecycle) return true;
  return false;
}

function isOpenBuyPosition(item: ExecutionDetailViewInput): boolean {
  if (item.status.trim().toLowerCase() !== 'filled') return false;
  const side = item.side.trim().toUpperCase();
  if (!side.includes('BUY') || side.includes('SELL')) return false;
  const rem =
    item.openLotRemaining != null && item.openLotRemaining !== ''
      ? Number(item.openLotRemaining)
      : null;
  return rem != null && Number.isFinite(rem) && rem > OPEN_LOT_DUST_SHARES;
}

/** 列表/详情统一：是否允许进入详情页。 */
export function resolveExecutionDetailViewState(
  item: ExecutionDetailViewInput
): ExecutionDetailViewState | null {
  if (isSettledForDetail(item)) return 'settled';
  if (isOpenBuyPosition(item)) return 'open';
  return null;
}

export function isExecutionDetailViewable(item: ExecutionDetailViewInput): boolean {
  return resolveExecutionDetailViewState(item) != null;
}

function settlementPhaseTitle(settlementType: string | null | undefined): string {
  switch (settlementType) {
    case 'redeem':
      return '赎回结算';
    case 'expired_worthless':
      return '到期归零';
    case 'market_sell':
      return '平仓结算';
    default:
      return '结算';
  }
}

type TimelineRow = ExecutionDetailViewInput & {
  id?: string;
  price?: string;
  size?: string;
  closedSize?: string | null;
  createdAt?: string;
  leaderAddress?: string | null;
  realizedPnlUsd?: string | null;
  settlementResult?: string | null;
  settlementType?: string | null;
};

type LifecycleBuySettlement = {
  buy?: TimelineRow;
  /** One settlement closing multiple entries → all buy legs for the detail timeline. */
  buys?: TimelineRow[];
  settlement?: TimelineRow;
};

export function buildExecutionDetailTimeline(
  item: TimelineRow & {
    _lifecycle?: LifecycleBuySettlement;
  },
  viewState: ExecutionDetailViewState
): ExecutionDetailTimelineEvent[] {
  const events: ExecutionDetailTimelineEvent[] = [];

  const pushBuy = (row: TimelineRow) => {
    if (!row.createdAt) return;
    const leaderAddress = row.leaderAddress?.trim() || null;
    events.push({
      phase: 'buy',
      title: '买入成交',
      at: row.createdAt,
      side: row.side,
      price: row.price ?? null,
      size: row.size ?? null,
      leaderAddress,
    });
  };

  const pushSettlement = (row: TimelineRow) => {
    if (!row.createdAt) return;
    events.push({
      phase: 'settlement',
      title: settlementPhaseTitle(row.settlementType),
      at: row.createdAt,
      side: row.side,
      price: row.price ?? null,
      size: row.size ?? row.closedSize ?? null,
      settlementType: row.settlementType ?? null,
      realizedPnlUsd: row.realizedPnlUsd ?? null,
      settlementResult: row.settlementResult ?? null,
    });
  };

  const lifecycleBuys =
    item._lifecycle?.buys?.length
      ? item._lifecycle.buys
      : item._lifecycle?.buy
        ? [item._lifecycle.buy]
        : [];
  if (lifecycleBuys.length) {
    for (const buy of lifecycleBuys) pushBuy(buy);
  } else if (viewState === 'open' || item.side.trim().toUpperCase().includes('BUY')) {
    pushBuy(item);
  }

  if (viewState === 'settled') {
    const settlement = item._lifecycle?.settlement ?? item;
    pushSettlement(settlement);
  }

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
