CREATE TABLE "PolymarketAnalyticsLeaderboardRow" (
    "id" SERIAL NOT NULL,
    "period" TEXT NOT NULL,
    "syncVersion" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL,
    "wallet" TEXT NOT NULL,
    "hScore" DECIMAL(20,8),
    "roi" DECIMAL(20,8),
    "winRate" DECIMAL(20,8),
    "sharpeRatio" DECIMAL(20,8),
    "totalPnl" DECIMAL(38,18),
    "totalVolume" DECIMAL(38,18),
    "totalTrades" INTEGER,
    "marketsTraded" INTEGER,
    "tier" TEXT,
    "rawPayload" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolymarketAnalyticsLeaderboardRow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PolymarketAnalyticsLeaderboardRow_period_rank_idx" ON "PolymarketAnalyticsLeaderboardRow"("period", "rank");

CREATE INDEX "PolymarketAnalyticsLeaderboardRow_period_syncVersion_idx" ON "PolymarketAnalyticsLeaderboardRow"("period", "syncVersion");

CREATE INDEX "PolymarketAnalyticsLeaderboardRow_wallet_idx" ON "PolymarketAnalyticsLeaderboardRow"("wallet");
