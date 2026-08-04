-- CreateTable
CREATE TABLE "LeaderboardRow" (
    "id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "timePeriod" TEXT NOT NULL,
    "orderBy" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "proxyWallet" TEXT NOT NULL,
    "userName" TEXT,
    "profileImage" TEXT,
    "xUsername" TEXT,
    "vol" DECIMAL(38,18) NOT NULL,
    "pnl" DECIMAL(38,18) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderboardRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaderboardRow_category_timePeriod_orderBy_idx" ON "LeaderboardRow"("category", "timePeriod", "orderBy");

-- CreateIndex
CREATE INDEX "LeaderboardRow_proxyWallet_idx" ON "LeaderboardRow"("proxyWallet");
