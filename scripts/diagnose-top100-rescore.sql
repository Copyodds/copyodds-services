-- TopN CopyPool 双通道日复评诊断（在测试库 psql 中执行）
--
-- dual_channel：今日未复评 = lastScoredAt 不在当天（UTC 或业务日）
-- 用法：
--   set -a && source .env && set +a
--   psql "$DATABASE_URL" -f scripts/diagnose-top100-rescore.sql

\echo '=== 1) Top100 榜行：lastScoredAt 分布（日 SLA）==='
SELECT
  COUNT(*) AS top100_total,
  COUNT(*) FILTER (WHERE "lastScoredAt" >= date_trunc('day', NOW() AT TIME ZONE 'UTC')) AS scored_today_utc,
  COUNT(*) FILTER (WHERE "lastScoredAt" >= NOW() - INTERVAL '24 hours') AS scored_24h,
  COUNT(*) FILTER (WHERE "lastScoredAt" IS NULL OR "lastScoredAt" < date_trunc('day', NOW() AT TIME ZONE 'UTC')) AS priority_due_today_utc,
  MIN("lastScoredAt") AS oldest_last_scored_at,
  MAX("lastScoredAt") AS newest_last_scored_at
FROM "SmartMoneyLeaderboardRow"
WHERE "inCopyPool" = true
  AND rank IS NOT NULL
  AND rank <= 100;

\echo ''
\echo '=== 2) Top100 明细（按 rank）==='
SELECT
  rank,
  LEFT(wallet, 10) || '…' AS wallet_prefix,
  "lastScoredAt",
  "sourceFetchedAt",
  "syncedAt",
  EXTRACT(EPOCH FROM (NOW() - "lastScoredAt")) / 3600 AS hours_since_scored
FROM "SmartMoneyLeaderboardRow"
WHERE "inCopyPool" = true
  AND rank IS NOT NULL
  AND rank <= 100
ORDER BY rank
LIMIT 100;

\echo ''
\echo '=== 3) dual_channel：Top100 待办（今日未 scored）且 Raw 在 COPY_POOL ==='
SELECT
  COUNT(*) AS priority_due_join
FROM "SmartMoneyLeaderboardRow" lb
JOIN "SmartMoneyRawAddress" ra ON ra.wallet = lb.wallet
WHERE lb."inCopyPool" = true
  AND lb.rank IS NOT NULL
  AND lb.rank <= 100
  AND ra."pipelineStage" = 'COPY_POOL'
  AND ra.dormant = false
  AND (
    lb."lastScoredAt" IS NULL
    OR lb."lastScoredAt" < date_trunc('day', NOW() AT TIME ZONE 'UTC')
  );

\echo ''
\echo '=== 4) background 可跑（rank 空或 >100）==='
SELECT
  COUNT(*) AS background_eligible
FROM "SmartMoneyRawAddress" ra
JOIN "SmartMoneyLeaderboardRow" lb ON lb.wallet = ra.wallet
WHERE ra."pipelineStage" = 'COPY_POOL'
  AND ra.dormant = false
  AND lb."inCopyPool" = true
  AND (lb.rank IS NULL OR lb.rank > 100)
  AND (ra."nextDeepAnalyzeAt" IS NULL OR ra."nextDeepAnalyzeAt" <= NOW());

\echo ''
\echo '=== 5) 游标 / 日 meta（DiscoveryCursor）==='
SELECT source, cursor, meta, "updatedAt"
FROM "SmartMoneyDiscoveryCursor"
WHERE source IN ('COPY_POOL_BG_CURSOR', 'COPY_POOL_DAILY_RESCORE_META');

\echo ''
\echo '=== 6) QUALIFIED 积压 vs CopyPool（槽位竞争）==='
SELECT
  (SELECT COUNT(*) FROM "SmartMoneyRawAddress"
   WHERE "pipelineStage" = 'QUALIFIED' AND dormant = false
     AND ("nextDeepAnalyzeAt" IS NULL OR "nextDeepAnalyzeAt" <= NOW())
  ) AS qualified_deep_ready,
  (SELECT COUNT(*) FROM "SmartMoneyRawAddress"
   WHERE "pipelineStage" = 'COPY_POOL' AND dormant = false
  ) AS copy_pool_stage_count;

\echo ''
\echo '=== 7) Gate 快照：Top100 READY / 过期 ==='
SELECT
  COUNT(*) FILTER (WHERE cs.status = 'READY' AND cs."expiresAt" > NOW()) AS gate_fresh,
  COUNT(*) FILTER (WHERE cs.status = 'READY' AND (cs."expiresAt" IS NULL OR cs."expiresAt" <= NOW())) AS gate_stale_ready,
  COUNT(*) FILTER (WHERE cs.id IS NULL) AS gate_missing,
  AVG(cs."pageCount") FILTER (WHERE cs.status = 'READY') AS avg_gate_pages
FROM "SmartMoneyLeaderboardRow" lb
LEFT JOIN "SmartMoneyClosedSnapshot" cs
  ON cs.wallet = lb.wallet AND cs.purpose = 'GATE' AND cs."windowDays" = 365
WHERE lb."inCopyPool" = true
  AND lb.rank IS NOT NULL
  AND lb.rank <= 100;
