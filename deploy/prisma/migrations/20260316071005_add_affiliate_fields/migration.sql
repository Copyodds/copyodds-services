-- AlterTable
ALTER TABLE "GasCommission" ADD COLUMN     "rateAtTheTime" DECIMAL(10,6),
ADD COLUMN     "tierAtTheTime" INTEGER;

-- AlterTable
ALTER TABLE "GasOrder" ADD COLUMN     "distributableUsdc" DECIMAL(38,18);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "affiliateNote" TEXT,
ADD COLUMN     "affiliateTier" INTEGER;
