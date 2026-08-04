import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import {
  buildCopierFeedbackSnapshot,
  emptyCopierFeedbackSnapshot,
  type CopierFeedbackSnapshot,
} from './smartMoneyCopierFeedbackMetrics';

export type { CopierFeedbackSnapshot } from './smartMoneyCopierFeedbackMetrics';
export {
  buildCopierFeedbackSnapshot,
  computeCopierRoi,
  computeCopierSampleWeight,
  emptyCopierFeedbackSnapshot,
} from './smartMoneyCopierFeedbackMetrics';

type LotCloseAggregateRow = {
  wallet: string;
  close_count: number;
  subscriber_count: number;
  total_pnl: string;
  total_notional: string;
};

type TradeAggregateRow = {
  wallet: string;
  trade_count: number;
  total_pnl: string;
  total_notional: string;
};

type AntiCheatAggregateRow = {
  wallet: string;
  excluded_self_copy_count: number;
  top_subscriber_share: string | null;
};

function toNumber(value: string | Prisma.Decimal | null | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeAggregateMaps(
  lotCloses: LotCloseAggregateRow[],
  trades: TradeAggregateRow[]
): Map<string, { closeCount: number; tradeCount: number; subscriberCount: number; totalPnlUsd: number; totalNotionalUsd: number }> {
  const merged = new Map<
    string,
    {
      closeCount: number;
      tradeCount: number;
      subscriberCount: number;
      totalPnlUsd: number;
      totalNotionalUsd: number;
    }
  >();

  for (const row of lotCloses) {
    const wallet = row.wallet.toLowerCase();
    merged.set(wallet, {
      closeCount: row.close_count,
      tradeCount: 0,
      subscriberCount: row.subscriber_count,
      totalPnlUsd: toNumber(row.total_pnl),
      totalNotionalUsd: toNumber(row.total_notional),
    });
  }

  for (const row of trades) {
    const wallet = row.wallet.toLowerCase();
    const existing = merged.get(wallet) ?? {
      closeCount: 0,
      tradeCount: 0,
      subscriberCount: 0,
      totalPnlUsd: 0,
      totalNotionalUsd: 0,
    };
    existing.tradeCount = row.trade_count;
    if (existing.closeCount === 0) {
      existing.totalPnlUsd = toNumber(row.total_pnl);
      existing.totalNotionalUsd = toNumber(row.total_notional);
    }
    merged.set(wallet, existing);
  }

  return merged;
}

const SELF_COPY_EXCLUSION_SQL = Prisma.sql`
  AND NOT EXISTS (
    SELECT 1
    FROM "Wallet" w
    WHERE w."userId" = cs."userId"
      AND LOWER(w.address) = LOWER(cl.address)
  )
`;

async function fetchLotCloseAggregates(
  cutoff: Date,
  wallets?: string[]
): Promise<LotCloseAggregateRow[]> {
  if (wallets != null && wallets.length === 0) return [];

  if (wallets != null) {
    const normalized = wallets.map((wallet) => wallet.toLowerCase());
    return prisma.$queryRaw<LotCloseAggregateRow[]>`
      SELECT
        LOWER(cl.address) AS wallet,
        COUNT(cplc.id)::int AS close_count,
        COUNT(DISTINCT cs."userId")::int AS subscriber_count,
        COALESCE(SUM(cplc."realizedPnlUsd"), 0)::text AS total_pnl,
        COALESCE(SUM(cplc."costBasisUsd"), 0)::text AS total_notional
      FROM copy_position_lot_closes cplc
      INNER JOIN "CopySubscription" cs ON cs.id = cplc."subscriptionId"
      INNER JOIN "CopyLeader" cl ON cl.id = cs."leaderId"
      WHERE cplc."createdAt" >= ${cutoff}
        AND cs."deletedAt" IS NULL
        AND LOWER(cl.address) = ANY(${normalized}::text[])
        ${SELF_COPY_EXCLUSION_SQL}
      GROUP BY LOWER(cl.address)
    `;
  }

  return prisma.$queryRaw<LotCloseAggregateRow[]>`
    SELECT
      LOWER(cl.address) AS wallet,
      COUNT(cplc.id)::int AS close_count,
      COUNT(DISTINCT cs."userId")::int AS subscriber_count,
      COALESCE(SUM(cplc."realizedPnlUsd"), 0)::text AS total_pnl,
      COALESCE(SUM(cplc."costBasisUsd"), 0)::text AS total_notional
    FROM copy_position_lot_closes cplc
    INNER JOIN "CopySubscription" cs ON cs.id = cplc."subscriptionId"
    INNER JOIN "CopyLeader" cl ON cl.id = cs."leaderId"
    WHERE cplc."createdAt" >= ${cutoff}
      AND cs."deletedAt" IS NULL
      ${SELF_COPY_EXCLUSION_SQL}
    GROUP BY LOWER(cl.address)
  `;
}

async function fetchAntiCheatAggregates(
  cutoff: Date,
  wallets?: string[]
): Promise<Map<string, AntiCheatAggregateRow>> {
  if (wallets != null && wallets.length === 0) return new Map();

  const walletFilter =
    wallets != null
      ? Prisma.sql`AND LOWER(cl.address) = ANY(${wallets.map((wallet) => wallet.toLowerCase())}::text[])`
      : Prisma.empty;

  const [excludedRows, shareRows] = await Promise.all([
    prisma.$queryRaw<Array<{ wallet: string; excluded_self_copy_count: number }>>`
      SELECT
        LOWER(cl.address) AS wallet,
        COUNT(cplc.id)::int AS excluded_self_copy_count
      FROM copy_position_lot_closes cplc
      INNER JOIN "CopySubscription" cs ON cs.id = cplc."subscriptionId"
      INNER JOIN "CopyLeader" cl ON cl.id = cs."leaderId"
      WHERE cplc."createdAt" >= ${cutoff}
        AND cs."deletedAt" IS NULL
        ${walletFilter}
        AND EXISTS (
          SELECT 1
          FROM "Wallet" w
          WHERE w."userId" = cs."userId"
            AND LOWER(w.address) = LOWER(cl.address)
        )
      GROUP BY LOWER(cl.address)
    `,
    prisma.$queryRaw<Array<{ wallet: string; top_subscriber_share: string | null }>>`
      SELECT
        wallet,
        CASE
          WHEN SUM(user_notional) > 0
            THEN (MAX(user_notional) / SUM(user_notional))::text
          ELSE NULL
        END AS top_subscriber_share
      FROM (
        SELECT
          LOWER(cl.address) AS wallet,
          cs."userId" AS user_id,
          COALESCE(SUM(cplc."costBasisUsd"), 0) AS user_notional
        FROM copy_position_lot_closes cplc
        INNER JOIN "CopySubscription" cs ON cs.id = cplc."subscriptionId"
        INNER JOIN "CopyLeader" cl ON cl.id = cs."leaderId"
        WHERE cplc."createdAt" >= ${cutoff}
          AND cs."deletedAt" IS NULL
          ${walletFilter}
          ${SELF_COPY_EXCLUSION_SQL}
        GROUP BY LOWER(cl.address), cs."userId"
      ) per_user
      GROUP BY wallet
    `,
  ]);

  const map = new Map<string, AntiCheatAggregateRow>();
  for (const row of excludedRows) {
    map.set(row.wallet.toLowerCase(), {
      wallet: row.wallet.toLowerCase(),
      excluded_self_copy_count: row.excluded_self_copy_count,
      top_subscriber_share: null,
    });
  }
  for (const row of shareRows) {
    const wallet = row.wallet.toLowerCase();
    const existing = map.get(wallet) ?? {
      wallet,
      excluded_self_copy_count: 0,
      top_subscriber_share: null,
    };
    existing.top_subscriber_share = row.top_subscriber_share;
    map.set(wallet, existing);
  }
  return map;
}

async function fetchTradeAggregates(
  cutoff: Date,
  wallets?: string[]
): Promise<TradeAggregateRow[]> {
  if (wallets != null && wallets.length === 0) return [];

  if (wallets != null) {
    const normalized = wallets.map((wallet) => wallet.toLowerCase());
    return prisma.$queryRaw<TradeAggregateRow[]>`
      SELECT
        LOWER(lt."leaderAddress") AS wallet,
        COUNT(ct.id)::int AS trade_count,
        COALESCE(SUM(ct."realizedPnlUsd"), 0)::text AS total_pnl,
        COALESCE(
          SUM(
            CASE
              WHEN NULLIF(ct."intendedNotional", '') IS NOT NULL
                THEN NULLIF(ct."intendedNotional", '')::numeric
              WHEN NULLIF(ct."filledAmount", '') IS NOT NULL AND NULLIF(ct."avgPrice", '') IS NOT NULL
                THEN NULLIF(ct."filledAmount", '')::numeric * NULLIF(ct."avgPrice", '')::numeric
              ELSE 0
            END
          ),
          0
        )::text AS total_notional
      FROM copy_trades ct
      INNER JOIN "LeaderTrade" lt ON lt.id = ct."leaderTradeId"
      INNER JOIN "CopySubscription" cs ON cs.id = ct."subscriptionId"
      INNER JOIN "CopyLeader" cl ON cl.id = cs."leaderId"
      WHERE ct.status = 'filled'
        AND ct."realizedPnlAt" IS NOT NULL
        AND ct."realizedPnlAt" >= ${cutoff}
        AND LOWER(lt."leaderAddress") = ANY(${normalized}::text[])
        ${SELF_COPY_EXCLUSION_SQL}
      GROUP BY LOWER(lt."leaderAddress")
    `;
  }

  return prisma.$queryRaw<TradeAggregateRow[]>`
    SELECT
      LOWER(lt."leaderAddress") AS wallet,
      COUNT(ct.id)::int AS trade_count,
      COALESCE(SUM(ct."realizedPnlUsd"), 0)::text AS total_pnl,
      COALESCE(
        SUM(
          CASE
            WHEN NULLIF(ct."intendedNotional", '') IS NOT NULL
              THEN NULLIF(ct."intendedNotional", '')::numeric
            WHEN NULLIF(ct."filledAmount", '') IS NOT NULL AND NULLIF(ct."avgPrice", '') IS NOT NULL
              THEN NULLIF(ct."filledAmount", '')::numeric * NULLIF(ct."avgPrice", '')::numeric
            ELSE 0
          END
        ),
        0
      )::text AS total_notional
    FROM copy_trades ct
    INNER JOIN "LeaderTrade" lt ON lt.id = ct."leaderTradeId"
    INNER JOIN "CopySubscription" cs ON cs.id = ct."subscriptionId"
    INNER JOIN "CopyLeader" cl ON cl.id = cs."leaderId"
    WHERE ct.status = 'filled'
      AND ct."realizedPnlAt" IS NOT NULL
      AND ct."realizedPnlAt" >= ${cutoff}
      ${SELF_COPY_EXCLUSION_SQL}
    GROUP BY LOWER(lt."leaderAddress")
  `;
}

function buildSnapshotForWallet(
  lookbackDays: number,
  wallet: string,
  aggregate: {
    closeCount: number;
    tradeCount: number;
    subscriberCount: number;
    totalPnlUsd: number;
    totalNotionalUsd: number;
  } | undefined,
  antiCheat: AntiCheatAggregateRow | undefined
): CopierFeedbackSnapshot {
  if (!aggregate) {
    return emptyCopierFeedbackSnapshot(lookbackDays);
  }
  return buildCopierFeedbackSnapshot({
    lookbackDays,
    closeCount: aggregate.closeCount,
    tradeCount: aggregate.tradeCount,
    subscriberCount: aggregate.subscriberCount,
    totalPnlUsd: aggregate.totalPnlUsd,
    totalNotionalUsd: aggregate.totalNotionalUsd,
    excludedSelfCopyCount: antiCheat?.excluded_self_copy_count ?? 0,
    topSubscriberNotionalShare:
      antiCheat?.top_subscriber_share != null ? Number(antiCheat.top_subscriber_share) : null,
  });
}

export async function aggregateCopierFeedbackForWallets(
  wallets: string[],
  lookbackDays = CONFIG.smartMoneyCopierFeedbackLookbackDays
): Promise<Map<string, CopierFeedbackSnapshot>> {
  const normalized = [...new Set(wallets.map((wallet) => wallet.toLowerCase()))];
  const result = new Map<string, CopierFeedbackSnapshot>();
  if (normalized.length === 0) return result;

  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const [lotCloses, trades, antiCheatMap] = await Promise.all([
    fetchLotCloseAggregates(cutoff, normalized),
    fetchTradeAggregates(cutoff, normalized),
    fetchAntiCheatAggregates(cutoff, normalized),
  ]);
  const merged = mergeAggregateMaps(lotCloses, trades);

  for (const wallet of normalized) {
    result.set(
      wallet,
      buildSnapshotForWallet(lookbackDays, wallet, merged.get(wallet), antiCheatMap.get(wallet))
    );
  }

  return result;
}

export async function aggregateCopierFeedbackForWallet(
  wallet: string,
  lookbackDays = CONFIG.smartMoneyCopierFeedbackLookbackDays
): Promise<CopierFeedbackSnapshot> {
  const map = await aggregateCopierFeedbackForWallets([wallet], lookbackDays);
  return map.get(wallet.toLowerCase()) ?? emptyCopierFeedbackSnapshot(lookbackDays);
}

export async function aggregateCopierFeedbackForAllLeaders(
  lookbackDays = CONFIG.smartMoneyCopierFeedbackLookbackDays
): Promise<Map<string, CopierFeedbackSnapshot>> {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const [lotCloses, trades, antiCheatMap] = await Promise.all([
    fetchLotCloseAggregates(cutoff),
    fetchTradeAggregates(cutoff),
    fetchAntiCheatAggregates(cutoff),
  ]);
  const merged = mergeAggregateMaps(lotCloses, trades);
  const result = new Map<string, CopierFeedbackSnapshot>();

  for (const [wallet, aggregate] of merged) {
    result.set(wallet, buildSnapshotForWallet(lookbackDays, wallet, aggregate, antiCheatMap.get(wallet)));
  }

  return result;
}
