/**
 * GET /api/trade/user/positions 热路径分段 profiling。
 *
 * 运行：
 *   npx tsx --env-file=.env scripts/profile-user-positions.ts
 *
 * 环境变量：
 *   PROFILE_USER_ID=18
 *   PROFILE_ADDRESS=0x6564...   （可选，同 API query address）
 *   PROFILE_SKIP_CACHE=1        （强制打 Polymarket Data API，测冷启动）
 *   PROFILE_RUNS=3              （重复次数，看缓存命中）
 */
import { Prisma } from '../src/generated/prisma/client';
import { CopyTradeStatus } from '../src/generated/prisma/enums';
import { prisma } from '../src/db';
import { getExecutionWalletForUser } from '../src/services/polymarket/automationSession';
import {
  fetchDataApiPositions,
  fetchDataApiPositionsForWalletPair,
  type DataApiPosition,
} from '../src/services/polymarket/polymarketData';
import { getOpenCopyLotsByTokenForUser } from '../src/copyTrading/services/copyPositionLots';

const MANUAL_SETTLEMENT_LEADER_ADDRESSES = [
  'manual_close',
  'manual_expired',
  'manual_redeem',
  'auto_redeem',
  'virtual_manual_close',
] as const;

const DUST_POSITION_HIDE_VALUE_MAX_USD = 0.05;

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ms: number; result: T }> {
  const start = performance.now();
  const result = await fn();
  return { label, ms: Math.round(performance.now() - start), result };
}

async function resolveUserId(): Promise<number> {
  const fromEnv = Number(process.env.PROFILE_USER_ID ?? '');
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;

  const addr = (process.env.PROFILE_ADDRESS ?? '').trim().toLowerCase();
  if (!addr) {
    throw new Error('Set PROFILE_USER_ID or PROFILE_ADDRESS');
  }
  const wallet = await prisma.wallet.findFirst({
    where: {
      OR: [
        { address: { equals: addr, mode: 'insensitive' } },
        { polymarketFunderAddress: { equals: addr, mode: 'insensitive' } },
      ],
    },
    select: { userId: true },
  });
  if (!wallet?.userId) throw new Error(`No wallet for address ${addr}`);
  return wallet.userId;
}

/** 与 trade.ts collectStalePositionAssetsToHide 相同逻辑，便于分段计时 */
async function collectStalePositionAssetsToHide(
  userId: number,
  positions: DataApiPosition[]
): Promise<Set<string>> {
  if (positions.length === 0) return new Set();

  const hidden = new Set<string>();
  const tokenIds = [...new Set(positions.map((p) => p.asset).filter(Boolean))];
  const conditionIds = [...new Set(positions.map((p) => p.conditionId.toLowerCase()))];

  const [redeemLogs, openLotRows, legacySettlementRows, copyLotCloseRows] = await Promise.all([
    conditionIds.length
      ? prisma.polymarketRedeemLog.findMany({
          where: { userId, conditionId: { in: conditionIds } },
          select: { conditionId: true },
        })
      : [],
    tokenIds.length
      ? prisma.copyPositionLot.findMany({
          where: {
            userId,
            tokenID: { in: tokenIds },
            remainingSize: { gt: new Prisma.Decimal(0) },
          },
          select: { tokenID: true },
          distinct: ['tokenID'],
        })
      : [],
    tokenIds.length
      ? prisma.copyExecution.findMany({
          where: {
            followerUserId: userId,
            tokenID: { in: tokenIds },
            leaderAddress: { in: [...MANUAL_SETTLEMENT_LEADER_ADDRESSES] },
            status: 'filled',
          },
          select: { tokenID: true },
          distinct: ['tokenID'],
        })
      : [],
    tokenIds.length
      ? prisma.copyPositionLotClose.findMany({
          where: { userId, tokenID: { in: tokenIds } },
          select: { sellCopyTradeRowId: true },
          distinct: ['sellCopyTradeRowId'],
        })
      : [],
  ]);
  const sellCopyTradeRowIds = copyLotCloseRows
    .map((row) => row.sellCopyTradeRowId)
    .filter((id) => id && !id.startsWith('legacy:'));
  const copySettlementRows = sellCopyTradeRowIds.length
    ? await prisma.copyTradeRow.findMany({
        where: {
          id: { in: sellCopyTradeRowIds },
          userId,
          tokenId: { in: tokenIds },
          status: CopyTradeStatus.filled,
          leaderTrade: { side: 'SELL' },
        },
        select: { tokenId: true },
        distinct: ['tokenId'],
      })
    : [];

  const normalizeTokenId = (tokenID: string) => tokenID.trim().toLowerCase();
  const redeemedConditions = new Set(redeemLogs.map((r) => r.conditionId.toLowerCase()));
  const openLotTokenIds = new Set(openLotRows.map((row) => normalizeTokenId(row.tokenID)));
  const settledTokenIds = new Set(
    [
      ...legacySettlementRows.map((row) => row.tokenID),
      ...copySettlementRows.map((row) => row.tokenId ?? ''),
    ]
      .filter(Boolean)
      .map((tokenID) => normalizeTokenId(tokenID))
  );

  for (const p of positions) {
    if (redeemedConditions.has(p.conditionId.toLowerCase())) {
      hidden.add(p.asset);
      continue;
    }
    const tokenKey = normalizeTokenId(p.asset);
    if (!openLotTokenIds.has(tokenKey) && settledTokenIds.has(tokenKey)) {
      const size = Number(p.size ?? 0);
      const price = Number(p.curPrice ?? 0);
      const value = Number(p.currentValue ?? price * size);
      const stillMeaningful = size > 0.01 || (Number.isFinite(value) && value > DUST_POSITION_HIDE_VALUE_MAX_USD);
      if (!stillMeaningful) hidden.add(p.asset);
    }
  }
  return hidden;
}

