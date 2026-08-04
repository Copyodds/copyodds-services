import { prisma } from '../../db';
import { Prisma } from '../../generated/prisma/client';

const RECONCILE_SOURCE = 'LEADERBOARD_COPY_POOL_RECONCILE';
const DEFAULT_MIN_INTERVAL_MS = 60_000;
const WRITE_CHUNK_SIZE = 500;

export type CopyPoolConsistencyResult = {
  checked: number;
  createdRaw: number;
  restoredPipeline: number;
  activeAnalyzing: number;
  skipped: boolean;
};

type ReconcileLeaderboardRow = {
  wallet: string;
  copyPoolEnteredAt: Date | null;
  lastScoredAt: Date;
};

type ReconcileRawRow = {
  wallet: string;
  pipelineStage: string;
};

let lastCompletedAtMs = 0;
let reconcileInFlight: Promise<CopyPoolConsistencyResult> | null = null;

function chunks<T>(rows: T[], size = WRITE_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    result.push(rows.slice(i, i + size));
  }
  return result;
}

/**
 * 生成一致性修复计划。FULL_ANALYZING 表示正在 Deep 复评，不能抢写回 COPY_POOL。
 */
export function planCopyPoolPipelineReconciliation(
  leaderboardRows: ReconcileLeaderboardRow[],
  rawRows: ReconcileRawRow[]
): {
  missing: ReconcileLeaderboardRow[];
  driftedWallets: string[];
  activeAnalyzing: number;
} {
  const rawByWallet = new Map(rawRows.map((row) => [row.wallet.toLowerCase(), row]));
  const missing: ReconcileLeaderboardRow[] = [];
  const driftedWallets: string[] = [];
  let activeAnalyzing = 0;

  for (const leaderboardRow of leaderboardRows) {
    const wallet = leaderboardRow.wallet.toLowerCase();
    const raw = rawByWallet.get(wallet);
    if (!raw) {
      missing.push({ ...leaderboardRow, wallet });
      continue;
    }
    if (raw.pipelineStage === 'COPY_POOL') continue;
    if (raw.pipelineStage === 'FULL_ANALYZING') {
      activeAnalyzing += 1;
      continue;
    }
    driftedWallets.push(wallet);
  }

  return { missing, driftedWallets, activeAnalyzing };
}

async function runReconciliation(): Promise<CopyPoolConsistencyResult> {
  const now = new Date();
  const leaderboardRows = await prisma.smartMoneyLeaderboardRow.findMany({
    where: { inCopyPool: true },
    select: {
      wallet: true,
      copyPoolEnteredAt: true,
      lastScoredAt: true,
    },
  });
  if (leaderboardRows.length === 0) {
    return {
      checked: 0,
      createdRaw: 0,
      restoredPipeline: 0,
      activeAnalyzing: 0,
      skipped: false,
    };
  }

  const wallets = leaderboardRows.map((row) => row.wallet.toLowerCase());
  const rawRows: ReconcileRawRow[] = [];
  for (const walletChunk of chunks(wallets)) {
    rawRows.push(
      ...(await prisma.smartMoneyRawAddress.findMany({
        where: { wallet: { in: walletChunk } },
        select: { wallet: true, pipelineStage: true },
      }))
    );
  }

  const plan = planCopyPoolPipelineReconciliation(leaderboardRows, rawRows);
  let createdRaw = 0;
  for (const missingChunk of chunks(plan.missing)) {
    const missingWallets = missingChunk.map((row) => row.wallet);
    createdRaw += Number(
      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "SmartMoneyRawAddress" (
            wallet,
            sources,
            "firstSeenAt",
            "lastSeenAt",
            "lastIngestedAt",
            "pipelineStage",
            dormant,
            "nextLightAnalyzeAt",
            "nextDeepAnalyzeAt",
            "nextElimCheckAt",
            "elimFrozenUntil",
            "elimFailCount",
            "scoredMissCount",
            "createdAt",
            "updatedAt"
          )
          SELECT
            LOWER(lb.wallet),
            ARRAY[${RECONCILE_SOURCE}]::text[],
            COALESCE(lb."copyPoolEnteredAt", lb."lastScoredAt", ${now}),
            ${now},
            ${now},
            'COPY_POOL',
            false,
            NULL,
            ${now},
            NULL,
            NULL,
            0,
            0,
            ${now},
            ${now}
          FROM "SmartMoneyLeaderboardRow" lb
          WHERE lb."inCopyPool" = true
            AND LOWER(lb.wallet) IN (${Prisma.join(missingWallets)})
          ON CONFLICT (wallet) DO NOTHING
        `
      )
    );
  }

  let restoredPipeline = 0;
  for (const walletChunk of chunks(plan.driftedWallets)) {
    restoredPipeline += Number(
      await prisma.$executeRaw(
        Prisma.sql`
          UPDATE "SmartMoneyRawAddress" ra
          SET
            "pipelineStage" = 'COPY_POOL',
            dormant = false,
            "nextLightAnalyzeAt" = NULL,
            "nextDeepAnalyzeAt" = ${now},
            "nextElimCheckAt" = NULL,
            "elimFrozenUntil" = NULL,
            "elimFailCount" = 0,
            "scoredMissCount" = 0,
            "updatedAt" = ${now}
          WHERE ra.wallet IN (${Prisma.join(walletChunk)})
            AND ra."pipelineStage" NOT IN ('COPY_POOL', 'FULL_ANALYZING')
            AND EXISTS (
              SELECT 1
              FROM "SmartMoneyLeaderboardRow" lb
              WHERE LOWER(lb.wallet) = ra.wallet
                AND lb."inCopyPool" = true
            )
        `
      )
    );
  }

  const result: CopyPoolConsistencyResult = {
    checked: leaderboardRows.length,
    createdRaw,
    restoredPipeline,
    activeAnalyzing: plan.activeAnalyzing,
    skipped: false,
  };
  if (createdRaw > 0 || restoredPipeline > 0) {
    console.warn('[smart-money-copy-pool-consistency] reconciled', result);
  }
  return result;
}

/**
 * 前端在榜（inCopyPool=true）是复评入口权威：
 * - 缺 Raw 行则补建；
 * - Raw 阶段漂移则恢复 COPY_POOL 并立即安排 Deep；
 * - 正在 FULL_ANALYZING 的地址不抢写。
 *
 * 该操作幂等，并带进程内节流/单飞，可在每次双通道选址前安全调用。
 */
export async function reconcileCopyPoolPipelineState(options?: {
  force?: boolean;
  minIntervalMs?: number;
}): Promise<CopyPoolConsistencyResult> {
  const minIntervalMs = Math.max(0, options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  if (!options?.force && Date.now() - lastCompletedAtMs < minIntervalMs) {
    return {
      checked: 0,
      createdRaw: 0,
      restoredPipeline: 0,
      activeAnalyzing: 0,
      skipped: true,
    };
  }
  if (reconcileInFlight) return reconcileInFlight;

  reconcileInFlight = runReconciliation()
    .then((result) => {
      lastCompletedAtMs = Date.now();
      return result;
    })
    .finally(() => {
      reconcileInFlight = null;
    });
  return reconcileInFlight;
}
