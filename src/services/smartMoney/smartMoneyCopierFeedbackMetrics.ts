import { CONFIG } from '../../config/env';
import {
  computeTopSubscriberNotionalShare,
  isCopierWashSuspect,
} from './smartMoneyCopierAntiCheat';

export type CopierFeedbackSnapshot = {
  version: 'v1';
  lookbackDays: number;
  computedAt: string;
  closeCount: number;
  tradeCount: number;
  subscriberCount: number;
  totalPnlUsd: number;
  totalNotionalUsd: number;
  copierRoi: number | null;
  sampleWeight: number;
  excludedSelfCopyCount?: number;
  topSubscriberNotionalShare?: number | null;
  washSuspect?: boolean;
};

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function computeCopierRoi(totalPnlUsd: number, totalNotionalUsd: number): number | null {
  if (!Number.isFinite(totalPnlUsd) || !Number.isFinite(totalNotionalUsd)) return null;
  if (totalNotionalUsd <= 0) return null;
  return roundUsd(totalPnlUsd / totalNotionalUsd);
}

export function computeCopierSampleWeight(input: {
  closeCount: number;
  subscriberCount: number;
  minCloses: number;
  minSubscribers: number;
}): number {
  const closeWeight =
    input.minCloses <= 0 ? 1 : Math.min(1, input.closeCount / input.minCloses);
  const subscriberWeight =
    input.minSubscribers <= 0
      ? 1
      : Math.min(1, input.subscriberCount / input.minSubscribers);
  return roundUsd(Math.min(closeWeight, subscriberWeight));
}

export function buildCopierFeedbackSnapshot(input: {
  lookbackDays: number;
  computedAt?: Date;
  closeCount: number;
  tradeCount: number;
  subscriberCount: number;
  totalPnlUsd: number;
  totalNotionalUsd: number;
  minCloses?: number;
  minSubscribers?: number;
  excludedSelfCopyCount?: number;
  topSubscriberNotionalShare?: number | null;
}): CopierFeedbackSnapshot {
  const minCloses = input.minCloses ?? CONFIG.smartMoneyRankMinCopierCloses;
  const minSubscribers = input.minSubscribers ?? CONFIG.smartMoneyRankMinCopierSubscribers;
  const totalPnlUsd = roundUsd(input.totalPnlUsd);
  const totalNotionalUsd = roundUsd(input.totalNotionalUsd);
  const sampleWeight = computeCopierSampleWeight({
    closeCount: input.closeCount,
    subscriberCount: input.subscriberCount,
    minCloses,
    minSubscribers,
  });
  const copierRoi =
    sampleWeight >= 1 ? computeCopierRoi(totalPnlUsd, totalNotionalUsd) : null;
  const washSuspect = isCopierWashSuspect({
    topSubscriberNotionalShare: input.topSubscriberNotionalShare ?? null,
    excludedSelfCopyCount: input.excludedSelfCopyCount ?? 0,
  });

  return {
    version: 'v1',
    lookbackDays: input.lookbackDays,
    computedAt: (input.computedAt ?? new Date()).toISOString(),
    closeCount: input.closeCount,
    tradeCount: input.tradeCount,
    subscriberCount: input.subscriberCount,
    totalPnlUsd,
    totalNotionalUsd,
    copierRoi: washSuspect ? null : copierRoi,
    sampleWeight: washSuspect ? 0 : sampleWeight,
    excludedSelfCopyCount: input.excludedSelfCopyCount ?? 0,
    topSubscriberNotionalShare: input.topSubscriberNotionalShare ?? null,
    washSuspect,
  };
}

export function emptyCopierFeedbackSnapshot(
  lookbackDays = CONFIG.smartMoneyCopierFeedbackLookbackDays
): CopierFeedbackSnapshot {
  return buildCopierFeedbackSnapshot({
    lookbackDays,
    closeCount: 0,
    tradeCount: 0,
    subscriberCount: 0,
    totalPnlUsd: 0,
    totalNotionalUsd: 0,
  });
}
