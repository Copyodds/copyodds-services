import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { hasBlockScanSource, hasLeaderboardSource, isFastTrackSource } from './smartMoneyRawSource';
import { transitionPipelineStage } from './smartMoneyPipeline';
import { moveToEliminated } from './smartMoneyEliminated';
import { rawPoolActiveWhere } from './smartMoneyRawPoolActive';

export type L0DbResult =
  | { action: 'CONTINUE_HTML' }
  | { action: 'SKIP_DONE'; passedTier1L: boolean; reason: string };

function weakScanNotionalThreshold(): number {
  const min = CONFIG.smartMoneyBlockScanMinNotionalUsd;
  return min > 0 ? min / 2 : 250;
}

/**
 * Phase H L0-DB：零 HTTP 预筛。榜源豁免 DB-1/DB-4；不放宽 Tier1L。
 */
export async function runLightL0DbForWallet(wallet: string): Promise<L0DbResult> {
  if (!CONFIG.smartMoneyL0DbEnabled) {
    return { action: 'CONTINUE_HTML' };
  }

  const normalized = wallet.toLowerCase();
  const row = await prisma.smartMoneyRawAddress.findUnique({
    where: { wallet: normalized },
    select: {
      sources: true,
      lastSeenAt: true,
      tier1lPassedAt: true,
      dormant: true,
      pipelineStage: true,
    },
  });
  if (!row || row.pipelineStage !== 'RAW') {
    return { action: 'CONTINUE_HTML' };
  }

  const sources = row.sources ?? [];
  const isBoard = hasLeaderboardSource(sources);
  const isFast = isFastTrackSource(sources);

  // DB-1：弱信号长期未活跃 → 淘汰（勿仅 dormant 滞留 RAW 统计口径）
  if (!isBoard && CONFIG.smartMoneyRawWeakDormantDays > 0 && row.tier1lPassedAt == null) {
    const staleMs = CONFIG.smartMoneyRawWeakDormantDays * 24 * 60 * 60 * 1000;
    if (Date.now() - row.lastSeenAt.getTime() > staleMs && !isFast) {
      await moveToEliminated(normalized, 'L0-DB:STALE_WEAK');
      return { action: 'SKIP_DONE', passedTier1L: false, reason: 'L0-DB:STALE_WEAK' };
    }
  }

  // DB-2：仅弱 BLOCK_SCAN
  if (
    hasBlockScanSource(sources) &&
    !isBoard &&
    sources.every((s) => s.toUpperCase().includes('BLOCK_SCAN'))
  ) {
    const discovery = await prisma.blockScanDiscoveredTrader.findUnique({
      where: { wallet: normalized },
      select: { maxSingleNotional: true },
    });
    const threshold = weakScanNotionalThreshold();
    if (discovery && Number(discovery.maxSingleNotional) < threshold) {
      await moveToEliminated(normalized, 'L0-DB:WEAK_SCAN');
      return { action: 'SKIP_DONE', passedTier1L: false, reason: 'L0-DB:WEAK_SCAN' };
    }
  }

  // DB-3：榜源已掉榜（仅稳态 Bootstrap 关闭后）
  if (
    !CONFIG.smartMoneyDiscoveryBootstrapBoard &&
    isBoard &&
    CONFIG.smartMoneyL0DbDroppedBoardEnabled
  ) {
    const observed = await prisma.observedTrader.findUnique({
      where: { wallet: normalized },
      select: {
        candidateActive: true,
        sourceRankWeek: true,
        sourceRankMonth: true,
        sourceRankAll: true,
      },
    });
    const hasRank =
      observed?.sourceRankWeek != null ||
      observed?.sourceRankMonth != null ||
      observed?.sourceRankAll != null;
    if (observed && !observed.candidateActive && !hasRank) {
      await moveToEliminated(normalized, 'L0-DB:DROPPED_BOARD');
      return { action: 'SKIP_DONE', passedTier1L: false, reason: 'L0-DB:DROPPED_BOARD' };
    }
  }

  // DB-4：RAW 池高压背压（榜源豁免）；口径与补池水位一致，不含 CopyPool
  if (!isBoard && CONFIG.smartMoneyRawPoolMaxActive > 0) {
    const active = await prisma.smartMoneyRawAddress.count({
      where: rawPoolActiveWhere,
    });
    const watermark = CONFIG.smartMoneyDiscoveryRawWatermark;
    const pressureLine = Math.floor(CONFIG.smartMoneyRawPoolMaxActive * Math.min(0.95, watermark + 0.05));
    if (active >= pressureLine && !isFast) {
      const delayDays = CONFIG.smartMoneyL0DbBackpressureDelayDays;
      await transitionPipelineStage(normalized, 'RAW', {
        nextLightAnalyzeAt: new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000),
        tierFailReason: 'L0-DB:BACKPRESSURE',
      });
      return { action: 'SKIP_DONE', passedTier1L: false, reason: 'L0-DB:BACKPRESSURE' };
    }
  }

  return { action: 'CONTINUE_HTML' };
}

export async function runLightL0DbBatch(wallets: string[]): Promise<Map<string, L0DbResult>> {
  const out = new Map<string, L0DbResult>();
  for (const wallet of wallets) {
    out.set(wallet.toLowerCase(), await runLightL0DbForWallet(wallet));
  }
  return out;
}
