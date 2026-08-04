import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { hasBlockScanSource, hasLeaderboardSource } from './smartMoneyRawSource';
import { rawPoolActiveWhere } from './smartMoneyRawPoolActive';

const ACTIVE_WHERE = rawPoolActiveWhere;

async function countActiveWithSourceFilter(
  predicate: (sources: string[]) => boolean
): Promise<number> {
  const rows = await prisma.smartMoneyRawAddress.findMany({
    where: ACTIVE_WHERE,
    select: { sources: true },
    take: 60_000,
  });
  return rows.filter((row) => predicate(row.sources ?? [])).length;
}

export async function countActiveLeaderboardRaw(): Promise<number> {
  return countActiveWithSourceFilter(hasLeaderboardSource);
}

export async function countActiveBlockScanRaw(): Promise<number> {
  return countActiveWithSourceFilter(hasBlockScanSource);
}

export type RawSourceQuotaCheck = {
  allowed: boolean;
  reason?: 'GLOBAL_CAP' | 'BOARD_CAP' | 'BLOCKSCAN_CAP';
};

/**
 * 新地址 ingest 前检查分源配额（H-D6）。
 * 榜源在保留配额路径下可绕过榜槽检查（由 candidate sync 控制）。
 */
export async function checkRawSourceQuotaForIngest(
  sources: string[],
  options?: { leaderboardReserved?: boolean }
): Promise<RawSourceQuotaCheck> {
  const boardCap = CONFIG.smartMoneyRawBoardActiveCap;
  const scanCap = CONFIG.smartMoneyRawBlockscanActiveCap;

  if (hasLeaderboardSource(sources)) {
    if (options?.leaderboardReserved) {
      return { allowed: true };
    }
    if (boardCap > 0) {
      const boardActive = await countActiveLeaderboardRaw();
      if (boardActive >= boardCap) {
        return { allowed: false, reason: 'BOARD_CAP' };
      }
    }
    return { allowed: true };
  }

  if (hasBlockScanSource(sources) && scanCap > 0) {
    const scanActive = await countActiveBlockScanRaw();
    if (scanActive >= scanCap) {
      return { allowed: false, reason: 'BLOCKSCAN_CAP' };
    }
  }

  return { allowed: true };
}
