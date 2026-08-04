import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  fetchPolymarketProfile,
  type PolymarketProfileCurvePeriod,
  type PolymarketProfileFetchResult,
} from '../polymarket/polymarketProfile';

const PROFILE_PERSIST_TX_TIMEOUT_MS = 15_000;
const CURVE_INSERT_BATCH_SIZE = 200;
/** 重建画像至少需要这么多曲线点，否则视为不完整强制 live */
const MIN_CURVE_POINTS_FOR_SNAPSHOT_REUSE = 2;

function buildSnapshotCreateInput(profile: PolymarketProfileFetchResult) {
  // 固化标准化总量字段，避免后续快照重建依赖不同采集源的 rawSummary 结构。
  const rawSummary = {
    ...profile.rawSummary,
    totalPnl: profile.totalPnl,
    totalVolume: profile.totalVolume,
  };
  return {
    wallet: profile.wallet,
    snapshotAt: profile.snapshotAt,
    profileSlug: profile.profileSlug,
    displayName: profile.displayName,
    joinedAtText: profile.joinedAtText,
    viewsText: profile.viewsText,
    holdingsValue: profile.holdingsValue != null ? new Prisma.Decimal(profile.holdingsValue) : null,
    biggestWin: profile.biggestWin != null ? new Prisma.Decimal(profile.biggestWin) : null,
    predictionCount: profile.predictionCount,
    rawSummary: rawSummary as Prisma.InputJsonValue,
    sourceUrl: profile.sourceUrl,
  };
}

function buildCurveCreateManyInput(profile: PolymarketProfileFetchResult) {
  return profile.curves.map((point) => ({
    wallet: profile.wallet,
    curveType: point.curveType,
    ts: point.ts,
    value: new Prisma.Decimal(point.value),
    snapshotAt: profile.snapshotAt,
  }));
}

async function retainRecentTraderHistory(
  tx: Prisma.TransactionClient,
  wallet: string,
  keepSnapshots = 10
): Promise<void> {
  const oldSnapshots = await tx.traderProfileSnapshot.findMany({
    where: { wallet },
    orderBy: { snapshotAt: 'desc' },
    skip: keepSnapshots,
    select: { id: true },
  });
  if (oldSnapshots.length === 0) return;
  await tx.traderProfileSnapshot.deleteMany({
    where: { id: { in: oldSnapshots.map((row) => row.id) } },
  });
}

export async function persistPolymarketProfileSnapshot(
  profile: PolymarketProfileFetchResult
): Promise<void> {
  const curveRows = buildCurveCreateManyInput(profile);
  // 曲线批量写在事务外先行：曲线按 (wallet, snapshotAt) 关联，快照行才是“提交标记”。
  // 曲线写失败时快照行不会创建，读侧（loadFreshPolymarketProfileSnapshot）不可见，
  // 孤儿曲线点由 prune 清理。这样交互式事务只剩快照 + upsert，持连时间从数十秒降到亚秒级。
  for (let i = 0; i < curveRows.length; i += CURVE_INSERT_BATCH_SIZE) {
    const batch = curveRows.slice(i, i + CURVE_INSERT_BATCH_SIZE);
    if (batch.length === 0) continue;
    await prisma.traderCurvePoint.createMany({ data: batch });
  }
  await prisma.$transaction(
    async (tx) => {
      await tx.traderProfileSnapshot.create({
        data: buildSnapshotCreateInput(profile),
      });
      await tx.observedTrader.upsert({
        where: { wallet: profile.wallet },
        create: {
          wallet: profile.wallet,
          profileSlug: profile.profileSlug,
          lastFetchedAt: profile.snapshotAt,
          fetchFailCount: 0,
          lastFetchError: null,
          lastFetchStatus: 'PIPELINE_FETCH',
          nextRetryAt: null,
          candidateActive: true,
          candidatePeriods: [],
          candidateCategories: ['OVERALL'],
          candidateSourceVersion: 0,
          candidateLastSeenAt: profile.snapshotAt,
          enabled: true,
          blacklisted: false,
          noiseTags: [],
          lastSeenAt: profile.snapshotAt,
          pipelineStage: 'LEGACY',
        },
        update: {
          profileSlug: profile.profileSlug,
          lastFetchedAt: profile.snapshotAt,
          fetchFailCount: 0,
          lastFetchError: null,
          lastFetchStatus: 'PIPELINE_FETCH',
          nextRetryAt: null,
          lastSeenAt: profile.snapshotAt,
        },
      });
      await retainRecentTraderHistory(tx, profile.wallet);
    },
    { timeout: PROFILE_PERSIST_TX_TIMEOUT_MS, maxWait: 15_000 }
  );
}

