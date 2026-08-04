-- AlterTable
ALTER TABLE "CopySubscription" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CopySubscription_userId_deletedAt_idx" ON "CopySubscription"("userId", "deletedAt");
