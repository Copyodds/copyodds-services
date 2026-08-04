-- CreateEnum
CREATE TYPE "CopyMode" AS ENUM ('RATIO', 'FIXED_AMOUNT');

-- AlterTable
ALTER TABLE "CopySubscription"
ADD COLUMN "ruleName" TEXT,
ADD COLUMN "note" TEXT,
ADD COLUMN "copyMode" "CopyMode" NOT NULL DEFAULT 'RATIO',
ADD COLUMN "fixedAmountUsd" DECIMAL(38,18),
ADD COLUMN "minAmountUsd" DECIMAL(38,18),
ADD COLUMN "maxAmountPerMarketUsd" DECIMAL(38,18),
ADD COLUMN "dailyTotalCapUsd" DECIMAL(38,18),
ADD COLUMN "marketCooldownMinutes" INTEGER,
ADD COLUMN "pauseAfterConsecutiveFails" INTEGER;
