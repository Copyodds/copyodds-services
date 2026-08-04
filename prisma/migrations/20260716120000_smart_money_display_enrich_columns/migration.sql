-- Smart Money 榜单展示/仿真字段提列 + Deep-Enrich 游标
ALTER TABLE "SmartMoneyLeaderboardRow"
  ADD COLUMN IF NOT EXISTS "recentPnl7d" DECIMAL(38, 18),
  ADD COLUMN IF NOT EXISTS "trades7d" INTEGER,
  ADD COLUMN IF NOT EXISTS "totalPnl1y" DECIMAL(38, 18),
  ADD COLUMN IF NOT EXISTS "pnlWindowDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "backtestPnlUsd" DECIMAL(38, 18),
  ADD COLUMN IF NOT EXISTS "copyLossRate" DECIMAL(20, 8),
  ADD COLUMN IF NOT EXISTS "slippageBpsEffective" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastCurveEnrichAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SmartMoneyLeaderboardRow_lastCurveEnrichAt_idx"
  ON "SmartMoneyLeaderboardRow"("lastCurveEnrichAt");
