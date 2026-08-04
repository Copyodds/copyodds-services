-- Phase 1: pipeline tables + CopyPool fields on leaderboard cache

ALTER TABLE "SmartMoneyLeaderboardRow"
  ADD COLUMN IF NOT EXISTS "inCopyPool" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "copyPoolEnteredAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "copyPoolExitedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "copyPoolMissCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "SmartMoneyLeaderboardRow_inCopyPool_rank_idx"
  ON "SmartMoneyLeaderboardRow" ("inCopyPool", "rank");

CREATE TABLE IF NOT EXISTS "SmartMoneyRawAddress" (
  "wallet" TEXT NOT NULL,
  "sources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "firstSeenAt" TIMESTAMPTZ NOT NULL,
  "lastSeenAt" TIMESTAMPTZ NOT NULL,
  "lastLightQueuedAt" TIMESTAMPTZ,
  "lastDeepQueuedAt" TIMESTAMPTZ,
  "nextLightAnalyzeAt" TIMESTAMPTZ,
  "nextDeepAnalyzeAt" TIMESTAMPTZ,
  "lightAnalyzeCursor" BIGINT NOT NULL DEFAULT 0,
  "deepAnalyzeCursor" BIGINT NOT NULL DEFAULT 0,
  "pipelineStage" TEXT NOT NULL DEFAULT 'RAW',
  "tier1lPassedAt" TIMESTAMPTZ,
  "tier1fPassedAt" TIMESTAMPTZ,
  "tier2CorePassedAt" TIMESTAMPTZ,
  "tier2EnhancedPassedAt" TIMESTAMPTZ,
  "tierFailReason" TEXT,
  "dormant" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmartMoneyRawAddress_pkey" PRIMARY KEY ("wallet")
);

CREATE INDEX IF NOT EXISTS "SmartMoneyRawAddress_pipelineStage_nextLightAnalyzeAt_idx"
  ON "SmartMoneyRawAddress" ("pipelineStage", "nextLightAnalyzeAt");
CREATE INDEX IF NOT EXISTS "SmartMoneyRawAddress_pipelineStage_nextDeepAnalyzeAt_idx"
  ON "SmartMoneyRawAddress" ("pipelineStage", "nextDeepAnalyzeAt");
CREATE INDEX IF NOT EXISTS "SmartMoneyRawAddress_lightAnalyzeCursor_idx"
  ON "SmartMoneyRawAddress" ("lightAnalyzeCursor");
CREATE INDEX IF NOT EXISTS "SmartMoneyRawAddress_deepAnalyzeCursor_idx"
  ON "SmartMoneyRawAddress" ("deepAnalyzeCursor");

CREATE TABLE IF NOT EXISTS "SmartMoneyPipelineCursor" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "lightRoundRobinCounter" BIGINT NOT NULL DEFAULT 0,
  "deepRoundRobinCounter" BIGINT NOT NULL DEFAULT 0,
  "lastLightTickAt" TIMESTAMPTZ,
  "lastDeepTickAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmartMoneyPipelineCursor_pkey" PRIMARY KEY ("id")
);

INSERT INTO "SmartMoneyPipelineCursor" ("id")
VALUES (1)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "SmartMoneyScoreCache" (
  "wallet" TEXT NOT NULL,
  "score" DECIMAL(20,8) NOT NULL,
  "scoreVersion" TEXT NOT NULL,
  "riskFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "scoreExplain" JSONB,
  "tier1fPassedAt" TIMESTAMPTZ,
  "tier2CorePassedAt" TIMESTAMPTZ,
  "tier2EnhancedPassedAt" TIMESTAMPTZ,
  "lastScoredAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmartMoneyScoreCache_pkey" PRIMARY KEY ("wallet")
);

CREATE INDEX IF NOT EXISTS "SmartMoneyScoreCache_score_idx"
  ON "SmartMoneyScoreCache" ("score" DESC);
CREATE INDEX IF NOT EXISTS "SmartMoneyScoreCache_lastScoredAt_idx"
  ON "SmartMoneyScoreCache" ("lastScoredAt");
