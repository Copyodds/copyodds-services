import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { transitionPipelineStage } from './smartMoneyPipeline';
import { waitSmartMoneyRequestGap } from './smartMoneyRequestGap';
import {
  finishSmartMoneyBatchRun,
  startSmartMoneyBatchRun,
} from './smartMoneyBatchObservability';
import { snapshotConsumableBacklog } from './smartMoneyConsumableBacklog';
import { markSmartMoneyRanksDirty } from './smartMoneyLeaderboardWriter';

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

const STRONG_REVIVE_SOURCES = [
  'BLOCK_SCAN',
  'LEADERBOARD',
  'ADMIN',
  'MANUAL',
  'REVIVE|',
  'REVIVE|OFFICIAL_TOP',
  'REVIVE|RANK_JUMP',
  'REVIVE|BLOCKSCAN',
] as const;

export type ElimBucket = 'HOT' | 'COLD' | 'PURGED';

export function isStrongReviveSource(source: string): boolean {
  const upper = source.trim().toUpperCase();
  return STRONG_REVIVE_SOURCES.some((s) => upper.includes(s.toUpperCase()));
}

export function normalizeReviveReason(source: string): string {
  const upper = source.trim().toUpperCase();
  if (upper.includes('RANK_JUMP')) return 'REVIVE|RANK_JUMP';
  if (upper.includes('OFFICIAL_TOP')) return 'REVIVE|OFFICIAL_TOP';
  if (upper.includes('BLOCK')) return 'REVIVE|BLOCKSCAN';
  if (upper.includes('LEADERBOARD')) return 'REVIVE|OFFICIAL_TOP';
  return `REVIVE|${upper.slice(0, 32)}`;
}

/** ADMIN/MANUAL 可绕过强信号复活冷却 */
export function isReviveCooldownBypassSource(source: string): boolean {
  const upper = source.trim().toUpperCase();
  return upper.includes('ADMIN') || upper.includes('MANUAL');
}

/** 按淘汰原因选择强信号复活冷却时长 */
export function resolveStrongReviveCooldownMs(tierFailReason: string | null | undefined): number {
  const base = CONFIG.smartMoneyStrongReviveCooldownMs;
  if (elimReasonRequiresDeepRecheck(tierFailReason)) {
    return Math.max(base, CONFIG.smartMoneyStrongReviveDeepCooldownMs);
  }
  return base;
}

/**
 * 是否仍在强信号复活冷却中（冻结期或距淘汰写入未满冷却）。
 * bypass 源由调用方先排除。
 */
export function isStrongReviveCooldownActive(input: {
  updatedAt: Date;
  elimFrozenUntil: Date | null | undefined;
  tierFailReason: string | null | undefined;
  now?: Date;
}): boolean {
  const nowMs = (input.now ?? new Date()).getTime();
  if (input.elimFrozenUntil != null && input.elimFrozenUntil.getTime() > nowMs) {
    return true;
  }
  const cooldownMs = resolveStrongReviveCooldownMs(input.tierFailReason);
  if (cooldownMs <= 0) return false;
  return nowMs - input.updatedAt.getTime() < cooldownMs;
}

export function canAttemptStrongRevive(input: {
  source: string;
  updatedAt: Date;
  elimFrozenUntil: Date | null | undefined;
  tierFailReason: string | null | undefined;
  now?: Date;
}): boolean {
  if (!isStrongReviveSource(input.source)) return false;
  if (isReviveCooldownBypassSource(input.source)) return true;
  return !isStrongReviveCooldownActive({
    updatedAt: input.updatedAt,
    elimFrozenUntil: input.elimFrozenUntil,
    tierFailReason: input.tierFailReason,
    now: input.now,
  });
}