async function profileStaleHideSubsteps(userId: number, positions: DataApiPosition[]) {
  const tokenIds = [...new Set(positions.map((p) => p.asset).filter(Boolean))];
  const conditionIds = [...new Set(positions.map((p) => p.conditionId.toLowerCase()))];

  const parallel = await timed('staleHide.parallel4', async () =>
    Promise.all([
      conditionIds.length
        ? prisma.polymarketRedeemLog.findMany({
            where: { userId, conditionId: { in: conditionIds } },
            select: { conditionId: true },
          })
        : Promise.resolve([]),
      tokenIds.length
        ? prisma.copyPositionLot.findMany({
            where: {
              userId,
              tokenID: { in: tokenIds },
              remainingSize: { gt: new Prisma.Decimal(0) },
            },
            select: { tokenID: true },
            distinct: ['tokenID'],
          })
        : Promise.resolve([]),
      tokenIds.length
        ? prisma.copyExecution.findMany({
            where: {
              followerUserId: userId,
              tokenID: { in: tokenIds },
              leaderAddress: { in: [...MANUAL_SETTLEMENT_LEADER_ADDRESSES] },
              status: 'filled',
            },
            select: { tokenID: true },
            distinct: ['tokenID'],
          })
        : Promise.resolve([]),
      tokenIds.length
        ? prisma.copyPositionLotClose.findMany({
            where: { userId, tokenID: { in: tokenIds } },
            select: { sellCopyTradeRowId: true },
            distinct: ['sellCopyTradeRowId'],
          })
        : Promise.resolve([]),
    ])
  );

  const [, , , copyLotCloseRows] = parallel.result;
  const sellCopyTradeRowIds = copyLotCloseRows
    .map((row: { sellCopyTradeRowId: string }) => row.sellCopyTradeRowId)
    .filter((id: string) => id && !id.startsWith('legacy:'));

  const copySettlement = await timed('staleHide.copyTradeJoin', async () =>
    sellCopyTradeRowIds.length
      ? prisma.copyTradeRow.findMany({
          where: {
            id: { in: sellCopyTradeRowIds },
            userId,
            tokenId: { in: tokenIds },
            status: CopyTradeStatus.filled,
            leaderTrade: { side: 'SELL' },
          },
          select: { tokenId: true },
          distinct: ['tokenId'],
        })
      : []
  );

  return {
    parallelMs: parallel.ms,
    copyTradeJoinMs: copySettlement.ms,
    sellRowIdCount: sellCopyTradeRowIds.length,
    copySettlementCount: copySettlement.result.length,
  };
}

