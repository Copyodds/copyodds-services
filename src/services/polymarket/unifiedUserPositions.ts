import type { OpenCopyLotDto } from '../../copyTrading/services/copyPositionLots';
import { classifyPosition } from './positionClassifier';
import type { DataApiPosition } from './polymarketData';
import {
  buildSettlementFields,
  deriveSettlementStatus,
  normalizePositionTokenId,
  type SettlementFields,
  type SettlementStatus,
} from './settlementStatus';
import type { UserDisplayPositionsPartition } from './positionVisibility';

const EPS = 1e-9;

export type UserPositionsSummary = {
  activeCount: number;
  pendingSettlementCount: number;
  redeemableCount: number;
  totalOpenLotCount: number;
};

export type SettlementEnrichedPosition = DataApiPosition & {
  category: ReturnType<typeof classifyPosition>;
  settlementStatus: SettlementStatus;
  settlementHint: string;
  suggestedAction: SettlementFields['suggestedAction'];
  canClose: boolean;
  canRedeem: boolean;
};

function findApiPosition(raw: DataApiPosition[], tokenKey: string): DataApiPosition | null {
  return raw.find((p) => normalizePositionTokenId(p.asset) === tokenKey) ?? null;
}

function lotRemainingSize(lots: OpenCopyLotDto[] | undefined): number {
  if (!lots?.length) return 0;
  return lots.reduce((sum, lot) => {
    const n = Number(lot.remainingSize);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

function buildPositionSize(apiPos: DataApiPosition | null, lotSize: number): number {
  const apiSize = apiPos?.size ?? 0;
  if (lotSize > EPS) return lotSize;
  return apiSize > EPS ? apiSize : 0;
}

function buildSyntheticPosition(params: {
  tokenKey: string;
  apiPos: DataApiPosition | null;
  lots: OpenCopyLotDto[] | undefined;
}): DataApiPosition {
  const lotSize = lotRemainingSize(params.lots);
  const size = buildPositionSize(params.apiPos, lotSize);
  const base = params.apiPos ?? {
    asset: params.lots?.[0]?.tokenID ?? params.tokenKey,
    conditionId: '',
    size,
    redeemable: false,
  };
  return {
    ...base,
    asset: base.asset || params.lots?.[0]?.tokenID || params.tokenKey,
    size,
  };
}

export function buildPendingSettlementPositions(params: {
  raw: DataApiPosition[];
  partitioned: UserDisplayPositionsPartition;
  openLotsByToken: Map<string, OpenCopyLotDto[]>;
}): SettlementEnrichedPosition[] {
  const { raw, partitioned, openLotsByToken } = params;
  const displayTokens = new Set(
    partitioned.displayRaw.map((p) => normalizePositionTokenId(p.asset))
  );
  const worthlessHidden = partitioned.worthlessHiddenAssets;
  const staleHidden = partitioned.staleHiddenAssets;
  const dustHidden = partitioned.hiddenDustAssets;

  const tokenKeys = new Set<string>();
  for (const p of raw) {
    if (p.size > EPS) tokenKeys.add(normalizePositionTokenId(p.asset));
  }
  for (const key of openLotsByToken.keys()) {
    tokenKeys.add(normalizePositionTokenId(key));
  }

  const pending: SettlementEnrichedPosition[] = [];

  for (const tokenKey of tokenKeys) {
    if (displayTokens.has(tokenKey)) continue;

    const apiPos = findApiPosition(raw, tokenKey);
    const lots = openLotsByToken.get(tokenKey);
    const hasOpenLots = lotRemainingSize(lots) > EPS;
    const asset = apiPos?.asset ?? lots?.[0]?.tokenID;
    if (!asset) continue;

    const status = deriveSettlementStatus({
      apiPos,
      hasOpenLots,
      inDisplayRaw: false,
      isWorthlessHidden: worthlessHidden.has(asset),
      isStaleHidden: staleHidden.has(asset),
      isDustHidden: dustHidden.has(asset),
    });

    if (status === 'active' || status === 'redeemable') continue;
    // 链上已归零（settled_loss）只在后台关账，不占待结算 Tab。
    if (status === 'settled_loss') continue;
    // 待结算 Tab 只展示跟单账本仍有 open lot 的 token；链上 worthless 余量不再占位。
    if (!hasOpenLots) continue;

    const synthetic = buildSyntheticPosition({ tokenKey, apiPos, lots });
    const fields = buildSettlementFields(status, apiPos);
    pending.push({
      ...synthetic,
      category: classifyPosition(synthetic),
      ...fields,
    });
  }

  pending.sort((a, b) => a.asset.localeCompare(b.asset));
  return pending;
}

export function enrichDisplayPositionWithSettlementLite(
  p: DataApiPosition,
  partitioned: UserDisplayPositionsPartition,
  openLotTokenKeys: Set<string>
): SettlementEnrichedPosition {
  const tokenKey = normalizePositionTokenId(p.asset);
  const hasOpenLots = openLotTokenKeys.has(tokenKey);
  const status = deriveSettlementStatus({
    apiPos: p,
    hasOpenLots,
    inDisplayRaw: true,
    isWorthlessHidden: partitioned.worthlessHiddenAssets.has(p.asset),
    isStaleHidden: partitioned.staleHiddenAssets.has(p.asset),
    isDustHidden: partitioned.hiddenDustAssets.has(p.asset),
  });
  const fields = buildSettlementFields(status, p);
  return {
    ...p,
    category: classifyPosition(p),
    ...fields,
  };
}

export function countPendingSettlementPositions(params: {
  raw: DataApiPosition[];
  partitioned: UserDisplayPositionsPartition;
  openLotTokenKeys: Set<string>;
}): number {
  const { raw, partitioned, openLotTokenKeys } = params;
  const displayTokens = new Set(
    partitioned.displayRaw.map((p) => normalizePositionTokenId(p.asset))
  );
  const worthlessHidden = partitioned.worthlessHiddenAssets;
  const staleHidden = partitioned.staleHiddenAssets;
  const dustHidden = partitioned.hiddenDustAssets;

  const tokenKeys = new Set<string>();
  for (const p of raw) {
    if (p.size > EPS) tokenKeys.add(normalizePositionTokenId(p.asset));
  }
  for (const key of openLotTokenKeys) {
    tokenKeys.add(normalizePositionTokenId(key));
  }

  let count = 0;
  for (const tokenKey of tokenKeys) {
    if (displayTokens.has(tokenKey)) continue;

    const apiPos = findApiPosition(raw, tokenKey);
    const hasOpenLots = openLotTokenKeys.has(tokenKey);
    const asset = apiPos?.asset ?? tokenKey;
    if (!asset) continue;

    const status = deriveSettlementStatus({
      apiPos,
      hasOpenLots,
      inDisplayRaw: false,
      isWorthlessHidden: worthlessHidden.has(asset),
      isStaleHidden: staleHidden.has(asset),
      isDustHidden: dustHidden.has(asset),
    });

    if (status === 'active' || status === 'redeemable') continue;
    if (status === 'settled_loss') continue;
    if (!hasOpenLots) continue;
    count += 1;
  }
  return count;
}

export function enrichDisplayPositionWithSettlement(
  p: DataApiPosition,
  partitioned: UserDisplayPositionsPartition,
  openLotsByToken: Map<string, OpenCopyLotDto[]>
): SettlementEnrichedPosition {
  const tokenKey = normalizePositionTokenId(p.asset);
  const lots = openLotsByToken.get(tokenKey);
  const hasOpenLots = lotRemainingSize(lots) > EPS;
  const status = deriveSettlementStatus({
    apiPos: p,
    hasOpenLots,
    inDisplayRaw: true,
    isWorthlessHidden: partitioned.worthlessHiddenAssets.has(p.asset),
    isStaleHidden: partitioned.staleHiddenAssets.has(p.asset),
    isDustHidden: partitioned.hiddenDustAssets.has(p.asset),
  });
  const fields = buildSettlementFields(status, p);
  return {
    ...p,
    category: classifyPosition(p),
    ...fields,
  };
}

export function buildUserPositionsSummary(params: {
  displayPositions: SettlementEnrichedPosition[];
  pendingSettlement?: SettlementEnrichedPosition[];
  pendingSettlementCount?: number;
  openLotsByToken?: Map<string, OpenCopyLotDto[]>;
  totalOpenLotCount?: number;
}): UserPositionsSummary {
  let totalOpenLotCount = params.totalOpenLotCount ?? 0;
  if (params.totalOpenLotCount == null && params.openLotsByToken) {
    for (const lots of params.openLotsByToken.values()) {
      totalOpenLotCount += lots.length;
    }
  }
  const pendingSettlementCount =
    params.pendingSettlementCount ??
    params.pendingSettlement?.length ??
    0;
  return {
    activeCount: params.displayPositions.filter((p) => p.settlementStatus === 'active').length,
    redeemableCount: params.displayPositions.filter((p) => p.settlementStatus === 'redeemable')
      .length,
    pendingSettlementCount,
    totalOpenLotCount,
  };
}
