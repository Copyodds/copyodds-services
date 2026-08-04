-- 诊断：L1 本地曲线 vs 列表展示指标是否分裂（在测试服 psql 执行）
-- usage:
--   psql "$DATABASE_URL" -f scripts/diagnose-l1-vs-display.sql
-- 或把下面 SQL 贴进会话。

\echo '=== CopyPool 样本：展示回报 / 展示回撤 / explain 里本地 vs 外部 ==='

SELECT
  sm.rank,
  left(sm.wallet, 10) AS wallet,
  round(sm.score::numeric, 1) AS score,
  -- 列表「总回报」列（库里是百分数 = ratio*100）
  sm."externalTotalReturn" AS display_return_pct,
  sm."externalMetricsSource" AS metrics_src,
  -- 列表回撤：优先 externalPrimary
  NULLIF(sm."scoreExplain"->'externalPrimary'->>'maxDrawdownPercent', '')::numeric AS pt_mdd,
  NULLIF(sm."scoreExplain"->'externalPrimary'->>'totalReturn', '')::numeric AS pt_return_ratio,
  NULLIF(sm."scoreExplain"->'eligibilityV23'->>'effectiveMaxDrawdown', '')::numeric AS effective_mdd,
  NULLIF(sm."scoreExplain"->'externalLocalFallback'->'all'->>'maxDrawdownPercent', '')::numeric AS local_mdd,
  NULLIF(sm."scoreExplain"->'externalLocalFallback'->'all'->>'totalReturn', '')::numeric AS local_return_ratio,
  -- 若用「展示回报比率」vs 「展示回撤」判断 maxDD<=return 是否该过
  CASE
    WHEN NULLIF(sm."scoreExplain"->'externalPrimary'->>'totalReturn', '')::numeric IS NULL
      AND sm."externalTotalReturn" IS NULL THEN 'NO_DISPLAY_RETURN'
    WHEN COALESCE(
           NULLIF(sm."scoreExplain"->'externalPrimary'->>'totalReturn', '')::numeric,
           CASE WHEN abs(sm."externalTotalReturn") > 10
             THEN sm."externalTotalReturn"/100
             ELSE sm."externalTotalReturn" END
         )
         < 0.2 THEN 'FAIL_L1_RET'
    WHEN COALESCE(
           NULLIF(sm."scoreExplain"->'eligibilityV23'->>'effectiveMaxDrawdown', '')::numeric,
           NULLIF(sm."scoreExplain"->'externalPrimary'->>'maxDrawdownPercent', '')::numeric
         )
         > COALESCE(
           NULLIF(sm."scoreExplain"->'externalPrimary'->>'totalReturn', '')::numeric,
           CASE WHEN abs(sm."externalTotalReturn") > 10
             THEN sm."externalTotalReturn"/100
             ELSE sm."externalTotalReturn" END
         )
      THEN 'FAIL_L1_DD'
    ELSE 'PASS_DISPLAY_ALIGNED'
  END AS display_aligned_l1,
  sm."riskFlags"
FROM "SmartMoneyLeaderboardRow" sm
WHERE sm."inCopyPool" = true
ORDER BY sm.rank ASC NULLS LAST, sm.score DESC
LIMIT 30;

\echo '=== 展示回撤>=0.99 仍在池中的数量 ==='
SELECT count(*) AS copy_pool_mdd_near_100
FROM "SmartMoneyLeaderboardRow" sm
WHERE sm."inCopyPool" = true
  AND COALESCE(
        NULLIF(sm."scoreExplain"->'eligibilityV23'->>'effectiveMaxDrawdown', '')::numeric,
        NULLIF(sm."scoreExplain"->'externalPrimary'->>'maxDrawdownPercent', '')::numeric,
        NULLIF(sm."scoreExplain"->'externalLocalFallback'->'all'->>'maxDrawdownPercent', '')::numeric
      ) >= 0.99;

\echo '=== RawAddress 上近次 L1 失败原因（若有）==='
SELECT left(wallet, 10) AS wallet, "pipelineStage", "tierFailReason"
FROM "SmartMoneyRawAddress"
WHERE "tierFailReason" ILIKE '%L1-%'
ORDER BY "updatedAt" DESC NULLS LAST
LIMIT 20;