async function profileOnce(userId: number, qAddress?: string) {
  const steps: Array<{ label: string; ms: number; detail?: string }> = [];
  const totalStart = performance.now();

  const walletStep = await timed('1.getExecutionWalletForUser', () =>
    getExecutionWalletForUser(userId, qAddress)
  );
  steps.push({ label: walletStep.label, ms: walletStep.ms });
  const ctx = walletStep.result;
  const deposit = (ctx.polymarketFunderAddress ?? '').trim();
  const custodial = ctx.address.trim();
  const dualAddress = deposit && deposit.toLowerCase() !== custodial.toLowerCase();

  const skipCache = process.env.PROFILE_SKIP_CACHE === '1';
  if (dualAddress) {
    const depFetch = await timed('2a.fetchDataApi.deposit', () =>
      fetchDataApiPositions(deposit, { sizeThreshold: 0, limit: 200, skipCache })
    );
    const custFetch = await timed('2b.fetchDataApi.custodial', () =>
      fetchDataApiPositions(custodial, { sizeThreshold: 0, limit: 200, skipCache })
    );
    steps.push({ label: depFetch.label, ms: depFetch.ms, detail: `${depFetch.result.length} rows` });
    steps.push({ label: custFetch.label, ms: custFetch.ms, detail: `${custFetch.result.length} rows` });
  }

  const dataApi = await timed('2.fetchDataApiPositionsForWalletPair', () =>
    fetchDataApiPositionsForWalletPair(
      { custodial, deposit },
      { sizeThreshold: 0, limit: 200, ...(skipCache ? { skipCache: true } : {}) }
    )
  );
  steps.push({
    label: dataApi.label,
    ms: dataApi.ms,
    detail: `${dataApi.result.length} positions, dual=${dualAddress}`,
  });
  const raw = dataApi.result;
  const positionTokenIds = raw.map((p) => p.asset.trim().toLowerCase()).filter(Boolean);

  const stale = await timed('3.collectStalePositionAssetsToHide', () =>
    collectStalePositionAssetsToHide(userId, raw)
  );
  steps.push({ label: stale.label, ms: stale.ms, detail: `hide ${stale.result.size}` });

  const staleSub = await profileStaleHideSubsteps(userId, raw);
  steps.push({
    label: '3a.staleHide.parallel4',
    ms: staleSub.parallelMs,
    detail: `sellIds=${staleSub.sellRowIdCount}`,
  });
  steps.push({
    label: '3b.staleHide.copyTradeJoin',
    ms: staleSub.copyTradeJoinMs,
    detail: `settled=${staleSub.copySettlementCount}`,
  });

  const markPriceByToken = new Map(
    raw.map((p) => [p.asset.trim().toLowerCase(), Number(p.curPrice ?? 0)])
  );
  const lots = await timed('4.getOpenCopyLotsByTokenForUser', () =>
    getOpenCopyLotsByTokenForUser({
      prismaClient: prisma,
      userId,
      markPriceByToken,
      tokenIds: positionTokenIds,
    })
  );
  let lotCount = 0;
  for (const list of lots.result.values()) lotCount += list.length;
  steps.push({ label: lots.label, ms: lots.ms, detail: `${lotCount} lots, ${lots.result.size} tokens` });

  const totalMs = Math.round(performance.now() - totalStart);
  return {
    userId,
    addressQuery: qAddress ?? null,
    custodial,
    deposit: deposit || null,
    totalMs,
    steps,
  };
}

function printReport(run: Awaited<ReturnType<typeof profileOnce>>, runIndex: number) {
  console.log(`\n=== Run ${runIndex + 1} | userId=${run.userId} | total=${run.totalMs}ms ===`);
  console.log(`custodial=${run.custodial}`);
  console.log(`deposit=${run.deposit ?? '(same)'}`);
  console.log('');
  const maxLabel = Math.max(...run.steps.map((s) => s.label.length));
  for (const s of run.steps) {
    const pad = ' '.repeat(maxLabel - s.label.length);
    const pct = run.totalMs > 0 ? ((s.ms / run.totalMs) * 100).toFixed(1) : '0';
    const detail = s.detail ? `  (${s.detail})` : '';
    console.log(`  ${s.label}${pad}  ${String(s.ms).padStart(5)}ms  ${pct.padStart(5)}%${detail}`);
  }
}

async function main() {
  const userId = await resolveUserId();
  const qAddress = (process.env.PROFILE_ADDRESS ?? '').trim() || undefined;
  const runs = Math.min(5, Math.max(1, Number(process.env.PROFILE_RUNS ?? 2) || 2));

  console.log('[profile-user-positions]');
  console.log(`  userId=${userId}`);
  console.log(`  address=${qAddress ?? '(default wallet)'}`);
  console.log(`  skipCache=${process.env.PROFILE_SKIP_CACHE === '1'}`);
  console.log(`  runs=${runs}`);

  const results: Awaited<ReturnType<typeof profileOnce>>[] = [];
  for (let i = 0; i < runs; i++) {
    results.push(await profileOnce(userId, qAddress));
    printReport(results[i], i);
    if (i < runs - 1) await new Promise((r) => setTimeout(r, 200));
  }

  if (results.length >= 2) {
    const cold = results[0].totalMs;
    const warm = results[results.length - 1].totalMs;
    console.log(`\n--- Cache effect: run1=${cold}ms → run${results.length}=${warm}ms (${warm < cold ? 'faster' : 'same/slower'}) ---`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
