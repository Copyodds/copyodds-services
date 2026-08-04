import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import { hasLeaderboardSource, isLeaderboardSource } from './smartMoneyRawSource';
import { checkRawSourceQuotaForIngest } from './smartMoneyRawSourceQuota';
import { rawPoolActiveWhere, RAW_POOL_OCCUPYING_STAGES } from './smartMoneyRawPoolActive';

export type RawIngestInput = {
  wallet: string;
  source: string;
};

export type RawIngestOptions = {
  /** 榜源保留配额路径：绕过榜分源 cap */
  leaderboardReserved?: boolean;
};

export type RawIngestResult = {
  /** 新建 RAW + 已有非淘汰地址元数据刷新；不包含成功复活 */
  ingested: number;
  created: number;
  refreshed: number;
  reactivated: number;
  /** 淘汰地址仍在冷却或来源不允许复活，未做任何写入 */
  skippedEliminated: number;
};

function normalizeWallet(wallet: string): string | null {
  const normalized = wallet.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

/** 榜源再上榜 / 强信号：重置 Light 调度 */
function shouldBumpLightOnIngest(incomingSources: Set<string>, wasDormant: boolean): boolean {
  if (wasDormant) return true;
  for (const source of incomingSources) {
    if (isLeaderboardSource(source)) return true;
  }
  return false;
}

/** 批内并发上限：不同 wallet 互不冲突，实际并发受 DATABASE_POOL_MAX 约束 */
const RAW_INGEST_CONCURRENCY = 20;

export async function ingestSmartMoneyRawAddresses(
  rows: RawIngestInput[],
  options?: RawIngestOptions
): Promise<RawIngestResult> {
  const now = new Date();
  let ingested = 0;
  let created = 0;
  let refreshed = 0;
  let reactivated = 0;
  let skippedEliminated = 0;

  // 按 wallet 去重并合并 source，避免同批重复行产生并发写同一行
  const byWallet = new Map<string, Set<string>>();
  for (const row of rows) {
    const wallet = normalizeWallet(row.wallet);
    if (!wallet) continue;
    const sources = byWallet.get(wallet) ?? new Set<string>();
    sources.add(row.source);
    byWallet.set(wallet, sources);
  }
  const entries = [...byWallet.entries()];

  for (let i = 0; i < entries.length; i += RAW_INGEST_CONCURRENCY) {
    const chunk = entries.slice(i, i + RAW_INGEST_CONCURRENCY);
    await Promise.all(
      chunk.map(async ([wallet, incomingSources]) => {
        const existing = await prisma.smartMoneyRawAddress.findUnique({
          where: { wallet },
          select: {
            sources: true,
            dormant: true,
            pipelineStage: true,
            updatedAt: true,
            tier1lPassedAt: true,
            lastIngestedAt: true,
          },
        });

        const sources = new Set(existing?.sources ?? []);
        for (const source of incomingSources) sources.add(source);
        const sourceList = [...sources];

        if (!existing) {
          const quota = await checkRawSourceQuotaForIngest(sourceList, {
            leaderboardReserved: options?.leaderboardReserved,
          });
          if (!quota.allowed) return;

          if (CONFIG.smartMoneyRawPoolMaxActive > 0) {
            const active = await prisma.smartMoneyRawAddress.count({
              where: rawPoolActiveWhere,
            });
            if (active >= CONFIG.smartMoneyRawPoolMaxActive) {
              return;
            }
          }

          await prisma.smartMoneyRawAddress.create({
            data: {
              wallet,
              sources: sourceList,
              firstSeenAt: now,
              lastSeenAt: now,
              lastIngestedAt: now,
              pipelineStage: 'RAW',
              nextLightAnalyzeAt: now,
            },
          });
          ingested += 1;
          created += 1;
          return;
        }

        if (existing.pipelineStage === 'ELIMINATED') {
          const { reviveEliminatedOnStrongSource } = await import('./smartMoneyEliminated.js');
          let revived = false;
          for (const source of incomingSources) {
            if (
              await reviveEliminatedOnStrongSource(wallet, source, {
                sources: sourceList,
                lastSeenAt: now,
                lastIngestedAt: now,
              })
            ) {
              revived = true;
              break;
            }
          }
          if (!revived) {
            skippedEliminated += 1;
            return;
          }
          reactivated += 1;
          return;
        }

        const wasDormant = existing.dormant;
        const bumpLight = shouldBumpLightOnIngest(incomingSources, wasDormant);
        const inRawPipeline =
          existing.pipelineStage === 'RAW' || existing.pipelineStage === 'LIGHT_ANALYZING';

        const updated = await prisma.smartMoneyRawAddress.updateMany({
          where: {
            wallet,
            pipelineStage: existing.pipelineStage,
            updatedAt: existing.updatedAt,
          },
          data: {
            sources: sourceList,
            lastSeenAt: now,
            lastIngestedAt: now,
            ...(wasDormant
              ? {
                  dormant: false,
                  nextLightAnalyzeAt: now,
                  nextDeepAnalyzeAt: now,
                  pipelineStage:
                    existing.pipelineStage === 'DORMANT' ? 'RAW' : existing.pipelineStage,
                }
              : bumpLight && inRawPipeline && existing.tier1lPassedAt == null
                ? { nextLightAnalyzeAt: now, dormant: false }
                : {}),
          },
        });
        if (updated.count !== 1) return;

        if (existing.pipelineStage !== 'ELIMINATED') {
          if (wasDormant) {
            reactivated += 1;
          } else {
            ingested += 1;
            refreshed += 1;
          }
        }
      })
    );
  }

  const total = await prisma.smartMoneyRawAddress.count({
    where: rawPoolActiveWhere,
  });

  if (CONFIG.smartMoneyRawPoolMaxActive > 0 && total > CONFIG.smartMoneyRawPoolMaxActive) {
    const overflow = total - CONFIG.smartMoneyRawPoolMaxActive;
    const dormantCandidates = await prisma.smartMoneyRawAddress.findMany({
      where: {
        dormant: false,
        pipelineStage: { in: [...RAW_POOL_OCCUPYING_STAGES] },
      },
      orderBy: [{ lastSeenAt: 'asc' }],
      take: overflow * 2,
      select: { wallet: true, sources: true },
    });

    const victims = dormantCandidates
      .filter((row) => !hasLeaderboardSource(row.sources))
      .slice(0, overflow)
      .map((row) => row.wallet);

    if (victims.length > 0) {
      await prisma.smartMoneyRawAddress.updateMany({
        where: { wallet: { in: victims } },
        data: { dormant: true },
      });
    }
  }

  return { ingested, created, refreshed, reactivated, skippedEliminated };
}

export async function ingestSmartMoneyRawAddress(
  wallet: string,
  source: string,
  options?: RawIngestOptions
): Promise<void> {
  await ingestSmartMoneyRawAddresses([{ wallet, source }], options);
}
