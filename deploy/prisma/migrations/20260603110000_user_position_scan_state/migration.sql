-- Track users that need position/redeem scanning so the redeem cron does not scan every wallet.
CREATE TABLE "UserPositionScanState" (
    "userId" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "hasOpenPosition" BOOLEAN NOT NULL DEFAULT true,
    "nextScanAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastScannedAt" TIMESTAMP(3),
    "lastTradeAt" TIMESTAMP(3),
    "lastRedeemedAt" TIMESTAMP(3),
    "scanCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPositionScanState_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserPositionScanState"
ADD CONSTRAINT "UserPositionScanState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "UserPositionScanState_active_nextScanAt_idx"
ON "UserPositionScanState"("active", "nextScanAt");

CREATE INDEX "UserPositionScanState_hasOpenPosition_nextScanAt_idx"
ON "UserPositionScanState"("hasOpenPosition", "nextScanAt");

CREATE INDEX "UserPositionScanState_lastTradeAt_idx"
ON "UserPositionScanState"("lastTradeAt");
