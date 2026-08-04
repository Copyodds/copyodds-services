-- CopySubscription: fail streak + funding pause (Postgres)
ALTER TABLE "CopySubscription" ADD COLUMN "failStreakCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CopySubscription" ADD COLUMN "failStreakUpdatedAt" TIMESTAMP(3);
ALTER TABLE "CopySubscription" ADD COLUMN "pausedUntil" TIMESTAMP(3);
ALTER TABLE "CopySubscription" ADD COLUMN "pauseReason" TEXT;
ALTER TABLE "CopySubscription" ADD COLUMN "fundingPausedAt" TIMESTAMP(3);
ALTER TABLE "CopySubscription" ADD COLUMN "fundingPausedReason" TEXT;

CREATE INDEX "CopySubscription_userId_fundingPausedAt_idx" ON "CopySubscription"("userId", "fundingPausedAt");

-- copy_trades: daily notional aggregation indexes
CREATE INDEX "copy_trades_userId_status_createdAt_idx" ON "copy_trades"("userId", "status", "createdAt");
CREATE INDEX "copy_trades_userId_subscriptionId_status_createdAt_idx" ON "copy_trades"("userId", "subscriptionId", "status", "createdAt");

-- Market cooldown
CREATE TABLE "copy_market_cooldowns" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "cooldownUntil" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "copy_market_cooldowns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "copy_market_cooldowns_userId_subscriptionId_marketId_key" ON "copy_market_cooldowns"("userId", "subscriptionId", "marketId");
CREATE INDEX "copy_market_cooldowns_cooldownUntil_idx" ON "copy_market_cooldowns"("cooldownUntil");

ALTER TABLE "copy_market_cooldowns" ADD CONSTRAINT "copy_market_cooldowns_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "CopySubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Email verification codes
CREATE TYPE "EmailVerificationCodeType" AS ENUM ('REGISTER', 'LOGIN');

CREATE TABLE "email_verification_codes" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "type" "EmailVerificationCodeType" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "requestIp" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_verification_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_verification_codes_email_type_createdAt_idx" ON "email_verification_codes"("email", "type", "createdAt");
CREATE INDEX "email_verification_codes_expiresAt_idx" ON "email_verification_codes"("expiresAt");
CREATE INDEX "email_verification_codes_email_type_consumedAt_idx" ON "email_verification_codes"("email", "type", "consumedAt");
CREATE INDEX "email_verification_codes_requestIp_createdAt_idx" ON "email_verification_codes"("requestIp", "createdAt");

-- Drop transitional app_cache KV (was Postgres-backed Redis shim)
DROP TABLE IF EXISTS "app_cache";
