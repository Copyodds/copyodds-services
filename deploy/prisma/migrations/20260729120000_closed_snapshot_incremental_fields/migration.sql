-- CopyPool dual-channel / Gate incremental observability columns
ALTER TABLE "SmartMoneyClosedSnapshot"
  ADD COLUMN IF NOT EXISTS "newestClosedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "oldestClosedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "incrementalEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastIncrementalAt" TIMESTAMP(3);
