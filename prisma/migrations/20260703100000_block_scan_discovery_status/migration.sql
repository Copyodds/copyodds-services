-- AlterTable
ALTER TABLE "BlockScanDiscoveredTrader" ADD COLUMN "scoredAt" TIMESTAMP(3);
ALTER TABLE "BlockScanDiscoveredTrader" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACCUMULATING';

-- Backfill
UPDATE "BlockScanDiscoveredTrader"
SET "status" = 'PROMOTED'
WHERE "promotedAt" IS NOT NULL AND "status" = 'ACCUMULATING';

-- CreateIndex
CREATE INDEX "BlockScanDiscoveredTrader_status_idx" ON "BlockScanDiscoveredTrader"("status");