function periodFromCurveType(curveType: string): PolymarketProfileCurvePeriod {
  if (curveType.endsWith('_1D')) return '1D';
  if (curveType.endsWith('_1W')) return '1W';
  if (curveType.endsWith('_1M')) return '1M';
  return 'ALL';
}

function decimalToString(value: Prisma.Decimal | null | undefined): string | null {
  if (value == null) return null;
  return value.toString();
}

function numberToString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return value;
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 兼容 HTML 与 API fallback 两种快照结构。
 * API fallback 把总量写在 leaderboardStats；旧实现只读 volumeSummary，导致复评时变 null。
 */
export function extractProfileTotalsFromRawSummary(rawSummaryValue: unknown): {
  totalPnl: string | null;
  totalVolume: string | null;
} {
  const rawSummary = objectRecord(rawSummaryValue) ?? {};
  const volumeSummary = objectRecord(rawSummary.volumeSummary);
  const leaderboardStats = objectRecord(rawSummary.leaderboardStats);

  return {
    totalPnl:
      numberToString(rawSummary.totalPnl) ??
      numberToString(volumeSummary?.pnl) ??
      numberToString(leaderboardStats?.totalPnl) ??
      numberToString(leaderboardStats?.pnl),
    totalVolume:
      numberToString(rawSummary.totalVolume) ??
      numberToString(volumeSummary?.amount) ??
      numberToString(volumeSummary?.volume) ??
      numberToString(volumeSummary?.totalVolume) ??
      numberToString(leaderboardStats?.totalVolume) ??
      numberToString(leaderboardStats?.vol),
  };
}

function rebuildProfileFromSnapshot(input: {
  wallet: string;
  snapshot: {
    snapshotAt: Date;
    profileSlug: string | null;
    displayName: string | null;
    joinedAtText: string | null;
    viewsText: string | null;
    holdingsValue: Prisma.Decimal | null;
    biggestWin: Prisma.Decimal | null;
    predictionCount: number | null;
    rawSummary: Prisma.JsonValue | null;
    sourceUrl: string | null;
  };
  curvePoints: Array<{ curveType: string; ts: Date; value: Prisma.Decimal }>;
}): PolymarketProfileFetchResult | null {
  if (input.curvePoints.length < MIN_CURVE_POINTS_FOR_SNAPSHOT_REUSE) {
    return null;
  }

  const rawSummary =
    input.snapshot.rawSummary != null &&
    typeof input.snapshot.rawSummary === 'object' &&
    !Array.isArray(input.snapshot.rawSummary)
      ? (input.snapshot.rawSummary as Record<string, unknown>)
      : {};

  const totals = extractProfileTotalsFromRawSummary(rawSummary);

  const social =
    rawSummary.social != null && typeof rawSummary.social === 'object' && !Array.isArray(rawSummary.social)
      ? (rawSummary.social as { xUsername?: unknown; profileImage?: unknown })
      : null;

  const userData =
    rawSummary.userData != null && typeof rawSummary.userData === 'object' && !Array.isArray(rawSummary.userData)
      ? (rawSummary.userData as { username?: unknown })
      : null;

  const curves = input.curvePoints.map((point) => ({
    curveType: point.curveType,
    period: periodFromCurveType(point.curveType),
    ts: point.ts,
    value: point.value.toString(),
  }));

  return {
    wallet: input.wallet.toLowerCase(),
    profileSlug: input.snapshot.profileSlug,
    displayName: input.snapshot.displayName,
    username:
      typeof userData?.username === 'string'
        ? userData.username
        : input.snapshot.profileSlug,
    xUsername: typeof social?.xUsername === 'string' ? social.xUsername : null,
    profileImage: typeof social?.profileImage === 'string' ? social.profileImage : null,
    joinedAtText: input.snapshot.joinedAtText,
    viewsText: input.snapshot.viewsText,
    holdingsValue: decimalToString(input.snapshot.holdingsValue),
    biggestWin: decimalToString(input.snapshot.biggestWin),
    predictionCount: input.snapshot.predictionCount,
    totalPnl: totals.totalPnl,
    totalVolume: totals.totalVolume,
    sourceUrl: input.snapshot.sourceUrl ?? `https://polymarket.com/profile/${input.wallet}`,
    snapshotAt: input.snapshot.snapshotAt,
    curves,
    profilePnlApiFilledPeriods: Array.isArray(rawSummary.profilePnlApiFilledPeriods)
      ? (rawSummary.profilePnlApiFilledPeriods as PolymarketProfileCurvePeriod[])
      : [],
    rawSummary,
  };
}

