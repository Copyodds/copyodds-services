-- 榜单权威回撤列：与 L1 / 列表同源，不再只从 scoreExplain 多路猜测
ALTER TABLE "SmartMoneyLeaderboardRow"
  ADD COLUMN IF NOT EXISTS "maxDrawdownPercent" DECIMAL(20, 8);
