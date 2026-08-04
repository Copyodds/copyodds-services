-- Phase 0: smart money leaderboard display provenance + ObservedTrader pipeline prep

ALTER TABLE "SmartMoneyLeaderboardRow"
  ADD COLUMN IF NOT EXISTS "winRateSource" TEXT,
  ADD COLUMN IF NOT EXISTS "metricsSourceBadge" TEXT;

ALTER TABLE "ObservedTrader"
  ADD COLUMN IF NOT EXISTS "pipelineStage" TEXT NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN IF NOT EXISTS "sources" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "nextLightAnalyzeAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "nextDeepAnalyzeAt" TIMESTAMPTZ;
