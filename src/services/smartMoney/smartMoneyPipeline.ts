import { prisma } from '../../db';
import { CONFIG } from '../../config/env';
import type { PipelineStage } from './smartMoneyPipelineTypes';

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

export async function getPipelineRow(wallet: string) {
  return prisma.smartMoneyRawAddress.findUnique({
    where: { wallet: normalizeWallet(wallet) },
  });
}

export async function countPipelineStage(stage: PipelineStage): Promise<number> {
  return prisma.smartMoneyRawAddress.count({ where: { pipelineStage: stage } });
}

export async function countDeepQueueStages(): Promise<number> {
  return prisma.smartMoneyRawAddress.count({
    where: { pipelineStage: { in: ['QUALIFIED', 'SCORED', 'COPY_POOL'] } },
  });
}

export async function transitionPipelineStage(
  wallet: string,
  stage: PipelineStage,
  patch?: {
    tierFailReason?: string | null;
    tier1lPassedAt?: Date | null;
    tier1fPassedAt?: Date | null;
    tier2CorePassedAt?: Date | null;
    tier2EnhancedPassedAt?: Date | null;
    nextLightAnalyzeAt?: Date | null;
    nextDeepAnalyzeAt?: Date | null;
    nextElimCheckAt?: Date | null;
    elimFailCount?: number;
    elimFrozenUntil?: Date | null;
    elimBucket?: string;
    lastIngestedAt?: Date | null;
    lastTradeAt?: Date | null;
    dormant?: boolean;
    scoredMissCount?: number;
  }
): Promise<void> {
  const now = new Date();
  const data: Record<string, unknown> = {
    pipelineStage: stage,
    updatedAt: now,
  };
  if (patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) data[key] = value;
    }
  }
  await prisma.smartMoneyRawAddress.update({
    where: { wallet: normalizeWallet(wallet) },
    data,
  });
}

export function scheduleTierRetryMs(): number {
  return CONFIG.smartMoneyTier1RetryMs;
}

export async function bumpPipelineCursor(kind: 'light' | 'deep', delta: bigint): Promise<bigint> {
  if (kind === 'light') {
    const row = await prisma.smartMoneyPipelineCursor.upsert({
      where: { id: 1 },
      create: { id: 1, lightRoundRobinCounter: delta },
      update: { lightRoundRobinCounter: { increment: delta }, lastLightTickAt: new Date() },
    });
    return row.lightRoundRobinCounter;
  }
  const row = await prisma.smartMoneyPipelineCursor.upsert({
    where: { id: 1 },
    create: { id: 1, deepRoundRobinCounter: delta },
    update: { deepRoundRobinCounter: { increment: delta }, lastDeepTickAt: new Date() },
  });
  return row.deepRoundRobinCounter;
}

export async function getPipelineStageCounts(): Promise<Record<string, number>> {
  const groups = await prisma.smartMoneyRawAddress.groupBy({
    by: ['pipelineStage'],
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const row of groups) {
    out[row.pipelineStage] = row._count._all;
  }
  return out;
}

export async function wakePipelineAddress(wallet: string): Promise<void> {
  const now = new Date();
  await prisma.smartMoneyRawAddress.updateMany({
    where: { wallet: normalizeWallet(wallet) },
    data: {
      nextLightAnalyzeAt: now,
      nextDeepAnalyzeAt: now,
      dormant: false,
      lastSeenAt: now,
    },
  });
}
