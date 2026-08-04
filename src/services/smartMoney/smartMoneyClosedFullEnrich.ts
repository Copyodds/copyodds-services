/**
 * 入池后 Full closed 补全：从 Gate 续拉至 Full 上限，并刷新展示相关 closed 指标。
 */
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { mapPool } from '../../copyTrading/services/mapPool';
import { waitSmartMoneyRequestGap } from './smartMoneyRequestGap';
import {
  buildClosedMarketReturnDistribution,
  SMART_MONEY_PNL_WINDOW_DAYS,
  summarizeClosedPositionPnlStats,
} from './smartMoneyPositionStats';
import {
  isClosedSnapshotFresh,
  loadReadyClosedFetchResult,
  seedFullSnapshotFromGate,
} from './smartMoneyClosedSnapshot';
import { runClosedPrefetchForWallet } from './smartMoneyClosedPrefetch';
import { markSmartMoneyRanksDirty } from './smartMoneyLeaderboardWriter';

export type ClosedFullEnrichResult = {
  wallet: string;
  success: boolean;
  ready: boolean;
  refreshed: boolean;
  error?: string;
};

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

/** 入池且 Full 未 READY / 过期 */
export async function pickClosedFullEnrichBatch(
  limit = CONFIG.smartMoneyClosedFullEnrichBatchSize
): Promise<string[]> {
  const now = new Date();
  const rows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    orderBy: [
      { copyPoolEnteredAt: { sort: 'desc', nulls: 'last' } },
      { rank: { sort: 'asc', nulls: 'last' } },
    ],
    take: Math.max(limit * 5, limit),
    select: { wallet: true },
  });
  if (rows.length === 0) return [];

  const wallets = rows.map((r) => normalizeWallet(r.wallet));
  const snapshots = await prisma.smartMoneyClosedSnapshot.findMany({
    where: {
      wallet: { in: wallets },
      purpose: 'FULL',
      windowDays: SMART_MONEY_PNL_WINDOW_DAYS,
    },
    select: { wallet: true, status: true, expiresAt: true },
  });
  const byWallet = new Map(snapshots.map((s) => [s.wallet, s]));

  const need: string[] = [];
  for (const wallet of wallets) {
    const snap = byWallet.get(wallet);
    if (snap?.status === 'READY' && isClosedSnapshotFresh(snap.expiresAt, now.getTime())) {
      continue;
    }
    need.push(wallet);
    if (need.length >= limit) break;
  }
  return need;
}

async function refreshDisplayFromFullClosed(wallet: string): Promise<boolean> {
  const full = await loadReadyClosedFetchResult(wallet, 'FULL');
  if (!full) return false;

  const closedStats =
    full.rows.length > 0 ? summarizeClosedPositionPnlStats(full.rows) : null;
  const closedMarketReturnDistribution = buildClosedMarketReturnDistribution(full.rows);
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet },
    select: { scoreExplain: true },
  });
  if (!row) return false;

  const prevExplain =
    row.scoreExplain && typeof row.scoreExplain === 'object' && !Array.isArray(row.scoreExplain)
      ? (row.scoreExplain as Record<string, unknown>)
      : {};

  const mergedExplain: Record<string, unknown> = {
    ...prevExplain,
    closedPositions: {
      ...(typeof prevExplain.closedPositions === 'object' && prevExplain.closedPositions != null
        ? (prevExplain.closedPositions as Record<string, unknown>)
        : {}),
      marketCount: closedStats?.marketCount ?? null,
      decisiveMarkets: closedStats?.decisiveMarkets ?? null,
      marketWinRate: closedStats?.marketWinRate ?? null,
      profitFactor: closedStats?.profitFactor ?? null,
      totalRealizedPnl: closedStats?.totalRealizedPnl ?? null,
      sampleSize: closedStats?.sampleSize ?? null,
      fullEnrichAt: new Date().toISOString(),
    },
    closedMarketReturnDistribution,
    closedSample: full.meta,
    closedFullEnrichAt: new Date().toISOString(),
  };

  const displayProfile =
    typeof prevExplain.displayProfile === 'object' && prevExplain.displayProfile != null
      ? {
          ...(prevExplain.displayProfile as Record<string, unknown>),
          winRate: closedStats?.marketWinRate ?? null,
          profitFactor: closedStats?.profitFactor ?? null,
        }
      : {
          winRate: closedStats?.marketWinRate ?? null,
          profitFactor: closedStats?.profitFactor ?? null,
        };

  mergedExplain.displayProfile = displayProfile;

  await prisma.smartMoneyLeaderboardRow.update({
    where: { wallet },
    data: {
      scoreExplain: mergedExplain as Prisma.InputJsonValue,
    },
  });

  await prisma.smartMoneyScoreCache
    .updateMany({
      where: { wallet },
      data: {
        scoreExplain: mergedExplain as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
    })
    .catch(() => undefined);

  return true;
}

export async function runClosedFullEnrichForWallet(
  wallet: string
): Promise<ClosedFullEnrichResult> {
  const normalized = normalizeWallet(wallet);
  try {
    await waitSmartMoneyRequestGap();
    await seedFullSnapshotFromGate(normalized);

    let ready = false;
    let pages = 0;
    // 单钱包最多续拉若干 tick，避免一次占死
    for (let i = 0; i < 4; i += 1) {
      const r = await runClosedPrefetchForWallet(normalized, 'FULL');
      pages += r.pagesFetched;
      if (!r.success) {
        return {
          wallet: normalized,
          success: false,
          ready: false,
          refreshed: false,
          error: r.error ?? 'full_prefetch_failed',
        };
      }
      if (r.ready) {
        ready = true;
        break;
      }
      if (r.pagesFetched === 0) break;
    }

    let refreshed = false;
    if (ready) {
      refreshed = await refreshDisplayFromFullClosed(normalized);
      if (refreshed) markSmartMoneyRanksDirty();
    }

    return { wallet: normalized, success: true, ready, refreshed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      wallet: normalized,
      success: false,
      ready: false,
      refreshed: false,
      error: message,
    };
  }
}

export async function runSmartMoneyClosedFullEnrichBatch(
  reason = 'interval:closed-full-enrich'
): Promise<{
  picked: number;
  ok: number;
  failed: number;
  ready: number;
  refreshed: number;
  reason: string;
}> {
  if (!CONFIG.smartMoneyClosedFullEnrichEnabled) {
    return {
      picked: 0,
      ok: 0,
      failed: 0,
      ready: 0,
      refreshed: 0,
      reason: `${reason}:disabled`,
    };
  }

  const wallets = await pickClosedFullEnrichBatch();
  const results = await mapPool(
    wallets,
    Math.min(2, CONFIG.smartMoneyClosedPrefetchConcurrency),
    (wallet) => runClosedFullEnrichForWallet(wallet)
  );

  let ok = 0;
  let failed = 0;
  let ready = 0;
  let refreshed = 0;
  for (const r of results) {
    if (r.success) ok += 1;
    else failed += 1;
    if (r.ready) ready += 1;
    if (r.refreshed) refreshed += 1;
  }

  return { picked: wallets.length, ok, failed, ready, refreshed, reason };
}
