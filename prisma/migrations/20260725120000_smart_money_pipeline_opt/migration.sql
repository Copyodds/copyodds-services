-- 管道优化：RAW ingest 冷却 / 淘汰三态 / 发现源游标
ALTER TABLE "SmartMoneyRawAddress"
  ADD COLUMN IF NOT EXISTS "lastIngestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "elimBucket" TEXT NOT NULL DEFAULT 'HOT',
  ADD COLUMN IF NOT EXISTS "lastTradeAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SmartMoneyRawAddress_pipelineStage_elimBucket_nextElimCheckAt_idx"
  ON "SmartMoneyRawAddress"("pipelineStage", "elimBucket", "nextElimCheckAt");

CREATE INDEX IF NOT EXISTS "SmartMoneyRawAddress_lastIngestedAt_idx"
  ON "SmartMoneyRawAddress"("lastIngestedAt");

CREATE TABLE IF NOT EXISTS "SmartMoneyDiscoveryCursor" (
  "source" TEXT NOT NULL,
  "cursor" TEXT NOT NULL DEFAULT '0',
  "syncVersion" INTEGER,
  "meta" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SmartMoneyDiscoveryCursor_pkey" PRIMARY KEY ("source")
);
