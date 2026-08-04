-- AlterTable
ALTER TABLE "AutomationSessionGrant" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ObservedTrader" (
    "id" SERIAL NOT NULL,
    "wallet" TEXT NOT NULL,
    "profileSlug" TEXT,
    "sourceRankWeek" INTEGER,
    "sourceRankMonth" INTEGER,
    "sourceRankAll" INTEGER,
    "candidatePeriods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "blacklisted" BOOLEAN NOT NULL DEFAULT false,
    "noiseTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastFetchedAt" TIMESTAMP(3),
    "lastScoredAt" TIMESTAMP(3),
    "fetchFailCount" INTEGER NOT NULL DEFAULT 0,
    "lastFetchError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObservedTrader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraderProfileSnapshot" (
    "id" SERIAL NOT NULL,
    "wallet" TEXT NOT NULL,
    "profileSlug" TEXT,
    "displayName" TEXT,
    "joinedAtText" TEXT,
    "viewsText" TEXT,
    "holdingsValue" DECIMAL(38,18),
    "biggestWin" DECIMAL(38,18),
    "predictionCount" INTEGER,
    "rawSummary" JSONB,
    "sourceUrl" TEXT,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TraderProfileSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraderCurvePoint" (
    "id" SERIAL NOT NULL,
    "wallet" TEXT NOT NULL,
    "curveType" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(38,18) NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TraderCurvePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmartMoneyLeaderboardRow" (
    "id" SERIAL NOT NULL,
    "wallet" TEXT NOT NULL,
    "rank" INTEGER,
    "score" DECIMAL(20,8) NOT NULL,
    "pnlQuality" DECIMAL(20,8) NOT NULL,
    "activityScore" DECIMAL(20,8) NOT NULL,
    "consistencyScore" DECIMAL(20,8) NOT NULL,
    "riskPenalty" DECIMAL(20,8) NOT NULL,
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scoreVersion" TEXT NOT NULL,
    "sourceFetchedAt" TIMESTAMP(3),
    "lastScoredAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "displayName" TEXT,
    "profileSlug" TEXT,
    "predictionCount" INTEGER,
    "holdingsValue" DECIMAL(38,18),
    "sourceRankWeek" INTEGER,
    "sourceRankMonth" INTEGER,
    "sourceRankAll" INTEGER,
    "candidatePeriods" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "SmartMoneyLeaderboardRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ObservedTrader_wallet_key" ON "ObservedTrader"("wallet");

-- CreateIndex
CREATE INDEX "ObservedTrader_enabled_blacklisted_idx" ON "ObservedTrader"("enabled", "blacklisted");

-- CreateIndex
CREATE INDEX "ObservedTrader_lastFetchedAt_idx" ON "ObservedTrader"("lastFetchedAt");

-- CreateIndex
CREATE INDEX "ObservedTrader_lastSeenAt_idx" ON "ObservedTrader"("lastSeenAt");

-- CreateIndex
CREATE INDEX "TraderProfileSnapshot_wallet_snapshotAt_idx" ON "TraderProfileSnapshot"("wallet", "snapshotAt");

-- CreateIndex
CREATE INDEX "TraderProfileSnapshot_profileSlug_idx" ON "TraderProfileSnapshot"("profileSlug");

-- CreateIndex
CREATE INDEX "TraderCurvePoint_wallet_curveType_snapshotAt_idx" ON "TraderCurvePoint"("wallet", "curveType", "snapshotAt");

-- CreateIndex
CREATE INDEX "TraderCurvePoint_wallet_ts_idx" ON "TraderCurvePoint"("wallet", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "SmartMoneyLeaderboardRow_wallet_key" ON "SmartMoneyLeaderboardRow"("wallet");

-- CreateIndex
CREATE INDEX "SmartMoneyLeaderboardRow_eligible_score_idx" ON "SmartMoneyLeaderboardRow"("eligible", "score" DESC);

-- CreateIndex
CREATE INDEX "SmartMoneyLeaderboardRow_rank_idx" ON "SmartMoneyLeaderboardRow"("rank");

-- CreateIndex
CREATE INDEX "SmartMoneyLeaderboardRow_syncedAt_idx" ON "SmartMoneyLeaderboardRow"("syncedAt");
