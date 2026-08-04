-- AlterTable: predicting.top 展示指标（与单周期行对齐，优先 ALL）
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "externalWinRate" DECIMAL(38,18);
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "externalSharpeRatio" DECIMAL(38,18);
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "externalTotalReturn" DECIMAL(38,18);
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "externalMetricsPeriod" TEXT;
