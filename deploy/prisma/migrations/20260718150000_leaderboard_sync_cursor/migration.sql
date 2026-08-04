-- 官方榜滑动窗口游标：每个 preset 一行，记录下一轮拉取的 offset 与扫描轮次
CREATE TABLE "LeaderboardSyncCursor" (
    "id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "timePeriod" TEXT NOT NULL,
    "orderBy" TEXT NOT NULL,
    "nextOffset" INTEGER NOT NULL DEFAULT 0,
    "cycleId" INTEGER NOT NULL DEFAULT 1,
    "lastWindowAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderboardSyncCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeaderboardSyncCursor_category_timePeriod_orderBy_key"
    ON "LeaderboardSyncCursor"("category", "timePeriod", "orderBy");