/** 强信号发现：从淘汰池唤醒回 RAW，重置失败计数 */
export async function reviveEliminatedOnStrongSource(
  wallet: string,
  source: string,
  ingestPatch?: {
    sources?: string[];
    lastSeenAt?: Date;
    lastIngestedAt?: Date;
  }
): Promise<boolean> {
  if (!isStrongReviveSource(source)) return false;
  const normalized = normalizeWallet(wallet);
  const row = await prisma.smartMoneyRawAddress.findUnique({
    where: { wallet: normalized },
    select: {
      pipelineStage: true,
      updatedAt: true,
      elimFrozenUntil: true,
      tierFailReason: true,
    },
  });
  if (!row || row.pipelineStage !== 'ELIMINATED') return false;

  const now = new Date();
  if (
    !canAttemptStrongRevive({
      source,
      updatedAt: row.updatedAt,
      elimFrozenUntil: row.elimFrozenUntil,
      tierFailReason: row.tierFailReason,
      now,
    })
  ) {
    return false;
  }

  const reason = normalizeReviveReason(source);
  // CAS：只允许仍是本次读取到的那一版 ELIMINATED 行被复活。
  // 避免并发复活重复计数，也避免覆盖冷却检查后发生的新淘汰。
  const revived = await prisma.smartMoneyRawAddress.updateMany({
    where: {
      wallet: normalized,
      pipelineStage: 'ELIMINATED',
      updatedAt: row.updatedAt,
    },
    data: {
      pipelineStage: 'RAW',
      tierFailReason: reason,
      nextLightAnalyzeAt: now,
      nextDeepAnalyzeAt: null,
      nextElimCheckAt: null,
      elimFailCount: 0,
      elimFrozenUntil: null,
      elimBucket: 'HOT',
      dormant: false,
      scoredMissCount: 0,
      updatedAt: now,
      ...(ingestPatch?.sources ? { sources: ingestPatch.sources } : {}),
      ...(ingestPatch?.lastSeenAt ? { lastSeenAt: ingestPatch.lastSeenAt } : {}),
      ...(ingestPatch?.lastIngestedAt
        ? { lastIngestedAt: ingestPatch.lastIngestedAt }
        : {}),
    },
  });
  return revived.count === 1;
}

/** Deep-L1 / 分数 / 硬旗类失败：禁止仅用 Light 复活 */
export function elimReasonRequiresDeepRecheck(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const r = reason.toUpperCase();
  return (
    r.startsWith('L1') ||
    r.includes('L1-') ||
    r.startsWith('COPY_HARD') ||
    r.startsWith('SCORE_BELOW') ||
    r.startsWith('QUALIFIED_CAP') ||
    r.startsWith('SCORED_CAP') ||
    r.startsWith('MDD_PCT') ||
    r.includes('DUST')
  );
}

/** Light 可逆失败：可 HOT 再检 */
export function elimReasonIsLightReversible(reason: string | null | undefined): boolean {
  if (!reason) return true;
  const r = reason.toUpperCase();
  return (
    r.startsWith('T1L') ||
    r.startsWith('L-PNL') ||
    r.startsWith('L-HARD') ||
    r.startsWith('L-DUAL') ||
    r.startsWith('L0') ||
    r.includes('T1L_')
  );
}

function initialElimBucket(reason: string): ElimBucket {
  if (elimReasonRequiresDeepRecheck(reason) && !elimReasonIsLightReversible(reason)) {
    return 'COLD';
  }
  return 'HOT';
}

/**
 * Light/Deep 门控失败 → 淘汰池（不再回 RAW/QUALIFIED 空转）。
 */
export async function moveToEliminated(
  wallet: string,
  reason: string,
  options?: { clearTier1l?: boolean; elimBucket?: ElimBucket }
): Promise<void> {
  const normalized = normalizeWallet(wallet);
  const now = new Date();
  const existing = await prisma.smartMoneyRawAddress.findUnique({
    where: { wallet: normalized },
    select: { elimFailCount: true, lastTradeAt: true, lastSeenAt: true },
  });
  const prevCount = existing?.elimFailCount ?? 0;
  const nextCount = prevCount + 1;
  const maxFails = CONFIG.smartMoneyEliminatedMaxFails;
  const freeze =
    nextCount >= maxFails
      ? new Date(now.getTime() + CONFIG.smartMoneyEliminatedFreezeMs)
      : null;
  const nextCheck = freeze
    ? freeze
    : new Date(now.getTime() + CONFIG.smartMoneyEliminatedRecheckMs);
  const bucket = options?.elimBucket ?? initialElimBucket(reason);

  // 淘汰与出榜必须原子提交，避免前端仍在榜但管道已 ELIMINATED。
  await prisma.$transaction(async (tx) => {
    await tx.smartMoneyLeaderboardRow.updateMany({
      where: { wallet: normalized, inCopyPool: true },
      data: {
        inCopyPool: false,
        copyPoolExitedAt: now,
        rank: null,
        activeCandidate: false,
        eligible: false,
        enrichPending: false,
      },
    });
    await tx.smartMoneyRawAddress.update({
      where: { wallet: normalized },
      data: {
        pipelineStage: 'ELIMINATED',
        updatedAt: now,
        tierFailReason: reason.slice(0, 240),
        ...(options?.clearTier1l ? { tier1lPassedAt: null } : {}),
        tier2CorePassedAt: null,
        nextLightAnalyzeAt: null,
        nextDeepAnalyzeAt: null,
        nextElimCheckAt: bucket === 'HOT' ? nextCheck : null,
        elimFailCount: nextCount,
        elimFrozenUntil: freeze,
        elimBucket: bucket,
        dormant: false,
        scoredMissCount: 0,
      },
    });
  });
  markSmartMoneyRanksDirty();
}

