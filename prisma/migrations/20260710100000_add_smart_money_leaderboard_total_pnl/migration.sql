-- Persist resolved total PnL for leaderboard sort/filter (align rank with 盈利 column).
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "totalPnl" DECIMAL(38,18);

UPDATE "SmartMoneyLeaderboardRow"
SET "totalPnl" = COALESCE(
  NULLIF("scoreExplain"->'resolvedMetrics'->>'totalPnl', '')::numeric,
  NULLIF("scoreExplain"->'rawMetrics'->>'totalPnl', '')::numeric
);

CREATE INDEX "SmartMoneyLeaderboardRow_eligible_totalPnl_idx"
  ON "SmartMoneyLeaderboardRow" ("eligible", "totalPnl" DESC);
