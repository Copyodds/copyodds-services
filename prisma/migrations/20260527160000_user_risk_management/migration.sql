-- User risk / freeze management
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tradeStatus" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "frozenReason" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "frozenRemark" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "frozenAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "frozenUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "frozenByAdminId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "unfrozenAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "unfrozenByAdminId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "unfrozenRemark" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "riskReviewReason" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "riskUpdatedAt" TIMESTAMP(3);

UPDATE "User"
SET "tradeStatus" = 'FROZEN'
WHERE "tradingDisabled" = true AND "tradeStatus" = 'NORMAL';

CREATE TABLE IF NOT EXISTS "user_risk_logs" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "adminId" TEXT,
    "action" TEXT NOT NULL,
    "beforeStatus" TEXT,
    "afterStatus" TEXT,
    "reason" TEXT,
    "remark" TEXT,
    "frozenUntil" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_risk_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "user_risk_logs_userId_idx" ON "user_risk_logs"("userId");
CREATE INDEX IF NOT EXISTS "user_risk_logs_adminId_idx" ON "user_risk_logs"("adminId");
CREATE INDEX IF NOT EXISTS "user_risk_logs_action_idx" ON "user_risk_logs"("action");
CREATE INDEX IF NOT EXISTS "user_risk_logs_createdAt_idx" ON "user_risk_logs"("createdAt");

ALTER TABLE "user_risk_logs" DROP CONSTRAINT IF EXISTS "user_risk_logs_userId_fkey";
ALTER TABLE "user_risk_logs" ADD CONSTRAINT "user_risk_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
