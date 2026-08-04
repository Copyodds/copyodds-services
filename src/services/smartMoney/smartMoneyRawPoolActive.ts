/**
 * RAW 池水位口径（设计 D-RAW）：只统计仍占「原始池」槽位的阶段。
 * COPY_POOL / SCORED / QUALIFIED / FULL_ANALYZING 已晋级，不得计入补池水位，
 * 否则 CopyPool 涨满后 active≥target，RAW 会被永久饿死。
 */
export const RAW_POOL_OCCUPYING_STAGES: string[] = ['RAW', 'LIGHT_ANALYZING'];

export type RawPoolOccupyingStage = 'RAW' | 'LIGHT_ANALYZING';

export const rawPoolActiveWhere: {
  dormant: boolean;
  pipelineStage: { in: string[] };
} = {
  dormant: false,
  pipelineStage: { in: RAW_POOL_OCCUPYING_STAGES },
};
