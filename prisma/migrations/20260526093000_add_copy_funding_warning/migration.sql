ALTER TABLE "CopySubscription" ADD COLUMN "fundingWarningAt" TIMESTAMP(3);
ALTER TABLE "CopySubscription" ADD COLUMN "fundingWarningCode" TEXT;
ALTER TABLE "CopySubscription" ADD COLUMN "fundingWarningReason" TEXT;

CREATE INDEX "CopySubscription_userId_fundingWarningCode_idx" ON "CopySubscription"("userId", "fundingWarningCode");
