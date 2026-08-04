ALTER TABLE "ObservedTrader"
ADD COLUMN "candidateCategories" TEXT[] NOT NULL DEFAULT ARRAY['OVERALL']::TEXT[];

ALTER TABLE "SmartMoneyLeaderboardRow"
ADD COLUMN "candidateCategories" TEXT[] NOT NULL DEFAULT ARRAY['OVERALL']::TEXT[];
