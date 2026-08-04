-- Phase 3: rankScore + copier feedback snapshot on leaderboard

ALTER TABLE "SmartMoneyLeaderboardRow"
  ADD COLUMN IF NOT EXISTS "rankScore" DECIMAL(20, 8),
  ADD COLUMN IF NOT EXISTS "rankScoreComputedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "copierFeedback" JSONB;

CREATE INDEX IF NOT EXISTS "SmartMoneyLeaderboardRow_inCopyPool_rankScore_idx"
  ON "SmartMoneyLeaderboardRow" ("inCopyPool", "rankScore" DESC);