/**
 * 读取钱包最新 Profile 快照；超过 ttlMs（相对 snapshotAt）则视为过期返回 null。
 */
export async function loadFreshPolymarketProfileSnapshot(
  wallet: string,
  ttlMs: number
): Promise<PolymarketProfileFetchResult | null> {
  const normalized = wallet.trim().toLowerCase();
  if (!normalized) return null;
  const latest = await prisma.traderProfileSnapshot.findFirst({
    where: { wallet: normalized },
    orderBy: [{ snapshotAt: 'desc' }, { id: 'desc' }],
  });
  if (latest == null) return null;
  if (Date.now() - latest.snapshotAt.getTime() > ttlMs) {
    return null;
  }

  const curvePoints = await prisma.traderCurvePoint.findMany({
    where: {
      wallet: normalized,
      snapshotAt: latest.snapshotAt,
    },
    orderBy: [{ curveType: 'asc' }, { ts: 'asc' }],
    select: { curveType: true, ts: true, value: true },
  });

  return rebuildProfileFromSnapshot({
    wallet: normalized,
    snapshot: latest,
    curvePoints,
  });
}

export type ResolvePolymarketProfileResult = {
  profile: PolymarketProfileFetchResult;
  source: 'snapshot' | 'live';
};

/**
 * 升池/评分用 Profile：TTL 内复用 DB 快照，过期强制 live 抓取并落库。
 * 共享只省同窗重复 HTTP，不延长判决数据寿命。
 */
export async function resolvePolymarketProfileForAnalyze(
  wallet: string,
  options?: { ttlMs?: number; forceLive?: boolean }
): Promise<ResolvePolymarketProfileResult> {
  const forceLive = options?.forceLive === true;
  if (!forceLive) {
    const ttlMs = options?.ttlMs ?? CONFIG.smartMoneyProfileSnapshotTtlMs;
    const fromSnapshot = await loadFreshPolymarketProfileSnapshot(wallet, ttlMs);
    if (fromSnapshot != null) {
      return { profile: fromSnapshot, source: 'snapshot' };
    }
  }
  const profile = await fetchPolymarketProfile(wallet, {
    // Deep-Core 热路径只拉 7D+ALL（评分/门槛够用）；30D 入榜后由 Curve Enrich 补；1D 仅详情 live
    pnlPeriods: ['1W', 'ALL'],
  });
  await persistPolymarketProfileSnapshot(profile);
  return { profile, source: 'live' };
}
