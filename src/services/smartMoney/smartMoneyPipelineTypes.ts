export const PIPELINE_STAGES = [
  'RAW',
  'LIGHT_ANALYZING',
  'QUALIFIED',
  'FULL_ANALYZING',
  'SCORED',
  'COPY_POOL',
  'BLOCKED',
  'DORMANT',
  'ELIMINATED',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const DEEP_PIPELINE_STAGES: PipelineStage[] = ['QUALIFIED', 'SCORED', 'COPY_POOL'];

export const COPY_POOL_HARD_FLAGS = [
  'BLACKLISTED',
  'NEGATIVE_TOTAL_PNL',
  'HEDGED_PAIR_EXPOSURE',
  // HIGH_TRADE_FREQUENCY：改为软扣分，不硬拦；靠平均盈利率等质量门过滤
  'TRADE_FREQUENCY_UNVERIFIED',
  // LIKELY_BOT：九地址标定后改为软扣分，不再硬拦 CopyPool
  // LOW_COPYABILITY：F7 起改为软标记（Enrich 不再因此踢池）
  // SHORT_HORIZON_MARKET：短周期盘占比过高 → 软扣分，不硬拦
  /** 平均盈利率（meanReturn）低于配置下限，不进推荐榜 */
  'LOW_AVG_CLOSED_RETURN_RATE',
  // DATA_MISMATCH 降为软惩罚（扣分），不再硬拦 CopyPool
] as const;
