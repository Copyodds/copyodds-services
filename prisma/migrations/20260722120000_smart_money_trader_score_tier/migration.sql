-- TraderScore / Edge / 分层展示列（P0–P2，加性迁移）
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "traderScore" DECIMAL(20, 8);
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "tier" TEXT;
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "edgeScore" DECIMAL(20, 8);
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "edgeSampleN" INTEGER;
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "traderType" TEXT;
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "activeDays" INTEGER;
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "maxWinTradeUsd" DECIMAL(38, 18);
ALTER TABLE "SmartMoneyLeaderboardRow" ADD COLUMN "maxLossTradeUsd" DECIMAL(38, 18);

CREATE INDEX "SmartMoneyLeaderboardRow_inCopyPool_traderScore_idx"
  ON "SmartMoneyLeaderboardRow"("inCopyPool", "traderScore" DESC);

CREATE INDEX "SmartMoneyLeaderboardRow_inCopyPool_tier_idx"
  ON "SmartMoneyLeaderboardRow"("inCopyPool", "tier");
