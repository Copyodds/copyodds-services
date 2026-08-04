ALTER TABLE "CopySubscription" ADD COLUMN "fundingPausedCode" TEXT;

CREATE INDEX "CopySubscription_userId_fundingPausedCode_idx" ON "CopySubscription"("userId", "fundingPausedCode");
