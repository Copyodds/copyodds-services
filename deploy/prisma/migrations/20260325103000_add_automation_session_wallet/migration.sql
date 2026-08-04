-- Add automation session grant and action log tables

CREATE TABLE "AutomationSessionGrant" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "ownerWalletId" INTEGER NOT NULL,
  "automationWalletId" INTEGER NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'MANAGED_SESSION_V1',
  "authorizedByAddress" TEXT NOT NULL,
  "authorizationMessage" TEXT NOT NULL,
  "authorizationSignature" TEXT NOT NULL,
  "sessionAddress" TEXT NOT NULL,
  "allowBuy" BOOLEAN NOT NULL DEFAULT true,
  "allowSell" BOOLEAN NOT NULL DEFAULT true,
  "allowRedeem" BOOLEAN NOT NULL DEFAULT true,
  "maxOrderNotional" DECIMAL(38,18),
  "dailyNotionalCap" DECIMAL(38,18),
  "status" TEXT NOT NULL DEFAULT 'active',
  "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validUntil" TIMESTAMP(3) NOT NULL,
  "lastAuthorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AutomationSessionGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationActionLog" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "grantId" TEXT,
  "action" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "notionalUsd" DECIMAL(38,18),
  "txHash" TEXT,
  "referenceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AutomationActionLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutomationSessionGrant_automationWalletId_key" ON "AutomationSessionGrant"("automationWalletId");
CREATE INDEX "AutomationSessionGrant_userId_status_idx" ON "AutomationSessionGrant"("userId", "status");
CREATE INDEX "AutomationSessionGrant_automationWalletId_status_idx" ON "AutomationSessionGrant"("automationWalletId", "status");

CREATE INDEX "AutomationActionLog_userId_action_createdAt_idx" ON "AutomationActionLog"("userId", "action", "createdAt");
CREATE INDEX "AutomationActionLog_walletAddress_createdAt_idx" ON "AutomationActionLog"("walletAddress", "createdAt");

ALTER TABLE "AutomationSessionGrant"
ADD CONSTRAINT "AutomationSessionGrant_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutomationSessionGrant"
ADD CONSTRAINT "AutomationSessionGrant_ownerWalletId_fkey"
FOREIGN KEY ("ownerWalletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutomationSessionGrant"
ADD CONSTRAINT "AutomationSessionGrant_automationWalletId_fkey"
FOREIGN KEY ("automationWalletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutomationActionLog"
ADD CONSTRAINT "AutomationActionLog_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutomationActionLog"
ADD CONSTRAINT "AutomationActionLog_grantId_fkey"
FOREIGN KEY ("grantId") REFERENCES "AutomationSessionGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
