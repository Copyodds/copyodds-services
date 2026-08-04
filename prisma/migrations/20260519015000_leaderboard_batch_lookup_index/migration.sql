-- Speed up latest-batch reads and stale-batch pruning for each official leaderboard preset.
CREATE INDEX IF NOT EXISTS "LeaderboardRow_category_timePeriod_orderBy_batchId_idx"
ON "LeaderboardRow"("category", "timePeriod", "orderBy", "batchId");
