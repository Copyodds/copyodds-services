-- Phase 2: copyabilityScore + displayScore on leaderboard; scores on CopyLeader

ALTER TABLE "SmartMoneyLeaderboardRow"
  ADD COLUMN IF NOT EXISTS "copyabilityScore" DECIMAL(20, 8),
  ADD COLUMN IF NOT EXISTS "displayScore" DECIMAL(20, 8),
  ADD COLUMN IF NOT EXISTS "copyabilityComputedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SmartMoneyLeaderboardRow_inCopyPool_displayScore_idx"
  ON "SmartMoneyLeaderboardRow" ("inCopyPool", "displayScore" DESC);

ALTER TABLE "CopyLeader"
  ADD COLUMN IF NOT EXISTS "smartMoneyScore" DECIMAL(20, 8),
  ADD COLUMN IF NOT EXISTS "copyabilityScore" DECIMAL(20, 8);