async function deleteRawAddressesAndSyncLeaderboard(wallets: string[]): Promise<number> {
  if (wallets.length === 0) return 0;
  const now = new Date();
  const deleted = await prisma.$transaction(async (tx) => {
    await tx.smartMoneyLeaderboardRow.updateMany({
      where: { wallet: { in: wallets } },
      data: {
        inCopyPool: false,
        copyPoolExitedAt: now,
        rank: null,
        activeCandidate: false,
        eligible: false,
        enrichPending: false,
      },
    });
    const deleted = await tx.smartMoneyRawAddress.deleteMany({
      where: { wallet: { in: wallets } },
    });
    return deleted.count;
  });
  if (deleted > 0) markSmartMoneyRanksDirty();
  return deleted;
}

/** 30 天无成交 → 物理删除管道行（保留快照由 GC 另议） */
export async function purgeColdEliminatedNoTrade(
  limit = 200
): Promise<{ purged: number }> {
  const cutoff = new Date(
    Date.now() - CONFIG.smartMoneyElimPurgeNoTradeDays * 24 * 60 * 60 * 1000
  );
  const rows = await prisma.smartMoneyRawAddress.findMany({
    where: {
      pipelineStage: 'ELIMINATED',
      AND: [
        {
          OR: [
            { lastTradeAt: { lt: cutoff } },
            { AND: [{ lastTradeAt: null }, { lastSeenAt: { lt: cutoff } }] },
          ],
        },
      ],
    },
    take: limit,
    select: { wallet: true },
  });
  if (rows.length === 0) return { purged: 0 };
  const purged = await deleteRawAddressesAndSyncLeaderboard(rows.map((r) => r.wallet));
  return { purged };
}

export async function pickEliminatedRecheckBatch(
  limit = CONFIG.smartMoneyEliminatedBatchSize
): Promise<string[]> {
  const now = new Date();
  const rows = await prisma.smartMoneyRawAddress.findMany({
    where: {
      pipelineStage: 'ELIMINATED',
      dormant: false,
      OR: [{ elimBucket: 'HOT' }, { elimBucket: { equals: '' } }],
      AND: [
        { OR: [{ elimFrozenUntil: null }, { elimFrozenUntil: { lte: now } }] },
        { OR: [{ nextElimCheckAt: null }, { nextElimCheckAt: { lte: now } }] },
      ],
    },
    orderBy: [{ nextElimCheckAt: { sort: 'asc', nulls: 'first' } }, { lastSeenAt: 'desc' }],
    take: limit,
    select: { wallet: true },
  });
  return rows.map((r) => r.wallet);
}

/**
 * 淘汰慢检（增量）：
 * - Light 可逆：走 Light，通过回 QUALIFIED
 * - Deep 类：默认不完整 Deep；推后或冻结；有近 7 日成交才 HOT 保留
 * - 禁止与 QUALIFIED 抢 Deep 配额
 */
