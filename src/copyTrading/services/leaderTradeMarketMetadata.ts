import { prisma } from '../../db';
import {
  fetchMarketMetadataForClobTokenIds,
  type PolymarketTokenMarketMetadata,
} from '../../services/polymarket/markets';

/** Gamma 元数据查询超时（leader 入库 / dispatch / backfill 共用） */
export const GAMMA_MARKET_METADATA_TIMEOUT_MS = 5_000;

export function pickMarketTitleFromMetadata(
  meta: PolymarketTokenMarketMetadata | null | undefined
): string | null {
  if (!meta) return null;
  return meta.eventTitle ?? meta.title ?? meta.question ?? meta.marketLabel ?? null;
}

export async function resolveMarketFieldsFromTokenId(
  tokenId: string,
  existing?: { marketTitle?: string | null; outcome?: string | null },
  options?: { forceRefresh?: boolean }
): Promise<{ marketTitle: string | null; outcome: string | null }> {
  const marketTitle = existing?.marketTitle?.trim() || null;
  const outcome = existing?.outcome?.trim() || null;
  if (marketTitle && outcome) {
    return { marketTitle, outcome };
  }

  const tid = tokenId.trim();
  if (!/^\d+$/.test(tid)) {
    return { marketTitle, outcome };
  }

  const metaMap = await fetchMarketMetadataForClobTokenIds([tid], {
    forceRefresh: options?.forceRefresh ?? false,
    timeoutMs: GAMMA_MARKET_METADATA_TIMEOUT_MS,
  }).catch(() => new Map<string, PolymarketTokenMarketMetadata>());
  const meta = metaMap.get(tid);

  return {
    marketTitle: marketTitle ?? pickMarketTitleFromMetadata(meta),
    outcome: outcome ?? meta?.outcome?.trim() ?? null,
  };
}

/** 将市场名写回 LeaderTrade，并同步缺失标题的 CopyTradeRow。 */
export async function persistLeaderTradeMarketMetadata(
  leaderTradeId: string,
  fields: { marketTitle: string | null; outcome: string | null }
): Promise<void> {
  const marketTitle = fields.marketTitle?.trim() || null;
  const outcome = fields.outcome?.trim() || null;
  if (!marketTitle && !outcome) return;

  await prisma.leaderTrade.update({
    where: { id: leaderTradeId },
    data: {
      ...(marketTitle ? { marketTitle } : {}),
      ...(outcome ? { outcome } : {}),
    },
  });

  if (marketTitle) {
    await prisma.copyTradeRow.updateMany({
      where: { leaderTradeId, marketTitle: null },
      data: { marketTitle },
    });
  }
  if (outcome) {
    await prisma.copyTradeRow.updateMany({
      where: { leaderTradeId, outcome: null },
      data: { outcome },
    });
  }
}

/** 按 tokenId 将已解析的市场元数据写回所有相关 LeaderTrade / CopyTradeRow。 */
export async function persistMarketMetadataForTokenId(
  tokenId: string,
  meta: PolymarketTokenMarketMetadata
): Promise<void> {
  const marketTitle = pickMarketTitleFromMetadata(meta);
  const outcome = meta.outcome?.trim() || null;
  if (!marketTitle && !outcome) return;

  const leaders = await prisma.leaderTrade.findMany({
    where: {
      tokenId,
      OR: [
        { marketTitle: null },
        { marketTitle: '' },
        { outcome: null },
        { outcome: '' },
      ],
    },
    select: { id: true },
    take: 20,
  });
  for (const leader of leaders) {
    await persistLeaderTradeMarketMetadata(leader.id, { marketTitle, outcome });
  }
}
/** 后台补全市场名，不阻塞 leader-signal / dispatch 主路径。 */
export function scheduleLeaderTradeMarketMetadataEnrich(
  leaderTradeId: string,
  tokenId: string,
  existing?: { marketTitle?: string | null; outcome?: string | null }
): void {
  if (existing?.marketTitle?.trim() && existing?.outcome?.trim()) return;
  void enrichLeaderTradeMarketMetadata(leaderTradeId, tokenId, existing).catch((error: unknown) => {
    console.warn('[leader-trade-metadata] background enrich failed', {
      leaderTradeId,
      tokenId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** 若 DB 缺标题则查 Gamma/CLOB 并持久化；失败时静默跳过。 */
export async function enrichLeaderTradeMarketMetadata(
  leaderTradeId: string,
  tokenId: string,
  existing?: { marketTitle?: string | null; outcome?: string | null }
): Promise<{ marketTitle: string | null; outcome: string | null }> {
  const resolved = await resolveMarketFieldsFromTokenId(tokenId, existing);
  await persistLeaderTradeMarketMetadata(leaderTradeId, resolved);
  return resolved;
}
