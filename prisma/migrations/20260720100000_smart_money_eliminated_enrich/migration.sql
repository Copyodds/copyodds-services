-- Phase B/D: eliminated pool fields + enrichPending for CopyPool async enrich
ALTER TABLE "SmartMoneyRawAddress"
  ADD COLUMN IF NOT EXISTS "elimFailCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "elimFrozenUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nextElimCheckAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SmartMoneyRawAddress_pipelineStage_nextElimCheckAt_idx"
  ON "SmartMoneyRawAddress"("pipelineStage", "nextElimCheckAt");

ALTER TABLE "SmartMoneyLeaderboardRow"
  ADD COLUMN IF NOT EXISTS "enrichPending" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "SmartMoneyLeaderboardRow_inCopyPool_enrichPending_idx"
  ON "SmartMoneyLeaderboardRow"("inCopyPool", "enrichPending");
