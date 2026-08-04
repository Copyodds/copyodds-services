import { prisma } from '../../db';

const DEFAULT_SCAN_DELAY_MS = 15 * 60 * 1000;
const EMPTY_POSITION_SCAN_DELAY_MS = 6 * 60 * 60 * 1000;
const ERROR_RETRY_DELAY_MS = 30 * 60 * 1000;
const DEFAULT_SCAN_BATCH_SIZE = 100;
/** claim 后推迟 nextScanAt，避免长扫期间同一批被再次选中；处理结束会再写真实间隔 */
const DEFAULT_CLAIM_LEASE_MS = DEFAULT_SCAN_DELAY_MS;

export type PositionScanTarget = {
  userId: number;
  custodial: string;
  deposit: string | null;
};

function after(ms: number, from = new Date()): Date {
  return new Date(from.getTime() + ms);
}

async function resolveTargetsFromUserIds(
  userIds: number[],
  now: Date
): Promise<PositionScanTarget[]> {
  if (!userIds.length) return [];
  const rows = await prisma.userPositionScanState.findMany({
    where: { userId: { in: userIds } },
    include: {
      user: {
        select: {
          wallets: {
            where: { type: 'CUSTODIAL' },
            select: { address: true, polymarketFunderAddress: true },
            take: 1,
          },
        },
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.userId, row]));
  const targets: PositionScanTarget[] = [];
  for (const userId of userIds) {
    const row = byId.get(userId);
    const wallet = row?.user.wallets[0];
    if (!wallet) {
      await markUserPositionScanError({
        userId,
        error: 'no_custodial_wallet',
        nextScanAt: after(EMPTY_POSITION_SCAN_DELAY_MS, now),
      });
      continue;
    }
    const deposit = (wallet.polymarketFunderAddress ?? '').trim() || null;
    targets.push({
      userId,
      custodial: wallet.address,
      deposit,
    });
  }
  return targets;
}

export async function markUserPositionScanActive(params: {
  userId: number;
  hasOpenPosition?: boolean;
  nextScanAt?: Date;
}): Promise<void> {
  const now = new Date();
  await prisma.userPositionScanState.upsert({
    where: { userId: params.userId },
    create: {
      userId: params.userId,
      active: true,
      hasOpenPosition: params.hasOpenPosition ?? true,
      nextScanAt: params.nextScanAt ?? after(DEFAULT_SCAN_DELAY_MS, now),
      lastTradeAt: now,
      lastError: null,
    },
    update: {
      active: true,
      hasOpenPosition: params.hasOpenPosition ?? true,
      nextScanAt: params.nextScanAt ?? after(DEFAULT_SCAN_DELAY_MS, now),
      lastTradeAt: now,
      lastError: null,
    },
  });
}

export async function markUserPositionScanActiveBestEffort(params: {
  userId: number;
  hasOpenPosition?: boolean;
  nextScanAt?: Date;
  source?: string;
}): Promise<void> {
  try {
    await markUserPositionScanActive(params);
  } catch (e) {
    console.warn('[position-scan-state] mark active failed', {
      userId: params.userId,
      source: params.source,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function listDuePositionScanTargets(options?: {
  now?: Date;
  take?: number;
}): Promise<PositionScanTarget[]> {
  const now = options?.now ?? new Date();
  const take = Math.min(500, Math.max(1, options?.take ?? DEFAULT_SCAN_BATCH_SIZE));
  const rows = await prisma.userPositionScanState.findMany({
    where: {
      active: true,
      nextScanAt: { lte: now },
    },
    orderBy: [{ nextScanAt: 'asc' }, { userId: 'asc' }],
    take,
    select: { userId: true },
  });
  return resolveTargetsFromUserIds(
    rows.map((row) => row.userId),
    now
  );
}

/**
 * 取出 due 用户并立刻推迟 nextScanAt（FOR UPDATE SKIP LOCKED），
 * 避免长批次 / 多 worker 重复扫同一批。
 */
export async function claimDuePositionScanTargets(options?: {
  now?: Date;
  take?: number;
  claimLeaseMs?: number;
}): Promise<PositionScanTarget[]> {
  const now = options?.now ?? new Date();
  const take = Math.min(500, Math.max(1, options?.take ?? DEFAULT_SCAN_BATCH_SIZE));
  const claimLeaseMs = Math.max(60_000, options?.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS);
  const claimedUntil = after(claimLeaseMs, now);

  const claimedUserIds = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ userId: number }>>`
      SELECT s."userId" AS "userId"
      FROM "UserPositionScanState" s
      WHERE s.active = true
        AND s."nextScanAt" <= ${now}
      ORDER BY s."nextScanAt" ASC, s."userId" ASC
      LIMIT ${take}
      FOR UPDATE SKIP LOCKED
    `;
    if (!rows.length) return [] as number[];
    const userIds = rows.map((row) => Number(row.userId));
    await tx.userPositionScanState.updateMany({
      where: { userId: { in: userIds } },
      data: { nextScanAt: claimedUntil },
    });
    return userIds;
  });

  return resolveTargetsFromUserIds(claimedUserIds, now);
}

export async function markUserPositionScanResult(params: {
  userId: number;
  hasOpenPosition: boolean;
  redeemed?: boolean;
  nextScanAt?: Date;
}): Promise<void> {
  const now = new Date();
  const nextScanAt =
    params.nextScanAt ??
    after(params.hasOpenPosition ? DEFAULT_SCAN_DELAY_MS : EMPTY_POSITION_SCAN_DELAY_MS, now);
  await prisma.userPositionScanState.upsert({
    where: { userId: params.userId },
    create: {
      userId: params.userId,
      active: params.hasOpenPosition,
      hasOpenPosition: params.hasOpenPosition,
      nextScanAt,
      lastScannedAt: now,
      lastRedeemedAt: params.redeemed ? now : null,
      scanCount: 1,
      lastError: null,
    },
    update: {
      active: params.hasOpenPosition,
      hasOpenPosition: params.hasOpenPosition,
      nextScanAt,
      lastScannedAt: now,
      lastRedeemedAt: params.redeemed ? now : undefined,
      scanCount: { increment: 1 },
      lastError: null,
    },
  });
}

export async function markUserPositionScanError(params: {
  userId: number;
  error: string;
  nextScanAt?: Date;
}): Promise<void> {
  const now = new Date();
  await prisma.userPositionScanState.upsert({
    where: { userId: params.userId },
    create: {
      userId: params.userId,
      active: true,
      hasOpenPosition: true,
      nextScanAt: params.nextScanAt ?? after(ERROR_RETRY_DELAY_MS, now),
      lastScannedAt: now,
      scanCount: 1,
      lastError: params.error,
    },
    update: {
      active: true,
      nextScanAt: params.nextScanAt ?? after(ERROR_RETRY_DELAY_MS, now),
      lastScannedAt: now,
      scanCount: { increment: 1 },
      lastError: params.error,
    },
  });
}