export async function runEliminatedRecheckForWallet(wallet: string): Promise<{
  wallet: string;
  revived: boolean;
  frozen: boolean;
  deferred?: boolean;
  purged?: boolean;
  error?: string;
}> {
  const normalized = normalizeWallet(wallet);
  try {
    await waitSmartMoneyRequestGap();
    await prisma.smartMoneyRawAddress.updateMany({
      where: {
        wallet: normalized,
        elimFrozenUntil: { lte: new Date() },
      },
      data: { elimFrozenUntil: null, elimFailCount: 0 },
    });

    const existing = await prisma.smartMoneyRawAddress.findUnique({
      where: { wallet: normalized },
      select: {
        tierFailReason: true,
        elimFailCount: true,
        lastTradeAt: true,
        lastSeenAt: true,
        elimBucket: true,
      },
    });

    const tradeAnchor = existing?.lastTradeAt ?? existing?.lastSeenAt ?? null;
    const purgeDays = CONFIG.smartMoneyElimPurgeNoTradeDays;
    if (
      tradeAnchor != null &&
      Date.now() - tradeAnchor.getTime() > purgeDays * 24 * 60 * 60 * 1000
    ) {
      await deleteRawAddressesAndSyncLeaderboard([normalized]).catch(() => undefined);
      return { wallet: normalized, revived: false, frozen: false, purged: true };
    }

    const recentTradeMs = 7 * 24 * 60 * 60 * 1000;
    const hasRecentTrade =
      tradeAnchor != null && Date.now() - tradeAnchor.getTime() <= recentTradeMs;

    if (elimReasonRequiresDeepRecheck(existing?.tierFailReason)) {
      // 无近期成交 → COLD，不主动再检
      if (!hasRecentTrade) {
        await transitionPipelineStage(normalized, 'ELIMINATED', {
          elimBucket: 'COLD',
          nextElimCheckAt: null,
          tierFailReason: (existing?.tierFailReason ?? 'L1_HOLD').slice(0, 240),
        });
        return { wallet: normalized, revived: false, frozen: false, deferred: true };
      }
      const nextCount = (existing?.elimFailCount ?? 0) + 1;
      const maxFails = CONFIG.smartMoneyEliminatedMaxFails;
      const now = new Date();
      if (nextCount >= maxFails) {
        await transitionPipelineStage(normalized, 'ELIMINATED', {
          elimFailCount: nextCount,
          elimFrozenUntil: new Date(now.getTime() + CONFIG.smartMoneyEliminatedFreezeMs),
          nextElimCheckAt: new Date(now.getTime() + CONFIG.smartMoneyEliminatedFreezeMs),
          elimBucket: 'COLD',
          tierFailReason: (existing?.tierFailReason ?? 'L1_HOLD').slice(0, 240),
        });
        return { wallet: normalized, revived: false, frozen: true, deferred: true };
      }
      // 增量：仅用 Light/快照重算方向；完整 Deep 留给强源唤醒后的主路径
      await transitionPipelineStage(normalized, 'ELIMINATED', {
        elimFailCount: nextCount,
        elimBucket: 'HOT',
        nextElimCheckAt: new Date(now.getTime() + CONFIG.smartMoneyEliminatedRecheckMs),
      });
      return { wallet: normalized, revived: false, frozen: false, deferred: true };
    }

    const { runLightAnalyzeForWallet } = await import('./smartMoneyLightAnalyze.js');
    const result = await runLightAnalyzeForWallet(normalized);
    if (result.success && result.passedTier1L) {
      await prisma.smartMoneyRawAddress.updateMany({
        where: { wallet: normalized },
        data: {
          elimFailCount: 0,
          elimFrozenUntil: null,
          nextElimCheckAt: null,
          elimBucket: 'HOT',
          scoredMissCount: 0,
        },
      });
      return { wallet: normalized, revived: true, frozen: false };
    }

    const row = await prisma.smartMoneyRawAddress.findUnique({
      where: { wallet: normalized },
      select: { elimFrozenUntil: true },
    });
    return {
      wallet: normalized,
      revived: false,
      frozen: row?.elimFrozenUntil != null && row.elimFrozenUntil > new Date(),
      error: result.error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await moveToEliminated(normalized, `elim_recheck_error:${message}`).catch(() => undefined);
    return { wallet: normalized, revived: false, frozen: false, error: message };
  }
}

export async function runSmartMoneyEliminatedRecheckBatch(
  limit = CONFIG.smartMoneyEliminatedBatchSize
): Promise<{
  picked: number;
  revived: number;
  frozen: number;
  deferred: number;
  failed: number;
  purged: number;
}> {
  const run = startSmartMoneyBatchRun('eliminated', 'interval:eliminated');
  const backlogBefore = await snapshotConsumableBacklog().catch(() => ({}));
  const purgedBatch = await purgeColdEliminatedNoTrade(Math.max(50, limit * 2));
  const wallets = await pickEliminatedRecheckBatch(limit);
  let revived = 0;
  let frozen = 0;
  let deferred = 0;
  let failed = 0;
  let purged = purgedBatch.purged;
  for (const wallet of wallets) {
    const r = await runEliminatedRecheckForWallet(wallet);
    if (r.purged) purged += 1;
    else if (r.revived) revived += 1;
    else if (r.frozen) frozen += 1;
    else if (r.deferred) deferred += 1;
    else failed += 1;
  }
  const backlogAfter = await snapshotConsumableBacklog().catch(() => backlogBefore);
  finishSmartMoneyBatchRun(run, {
    picked: wallets.length,
    succeeded: revived,
    failed,
    deferred,
    converted: revived,
    backlogBefore,
    backlogAfter,
    extras: {
      revived,
      frozen,
      deferred,
      purged,
    },
  });
  return { picked: wallets.length, revived, frozen, deferred, failed, purged };
}
