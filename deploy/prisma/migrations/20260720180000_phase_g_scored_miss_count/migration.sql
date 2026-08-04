-- Phase G: SCORED 连续未入榜计数，用于强制出池
ALTER TABLE "SmartMoneyRawAddress"
  ADD COLUMN IF NOT EXISTS "scoredMissCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "SmartMoneyRawAddress_pipelineStage_scoredMissCount_idx"
  ON "SmartMoneyRawAddress" ("pipelineStage", "scoredMissCount");
