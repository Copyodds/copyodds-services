-- AlterTable
ALTER TABLE "GasBalanceLog"
ADD COLUMN "ruleVersion" TEXT,
ADD COLUMN "sourceOrderId" TEXT,
ADD COLUMN "sourceType" TEXT;

-- AlterTable
ALTER TABLE "GasCommission"
ADD COLUMN "ruleVersion" TEXT NOT NULL DEFAULT 'affiliate_v1',
ADD COLUMN "sourceOrderId" TEXT,
ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'GAS_RECHARGE';

-- AlterTable
ALTER TABLE "GasOrder"
ADD COLUMN "commissionRuleVersion" TEXT NOT NULL DEFAULT 'affiliate_v1',
ADD COLUMN "sourceOrderId" TEXT,
ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'GAS_RECHARGE';

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "referrerBindSource" TEXT,
ADD COLUMN "referrerBoundAt" TIMESTAMP(3),
ADD COLUMN "referrerLockedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReferralBindingAudit" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "referrerId" INTEGER,
    "targetEmail" TEXT,
    "inviteCodeRaw" TEXT,
    "inviteCodeNormalized" TEXT,
    "bindSource" TEXT NOT NULL,
    "bindStatus" TEXT NOT NULL,
    "failureReason" TEXT,
    "referralPathSnapshot" TEXT,
    "boundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralBindingAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralBindingAudit_userId_createdAt_idx" ON "ReferralBindingAudit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralBindingAudit_referrerId_createdAt_idx" ON "ReferralBindingAudit"("referrerId", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralBindingAudit_inviteCodeNormalized_idx" ON "ReferralBindingAudit"("inviteCodeNormalized");

-- CreateIndex
CREATE INDEX "ReferralBindingAudit_bindStatus_createdAt_idx" ON "ReferralBindingAudit"("bindStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "ReferralBindingAudit" ADD CONSTRAINT "ReferralBindingAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralBindingAudit" ADD CONSTRAINT "ReferralBindingAudit_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
