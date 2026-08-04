-- Add batch id for atomic leaderboard batch switching.
ALTER TABLE "LeaderboardRow"
ADD COLUMN "batchId" TEXT;

UPDATE "LeaderboardRow"
SET "batchId" = CONCAT(
  'legacy-',
  COALESCE("syncVersion"::TEXT, '0'),
  '-',
  TO_CHAR("syncedAt", 'YYYYMMDDHH24MISSMS')
)
WHERE "batchId" IS NULL;

ALTER TABLE "LeaderboardRow"
ALTER COLUMN "batchId" SET NOT NULL;

WITH duplicate_rows AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "category", "timePeriod", "orderBy", "batchId", "rank"
      ORDER BY "id"
    ) AS row_num
  FROM "LeaderboardRow"
)
DELETE FROM "LeaderboardRow"
WHERE "id" IN (
  SELECT "id"
  FROM duplicate_rows
  WHERE row_num > 1
);

CREATE UNIQUE INDEX "LeaderboardRow_category_timePeriod_orderBy_batchId_rank_key"
ON "LeaderboardRow"("category", "timePeriod", "orderBy", "batchId", "rank");

CREATE INDEX "LeaderboardRow_category_orderBy_batchId_idx"
ON "LeaderboardRow"("category", "orderBy", "batchId");

CREATE INDEX "LeaderboardRow_batchId_idx"
ON "LeaderboardRow"("batchId");
