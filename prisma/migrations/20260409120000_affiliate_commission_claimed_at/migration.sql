-- AlterTable
ALTER TABLE "GasCommission" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MallOrderCommission" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- 存量视为已领取，避免上线后重复入账
UPDATE "GasCommission" SET "claimedAt" = "createdAt" WHERE "claimedAt" IS NULL;
UPDATE "MallOrderCommission" SET "claimedAt" = COALESCE("settledAt", "createdAt") WHERE "claimedAt" IS NULL;

-- CreateIndex
CREATE INDEX "GasCommission_toUserId_claimedAt_idx" ON "GasCommission"("toUserId", "claimedAt");

-- CreateIndex
CREATE INDEX "MallOrderCommission_toUserId_claimedAt_idx" ON "MallOrderCommission"("toUserId", "claimedAt");
