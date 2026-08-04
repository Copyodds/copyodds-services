-- Recover totalVolume already present in the latest Profile snapshot.
-- Older API-fallback snapshots store it at rawSummary.leaderboardStats.totalVolume,
-- while snapshot reconstruction previously only read rawSummary.volumeSummary.amount.

WITH latest_volume AS (
  SELECT DISTINCT ON (wallet)
    wallet,
    COALESCE(
      "rawSummary" #>> '{totalVolume}',
      "rawSummary" #>> '{volumeSummary,amount}',
      "rawSummary" #>> '{volumeSummary,volume}',
      "rawSummary" #>> '{volumeSummary,totalVolume}',
      "rawSummary" #>> '{leaderboardStats,totalVolume}',
      "rawSummary" #>> '{leaderboardStats,vol}'
    ) AS total_volume
  FROM "TraderProfileSnapshot"
  ORDER BY wallet, "snapshotAt" DESC, id DESC
),
valid_volume AS (
  SELECT wallet, total_volume::numeric AS total_volume
  FROM latest_volume
  WHERE total_volume ~ '^[0-9]+(\.[0-9]+)?$'
)
UPDATE "SmartMoneyScoreCache" AS sc
SET
  "scoreExplain" = jsonb_set(
    jsonb_set(
      COALESCE(sc."scoreExplain", '{}'::jsonb),
      '{resolvedMetrics}',
      COALESCE(sc."scoreExplain"->'resolvedMetrics', '{}'::jsonb)
        || jsonb_build_object('totalVolume', v.total_volume),
      true
    ),
    '{rawMetrics}',
    COALESCE(sc."scoreExplain"->'rawMetrics', '{}'::jsonb)
      || jsonb_build_object('totalVolume', v.total_volume),
    true
  ),
  "updatedAt" = NOW()
FROM valid_volume AS v
WHERE sc.wallet = v.wallet
  AND sc."scoreExplain" #>> '{resolvedMetrics,totalVolume}' IS NULL;

WITH latest_volume AS (
  SELECT DISTINCT ON (wallet)
    wallet,
    COALESCE(
      "rawSummary" #>> '{totalVolume}',
      "rawSummary" #>> '{volumeSummary,amount}',
      "rawSummary" #>> '{volumeSummary,volume}',
      "rawSummary" #>> '{volumeSummary,totalVolume}',
      "rawSummary" #>> '{leaderboardStats,totalVolume}',
      "rawSummary" #>> '{leaderboardStats,vol}'
    ) AS total_volume
  FROM "TraderProfileSnapshot"
  ORDER BY wallet, "snapshotAt" DESC, id DESC
),
valid_volume AS (
  SELECT wallet, total_volume::numeric AS total_volume
  FROM latest_volume
  WHERE total_volume ~ '^[0-9]+(\.[0-9]+)?$'
)
UPDATE "SmartMoneyLeaderboardRow" AS lr
SET "scoreExplain" = jsonb_set(
  jsonb_set(
    COALESCE(lr."scoreExplain", '{}'::jsonb),
    '{resolvedMetrics}',
    COALESCE(lr."scoreExplain"->'resolvedMetrics', '{}'::jsonb)
      || jsonb_build_object('totalVolume', v.total_volume),
    true
  ),
  '{rawMetrics}',
  COALESCE(lr."scoreExplain"->'rawMetrics', '{}'::jsonb)
    || jsonb_build_object('totalVolume', v.total_volume),
  true
)
FROM valid_volume AS v
WHERE lr.wallet = v.wallet
  AND lr."scoreExplain" #>> '{resolvedMetrics,totalVolume}' IS NULL;
