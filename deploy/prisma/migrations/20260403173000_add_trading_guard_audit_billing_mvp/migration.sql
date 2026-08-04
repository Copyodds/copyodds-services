-- CreateEnum
CREATE TYPE "TradingSystemMode" AS ENUM ('NORMAL', 'TRACK_ONLY', 'PAUSED');

-- CreateEnum
CREATE TYPE "LeaderRiskStatus" AS ENUM ('ACTIVE', 'WATCHLIST', 'DISABLED');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "tradingDisabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "tradingDisabledReason" TEXT,
ADD COLUMN "tradingDisabledUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SystemControl" (
    "key" TEXT NOT NULL,
    "mode" "TradingSystemMode" NOT NULL DEFAULT 'NORMAL',
    "reason" TEXT,
    "metadata" JSONB,
    "restoreAt" TIMESTAMP(3),
    "updatedByAdminUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemControl_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "LeaderRiskState" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "status" "LeaderRiskStatus" NOT NULL DEFAULT 'ACTIVE',
    "reasonCode" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "expiresAt" TIMESTAMP(3),
    "updatedByAdminUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderRiskState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "userId" INTEGER,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "result" TEXT NOT NULL,
    "reasonCode" TEXT,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskEvent" (
    "id" TEXT NOT NULL,
    "userId" INTEGER,
    "leaderId" TEXT,
    "subscriptionId" TEXT,
    "leaderTradeId" TEXT,
    "copyTradeRowId" TEXT,
    "source" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reasonCode" TEXT,
    "marketId" TEXT,
    "tokenId" TEXT,
    "side" TEXT,
    "notionalUsd" DECIMAL(38,18),
    "thresholdSnapshot" JSONB,
    "inputSnapshot" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingLedger" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "entryType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceOrderId" TEXT,
    "amount" DECIMAL(38,18) NOT NULL,
    "balanceAfter" DECIMAL(38,18),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "ruleVersion" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemControl_mode_updatedAt_idx" ON "SystemControl"("mode", "updatedAt");

-- CreateIndex
CREATE INDEX "SystemControl_restoreAt_idx" ON "SystemControl"("restoreAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderRiskState_leaderId_key" ON "LeaderRiskState"("leaderId");

-- CreateIndex
CREATE INDEX "LeaderRiskState_status_updatedAt_idx" ON "LeaderRiskState"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "LeaderRiskState_expiresAt_idx" ON "LeaderRiskState"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditEvent_userId_createdAt_idx" ON "AuditEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_targetType_targetId_idx" ON "AuditEvent"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditEvent_reasonCode_createdAt_idx" ON "AuditEvent"("reasonCode", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_result_createdAt_idx" ON "AuditEvent"("result", "createdAt");

-- CreateIndex
CREATE INDEX "RiskEvent_userId_createdAt_idx" ON "RiskEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskEvent_leaderId_createdAt_idx" ON "RiskEvent"("leaderId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskEvent_subscriptionId_createdAt_idx" ON "RiskEvent"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskEvent_copyTradeRowId_idx" ON "RiskEvent"("copyTradeRowId");

-- CreateIndex
CREATE INDEX "RiskEvent_reasonCode_createdAt_idx" ON "RiskEvent"("reasonCode", "createdAt");

-- CreateIndex
CREATE INDEX "RiskEvent_source_createdAt_idx" ON "RiskEvent"("source", "createdAt");

-- CreateIndex
CREATE INDEX "BillingLedger_userId_createdAt_idx" ON "BillingLedger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingLedger_sourceType_sourceOrderId_idx" ON "BillingLedger"("sourceType", "sourceOrderId");

-- CreateIndex
CREATE INDEX "BillingLedger_entryType_createdAt_idx" ON "BillingLedger"("entryType", "createdAt");

-- AddForeignKey
ALTER TABLE "SystemControl" ADD CONSTRAINT "SystemControl_updatedByAdminUserId_fkey" FOREIGN KEY ("updatedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderRiskState" ADD CONSTRAINT "LeaderRiskState_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "CopyLeader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderRiskState" ADD CONSTRAINT "LeaderRiskState_updatedByAdminUserId_fkey" FOREIGN KEY ("updatedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "CopyLeader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "CopySubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_leaderTradeId_fkey" FOREIGN KEY ("leaderTradeId") REFERENCES "LeaderTrade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_copyTradeRowId_fkey" FOREIGN KEY ("copyTradeRowId") REFERENCES "copy_trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLedger" ADD CONSTRAINT "BillingLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
