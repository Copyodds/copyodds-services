-- pnl-summary: persist aggregates on user_settings (survives PM2 restart).
ALTER TABLE "UserSettings"
  ADD COLUMN IF NOT EXISTS "copyPnlTotalUsd" DECIMAL(38, 18),
  ADD COLUMN IF NOT EXISTS "copyPnlTodayUsd" DECIMAL(38, 18),
  ADD COLUMN IF NOT EXISTS "copyPnlWindowStartAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "copyPnlComputedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "LeaderTrade_tokenId_idx" ON "LeaderTrade" ("tokenId");
