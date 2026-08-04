/**
 * 统一 user-pnl 曲线采集：Gate=ALL+1W，Enrich=1M+1D，详情 TTL 读穿复用落库点。
 * Gate 路径优先复用 Profile/快照已填周期，仅对缺失或过期周期补拉，避免 QUALIFIED 堆积。
 */
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';
import {
  fetchUserPnlTimeseries,
  type UserPnlApiInterval,
} from '../polymarket/polymarketUserPnlApi';
import { waitSmartMoneyRequestGap } from './smartMoneyRequestGap';
import {
  curveTtlMsForPeriod,
  curveTypeForPeriod,
  isCurveFresh,
  type CurvePeriod,
} from './smartMoneyCurveTtl';

function periodToInterval(period: CurvePeriod): UserPnlApiInterval {
  switch (period) {
    case '1D':
      return '1d';
    case '1W':
      return '1w';
    case '1M':
      return '1m';
    case 'ALL':
      return 'all';
  }
}

export async function persistUserPnlCurvePeriod(
  wallet: string,
  period: CurvePeriod,
  snapshotAt: Date
): Promise<{ ok: boolean; pointCount: number }> {
  const normalized = wallet.trim().toLowerCase();
  const series = await fetchUserPnlTimeseries(normalized, periodToInterval(period), {
    fidelity: period === '1D' ? '1h' : undefined,
  });
  if (series.length === 0) return { ok: false, pointCount: 0 };

  const curveType = curveTypeForPeriod(period);
  await prisma.traderCurvePoint.deleteMany({
    where: { wallet: normalized, curveType },
  });

  const rows = series.map((point) => ({
    wallet: normalized,
    curveType,
    ts: new Date(point.t * 1000),
    value: new Prisma.Decimal(String(point.p)),
    snapshotAt,
  }));

  const batchSize = 200;
  for (let i = 0; i < rows.length; i += batchSize) {
    await prisma.traderCurvePoint.createMany({ data: rows.slice(i, i + batchSize) });
  }
  return { ok: true, pointCount: rows.length };
}

export async function fetchAndPersistUserPnlCurves(
  wallet: string,
  periods: CurvePeriod[],
  options?: { snapshotAt?: Date; requestGap?: boolean }
): Promise<{ periodsFilled: CurvePeriod[]; snapshotAt: Date }> {
  const snapshotAt = options?.snapshotAt ?? new Date();
  const periodsFilled: CurvePeriod[] = [];
  for (const period of periods) {
    if (options?.requestGap !== false) {
      await waitSmartMoneyRequestGap();
    }
    try {
      const result = await persistUserPnlCurvePeriod(wallet, period, snapshotAt);
      if (result.ok) periodsFilled.push(period);
    } catch {
      // 单周期失败不阻断
    }
  }
  return { periodsFilled, snapshotAt };
}

async function latestCurveSnapshotAt(
  wallet: string,
  period: CurvePeriod
): Promise<Date | null> {
  const row = await prisma.traderCurvePoint.findFirst({
    where: { wallet, curveType: curveTypeForPeriod(period) },
    orderBy: [{ snapshotAt: 'desc' }],
    select: { snapshotAt: true },
  });
  return row?.snapshotAt ?? null;
}

/**
 * Gate 专用：只补「缺失或 TTL 过期」的 ALL/1W。
 * Profile live 已填且库内新鲜 → 跳过 HTTP，避免与 resolveProfile 双拉。
 */
export async function ensureGateUserPnlCurves(
  wallet: string,
  options?: {
    periods?: CurvePeriod[];
    profileFilledPeriods?: string[] | null;
  }
): Promise<{ fetched: CurvePeriod[]; skippedFresh: CurvePeriod[] }> {
  const normalized = wallet.trim().toLowerCase();
  const periods = options?.periods ?? GATE_PNL_CURVE_PERIODS;
  const profileFilled = new Set(
    (options?.profileFilledPeriods ?? []).map((p) => String(p).toUpperCase())
  );
  const fetched: CurvePeriod[] = [];
  const skippedFresh: CurvePeriod[] = [];

  for (const period of periods) {
    const latest = await latestCurveSnapshotAt(normalized, period);
    if (isCurveFresh(latest, period)) {
      skippedFresh.push(period);
      continue;
    }
    if (profileFilled.has(period)) {
      const again = await latestCurveSnapshotAt(normalized, period);
      if (again != null && Date.now() - again.getTime() < curveTtlMsForPeriod(period)) {
        skippedFresh.push(period);
        continue;
      }
    }
    try {
      await waitSmartMoneyRequestGap();
      const result = await persistUserPnlCurvePeriod(normalized, period, new Date());
      if (result.ok) fetched.push(period);
    } catch {
      // 单周期失败不阻断 Gate
    }
  }
  return { fetched, skippedFresh };
}

/** Deep-Gate 默认曲线集 */
export const GATE_PNL_CURVE_PERIODS: CurvePeriod[] = ['ALL', '1W'];

/** CopyPool Enrich 默认曲线集 */
export const ENRICH_PNL_CURVE_PERIODS: CurvePeriod[] = ['1M', '1D'];
