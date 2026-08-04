-- AlterTable
ALTER TABLE "copy_trades"
ADD COLUMN "intendedPrice" TEXT,
ADD COLUMN "intendedSize" TEXT,
ADD COLUMN "intendedNotional" TEXT,
ADD COLUMN "minNotionalAdjusted" BOOLEAN NOT NULL DEFAULT false;
