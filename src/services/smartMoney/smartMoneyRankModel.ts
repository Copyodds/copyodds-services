import type { SmartMoneyLeaderboardRow } from '../../generated/prisma/client';
import { CONFIG } from '../../config/env';
import type { CopierFeedbackSnapshot } from './smartMoneyCopierFeedbackMetrics';

export type RankModelRowFeatures = {
  score: number;
  pnlQuality: number;
  activityScore: number;
  consistencyScore: number;
  externalQualityScore: number;
  copyabilityScore: number | null;
};

export type RankModelFeatures = {
  smartMoneyScore: number;
  pnlQuality: number;
  activityScore: number;
  consistencyScore: number;
  externalQualityScore: number;
  copyabilityScore: number | null;
  copierRoi: number | null;
  copierSampleWeight: number;
  tier2Enhanced: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

export function copierRoiToSignal(copierRoi: number): number {
  return clamp(50 + copierRoi * 100, 0, 100);
}

export function buildRankModelFeatures(input: {
  row: RankModelRowFeatures | Pick<
    SmartMoneyLeaderboardRow,
    | 'score'
    | 'pnlQuality'
    | 'activityScore'
    | 'consistencyScore'
    | 'externalQualityScore'
    | 'copyabilityScore'
  >;
  feedback?: CopierFeedbackSnapshot | null;
  tier2Enhanced?: boolean;
}): RankModelFeatures {
  return {
    smartMoneyScore: Number(input.row.score),
    pnlQuality: Number(input.row.pnlQuality),
    activityScore: Number(input.row.activityScore),
    consistencyScore: Number(input.row.consistencyScore),
    externalQualityScore: Number(input.row.externalQualityScore),
    copyabilityScore:
      input.row.copyabilityScore != null ? Number(input.row.copyabilityScore) : null,
    copierRoi: input.feedback?.copierRoi ?? null,
    copierSampleWeight: input.feedback?.sampleWeight ?? 0,
    tier2Enhanced: input.tier2Enhanced ?? false,
  };
}

export function inferRankScore(features: RankModelFeatures): number {
  const base =
    features.pnlQuality * 0.25 +
    features.consistencyScore * 0.2 +
    features.externalQualityScore * 0.15 +
    features.activityScore * 0.1 +
    features.smartMoneyScore * 0.3;

  let score = base;

  if (features.copyabilityScore != null) {
    score = score * 0.85 + features.copyabilityScore * 0.15;
  }

  if (features.copierRoi != null && features.copierSampleWeight > 0) {
    const copierSignal = copierRoiToSignal(features.copierRoi);
    const feedbackBlend = 0.35 * features.copierSampleWeight;
    score = score * (1 - feedbackBlend) + copierSignal * feedbackBlend;
  }

  if (features.tier2Enhanced) {
    score += 1.5;
  }

  return roundScore(clamp(score, 0, 100));
}

export function inferRankScoreFromRow(input: {
  row: RankModelRowFeatures | Pick<
    SmartMoneyLeaderboardRow,
    | 'score'
    | 'pnlQuality'
    | 'activityScore'
    | 'consistencyScore'
    | 'externalQualityScore'
    | 'copyabilityScore'
  >;
  feedback?: CopierFeedbackSnapshot | null;
  tier2Enhanced?: boolean;
}): number {
  return inferRankScore(buildRankModelFeatures(input));
}

export function isRankModelActive(): boolean {
  return CONFIG.smartMoneyRankModelEnabled && CONFIG.smartMoneyCopyabilityEnabled;
}
