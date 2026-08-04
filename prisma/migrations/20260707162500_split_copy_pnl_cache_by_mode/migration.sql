ALTER TABLE "UserSettings"
  ADD COLUMN IF NOT EXISTS "copyPnlRealTotalUsd" DECIMAL(38, 18),
  ADD COLUMN IF NOT EXISTS "copyPnlRealTodayUsd" DECIMAL(38, 18),
  ADD COLUMN IF NOT EXISTS "copyPnlRealWindowStartAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "copyPnlRealComputedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "copyPnlVirtualTotalUsd" DECIMAL(38, 18),
  ADD COLUMN IF NOT EXISTS "copyPnlVirtualTodayUsd" DECIMAL(38, 18),
  ADD COLUMN IF NOT EXISTS "copyPnlVirtualWindowStartAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "copyPnlVirtualComputedAt" TIMESTAMP(3);

UPDATE "UserSettings"
SET
  "copyPnlRealTotalUsd" = COALESCE("copyPnlRealTotalUsd", "copyPnlTotalUsd"),
  "copyPnlRealTodayUsd" = COALESCE("copyPnlRealTodayUsd", "copyPnlTodayUsd"),
  "copyPnlRealWindowStartAt" = COALESCE("copyPnlRealWindowStartAt", "copyPnlWindowStartAt"),
  "copyPnlRealComputedAt" = COALESCE("copyPnlRealComputedAt", "copyPnlComputedAt")
WHERE
  "copyPnlTotalUsd" IS NOT NULL
  OR "copyPnlTodayUsd" IS NOT NULL
  OR "copyPnlWindowStartAt" IS NOT NULL
  OR "copyPnlComputedAt" IS NOT NULL;
