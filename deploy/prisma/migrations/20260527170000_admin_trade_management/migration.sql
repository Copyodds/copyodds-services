-- Admin trade management: traders, leader metadata, subscription status/config, copy order admin fields, admin logs.
-- Handwritten migration to avoid local drift blocking prisma migrate dev.

-- 1) New enums
DO $$ BEGIN
  CREATE TYPE "TraderStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVIEW');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TraderSource" AS ENUM ('MANUAL', 'SYSTEM', 'IMPORT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeaderStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVIEW');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeaderSource" AS ENUM ('MANUAL', 'SYSTEM', 'IMPORT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeaderRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TradeAdminModule" AS ENUM ('TRADER', 'LEADER_ADDRESS', 'SUBSCRIPTION', 'COPY_ORDER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TradeAdminAction" AS ENUM ('CREATE', 'UPDATE', 'ENABLE', 'DISABLE', 'MARK_REVIEW', 'PAUSE', 'RESUME', 'CANCEL', 'RETRY', 'STATUS_CHANGE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CopyMode enum already exists; add SMART if missing (Postgres ENUM add is append-only).
DO $$ BEGIN
  ALTER TYPE "CopyMode" ADD VALUE IF NOT EXISTS 'SMART';
EXCEPTION WHEN undefined_object THEN
  -- If CopyMode is absent for some environments, skip.
  null;
END $$;

-- 2) New table: traders
CREATE TABLE IF NOT EXISTS "traders" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "label" TEXT,
  "avatarUrl" TEXT,
  "description" TEXT,
  "status" "TraderStatus" NOT NULL DEFAULT 'ACTIVE',
  "source" "TraderSource" NOT NULL DEFAULT 'MANUAL',
  "createdByAdminId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "traders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "traders_status_createdAt_idx" ON "traders"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "traders_source_createdAt_idx" ON "traders"("source", "createdAt");

-- 3) Extend CopyLeader
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "chain" TEXT NOT NULL DEFAULT 'POLYGON';
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "label" TEXT;
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "status" "LeaderStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "source" "LeaderSource" NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "riskLevel" "LeaderRiskLevel" NOT NULL DEFAULT 'LOW';
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "lastTradeAt" TIMESTAMP(3);
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "traderId" TEXT;
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "createdByAdminId" TEXT;

CREATE INDEX IF NOT EXISTS "CopyLeader_traderId_createdAt_idx" ON "CopyLeader"("traderId", "createdAt");
CREATE INDEX IF NOT EXISTS "CopyLeader_status_createdAt_idx" ON "CopyLeader"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "CopyLeader_source_createdAt_idx" ON "CopyLeader"("source", "createdAt");

DO $$ BEGIN
  ALTER TABLE "CopyLeader"
    ADD CONSTRAINT "CopyLeader_traderId_fkey"
    FOREIGN KEY ("traderId") REFERENCES "traders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 4) Extend CopySubscription
ALTER TABLE "CopySubscription" ADD COLUMN IF NOT EXISTS "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "CopySubscription" ADD COLUMN IF NOT EXISTS "maxGas" DECIMAL(38, 18);
ALTER TABLE "CopySubscription" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "CopySubscription" ADD COLUMN IF NOT EXISTS "expiredAt" TIMESTAMP(3);
ALTER TABLE "CopySubscription" ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3);
ALTER TABLE "CopySubscription" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);

-- 5) Extend copy_trades (CopyTradeRow)
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "leaderOrderHash" TEXT;
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "chain" TEXT NOT NULL DEFAULT 'POLYGON';
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "marketId" TEXT;
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "marketTitle" TEXT;
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "side" "TradeSide";
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "tokenId" TEXT;
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "orderAmount" TEXT;
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "filledAmount" TEXT;
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "avgPrice" TEXT;
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "gasUsed" TEXT;
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3);
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "filledAt" TIMESTAMP(3);
ALTER TABLE "copy_trades" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);

-- Optional query performance indexes for admin filters
CREATE INDEX IF NOT EXISTS "copy_trades_marketId_createdAt_idx" ON "copy_trades"("marketId", "createdAt");
CREATE INDEX IF NOT EXISTS "copy_trades_leaderOrderHash_createdAt_idx" ON "copy_trades"("leaderOrderHash", "createdAt");
CREATE INDEX IF NOT EXISTS "copy_trades_txHash_createdAt_idx" ON "copy_trades"("txHash", "createdAt");

-- 6) New table: trade_admin_logs
CREATE TABLE IF NOT EXISTS "trade_admin_logs" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "module" "TradeAdminModule" NOT NULL,
  "targetId" TEXT NOT NULL,
  "action" "TradeAdminAction" NOT NULL,
  "beforeData" JSONB,
  "afterData" JSONB,
  "remark" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trade_admin_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "trade_admin_logs_adminId_createdAt_idx" ON "trade_admin_logs"("adminId", "createdAt");
CREATE INDEX IF NOT EXISTS "trade_admin_logs_module_createdAt_idx" ON "trade_admin_logs"("module", "createdAt");
CREATE INDEX IF NOT EXISTS "trade_admin_logs_targetId_createdAt_idx" ON "trade_admin_logs"("targetId", "createdAt");

