-- AlterTable
ALTER TABLE "ObservedTrader" ADD COLUMN "candidateOrigin" TEXT NOT NULL DEFAULT 'LEADERBOARD';

-- CreateIndex
CREATE INDEX "ObservedTrader_candidateOrigin_candidateActive_idx" ON "ObservedTrader"("candidateOrigin", "candidateActive");

-- CreateTable
CREATE TABLE "BlockScanDiscoveredTrader" (
    "wallet" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastBlockNumber" INTEGER NOT NULL,
    "fillCount" INTEGER NOT NULL DEFAULT 0,
    "windowStartBlock" INTEGER NOT NULL,
    "windowFillCount" INTEGER NOT NULL DEFAULT 0,
    "maxSingleNotional" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "qualifiedAt" TIMESTAMP(3),
    "promotedAt" TIMESTAMP(3),
    "lastIngestAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlockScanDiscoveredTrader_pkey" PRIMARY KEY ("wallet")
);

-- CreateIndex
CREATE INDEX "BlockScanDiscoveredTrader_qualifiedAt_idx" ON "BlockScanDiscoveredTrader"("qualifiedAt");

-- CreateIndex
CREATE INDEX "BlockScanDiscoveredTrader_promotedAt_qualifiedAt_idx" ON "BlockScanDiscoveredTrader"("promotedAt", "qualifiedAt");

-- CreateIndex
CREATE INDEX "BlockScanDiscoveredTrader_lastSeenAt_idx" ON "BlockScanDiscoveredTrader"("lastSeenAt");
