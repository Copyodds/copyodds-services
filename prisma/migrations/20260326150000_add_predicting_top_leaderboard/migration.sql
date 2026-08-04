-- CreateTable
CREATE TABLE "PredictingTopLeaderboardRow" (
    "id" SERIAL NOT NULL,
    "period" TEXT NOT NULL,
    "syncVersion" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL,
    "wallet" TEXT NOT NULL,
    "name" TEXT,
    "twitter" TEXT,
    "profileImage" TEXT,
    "platform" TEXT,
    "polymarketProfile" TEXT,
    "walletCount" INTEGER,
    "pnl" DECIMAL(38,18),
    "buys" INTEGER,
    "sells" INTEGER,
    "deposits" DECIMAL(38,18),
    "withdrawals" DECIMAL(38,18),
    "views" INTEGER,
    "smartScore" DECIMAL(20,8),
    "tier" TEXT,
    "avgDailyReturn" DECIMAL(20,8),
    "bestDay" DECIMAL(20,8),
    "worstDay" DECIMAL(20,8),
    "winRate" DECIMAL(20,8),
    "profitFactor" DECIMAL(20,8),
    "rSquared" DECIMAL(20,8),
    "sharpeRatio" DECIMAL(20,8),
    "sortinoRatio" DECIMAL(20,8),
    "calmarRatio" DECIMAL(20,8),
    "maxDrawdown" DECIMAL(38,18),
    "maxDrawdownPercent" DECIMAL(20,8),
    "currentDrawdown" DECIMAL(20,8),
    "totalReturn" DECIMAL(38,18),
    "trendSlope" DECIMAL(38,18),
    "calculatedAt" TIMESTAMP(3),
    "rawPayload" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PredictingTopLeaderboardRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PredictingTopLeaderboardRow_period_rank_idx" ON "PredictingTopLeaderboardRow"("period", "rank");

-- CreateIndex
CREATE INDEX "PredictingTopLeaderboardRow_period_syncVersion_idx" ON "PredictingTopLeaderboardRow"("period", "syncVersion");

-- CreateIndex
CREATE INDEX "PredictingTopLeaderboardRow_wallet_idx" ON "PredictingTopLeaderboardRow"("wallet");
