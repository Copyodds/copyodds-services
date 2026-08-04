CREATE TYPE "VirtualAccountStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED_CLOSING', 'SETTLED', 'ARCHIVED');
CREATE TYPE "VirtualExecutionStatus" AS ENUM ('QUEUED', 'SIMULATING', 'FILLED', 'PARTIALLY_FILLED', 'SKIPPED', 'FAILED', 'DEAD', 'SETTLED');

CREATE TABLE "VirtualCopyAccount" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "initialBalanceUsd" DECIMAL(38,18) NOT NULL,
  "cashBalanceUsd" DECIMAL(38,18) NOT NULL,
  "reservedBalanceUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "realizedPnlUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "status" "VirtualAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "expiredAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VirtualCopyAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VirtualCopySubscription" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "leaderId" TEXT NOT NULL,
  "ruleName" TEXT,
  "note" TEXT,
  "copyMode" "CopyMode" NOT NULL DEFAULT 'RATIO',
  "copyRatio" DECIMAL(10,6) NOT NULL DEFAULT 1,
  "fixedAmountUsd" DECIMAL(38,18),
  "minNotionalMode" TEXT NOT NULL DEFAULT 'BUMP_TO_MIN',
  "minAmountUsd" DECIMAL(38,18),
  "maxAmountUsd" DECIMAL(38,18),
  "maxAmountPerMarketUsd" DECIMAL(38,18),
  "dailyTotalCapUsd" DECIMAL(38,18),
  "maxSlippage" DECIMAL(10,6),
  "delayMs" INTEGER NOT NULL DEFAULT 0,
  "marketCooldownMinutes" INTEGER,
  "pauseAfterConsecutiveFails" INTEGER,
  "onlyBuy" BOOLEAN NOT NULL DEFAULT false,
  "onlySell" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pausedAt" TIMESTAMP(3),
  "expiredAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "failStreakCount" INTEGER NOT NULL DEFAULT 0,
  "failStreakUpdatedAt" TIMESTAMP(3),
  "pausedUntil" TIMESTAMP(3),
  "pauseReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VirtualCopySubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VirtualCopyExecution" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "accountId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "leaderTradeId" TEXT,
  "leaderId" TEXT NOT NULL,
  "leaderAddress" TEXT NOT NULL,
  "marketId" TEXT,
  "marketTitle" TEXT,
  "tokenId" TEXT NOT NULL,
  "outcome" TEXT,
  "side" "TradeSide" NOT NULL,
  "status" "VirtualExecutionStatus" NOT NULL DEFAULT 'QUEUED',
  "leaderPrice" DECIMAL(38,18) NOT NULL,
  "targetSize" DECIMAL(38,18) NOT NULL,
  "targetNotionalUsd" DECIMAL(38,18) NOT NULL,
  "maxSlippage" DECIMAL(10,6),
  "simulatedFillSize" DECIMAL(38,18),
  "simulatedAvgPrice" DECIMAL(38,18),
  "simulatedNotionalUsd" DECIMAL(38,18),
  "simulatedFeeUsd" DECIMAL(38,18),
  "slippageAmountUsd" DECIMAL(38,18),
  "slippageBps" INTEGER,
  "fillModel" TEXT NOT NULL,
  "priceSource" TEXT NOT NULL,
  "executionSource" TEXT NOT NULL DEFAULT 'LEADER_SIGNAL',
  "priceObservedAt" TIMESTAMP(3),
  "configSnapshot" JSONB NOT NULL,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "filledAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VirtualCopyExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VirtualPositionLot" (
  "id" TEXT NOT NULL, "userId" INTEGER NOT NULL, "accountId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL, "leaderId" TEXT NOT NULL, "leaderAddress" TEXT NOT NULL,
  "marketId" TEXT, "tokenId" TEXT NOT NULL, "buyExecutionId" TEXT NOT NULL,
  "entryPrice" DECIMAL(38,18) NOT NULL, "entrySize" DECIMAL(38,18) NOT NULL,
  "remainingSize" DECIMAL(38,18) NOT NULL, "entryNotionalUsd" DECIMAL(38,18) NOT NULL,
  "entryFeeUsd" DECIMAL(38,18) NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'OPEN',
  "openedAt" TIMESTAMP(3) NOT NULL, "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VirtualPositionLot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VirtualPositionLotClose" (
  "id" TEXT NOT NULL, "userId" INTEGER NOT NULL, "accountId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL, "lotId" TEXT NOT NULL, "buyExecutionId" TEXT NOT NULL,
  "sellExecutionId" TEXT NOT NULL, "tokenId" TEXT NOT NULL,
  "closedSize" DECIMAL(38,18) NOT NULL, "entryPrice" DECIMAL(38,18) NOT NULL,
  "exitPrice" DECIMAL(38,18) NOT NULL, "costBasisUsd" DECIMAL(38,18) NOT NULL,
  "proceedsUsd" DECIMAL(38,18) NOT NULL, "allocatedFeeUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "realizedPnlUsd" DECIMAL(38,18) NOT NULL, "closeReason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VirtualPositionLotClose_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VirtualAccountLedger" (
  "id" TEXT NOT NULL, "userId" INTEGER NOT NULL, "accountId" TEXT NOT NULL,
  "direction" TEXT NOT NULL, "category" TEXT NOT NULL, "amountUsd" DECIMAL(38,18) NOT NULL,
  "balanceAfterUsd" DECIMAL(38,18) NOT NULL, "refType" TEXT, "refId" TEXT,
  "idempotencyKey" TEXT NOT NULL, "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VirtualAccountLedger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VirtualAccountEquitySnapshot" (
  "id" BIGSERIAL NOT NULL, "accountId" TEXT NOT NULL,
  "cashBalanceUsd" DECIMAL(38,18) NOT NULL, "positionValueUsd" DECIMAL(38,18) NOT NULL,
  "equityUsd" DECIMAL(38,18) NOT NULL, "realizedPnlUsd" DECIMAL(38,18) NOT NULL,
  "unrealizedPnlUsd" DECIMAL(38,18) NOT NULL, "totalPnlUsd" DECIMAL(38,18) NOT NULL,
  "totalReturn" DECIMAL(20,8) NOT NULL, "drawdownUsd" DECIMAL(38,18) NOT NULL,
  "drawdownPercent" DECIMAL(20,8) NOT NULL, "priceAsOf" TIMESTAMP(3) NOT NULL,
  "snapshotAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VirtualAccountEquitySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VirtualCopyAccount_userId_name_key" ON "VirtualCopyAccount"("userId","name");
CREATE INDEX "VirtualCopyAccount_userId_status_createdAt_idx" ON "VirtualCopyAccount"("userId","status","createdAt");
CREATE INDEX "VirtualCopyAccount_status_expiresAt_idx" ON "VirtualCopyAccount"("status","expiresAt");
CREATE UNIQUE INDEX "VirtualCopySubscription_accountId_leaderId_key" ON "VirtualCopySubscription"("accountId","leaderId");
CREATE INDEX "VirtualCopySubscription_leaderId_enabled_idx" ON "VirtualCopySubscription"("leaderId","enabled");
CREATE INDEX "VirtualCopySubscription_userId_accountId_deletedAt_idx" ON "VirtualCopySubscription"("userId","accountId","deletedAt");
CREATE UNIQUE INDEX "VirtualCopyExecution_leaderTradeId_subscriptionId_key" ON "VirtualCopyExecution"("leaderTradeId","subscriptionId");
CREATE INDEX "VirtualCopyExecution_accountId_status_createdAt_idx" ON "VirtualCopyExecution"("accountId","status","createdAt");
CREATE INDEX "VirtualCopyExecution_accountId_tokenId_createdAt_idx" ON "VirtualCopyExecution"("accountId","tokenId","createdAt");
CREATE INDEX "VirtualCopyExecution_subscriptionId_status_updatedAt_idx" ON "VirtualCopyExecution"("subscriptionId","status","updatedAt");
CREATE INDEX "VirtualCopyExecution_status_scheduledAt_idx" ON "VirtualCopyExecution"("status","scheduledAt");
CREATE UNIQUE INDEX "VirtualPositionLot_buyExecutionId_key" ON "VirtualPositionLot"("buyExecutionId");
CREATE INDEX "VirtualPositionLot_accountId_tokenId_remainingSize_idx" ON "VirtualPositionLot"("accountId","tokenId","remainingSize");
CREATE INDEX "VirtualPositionLot_subscriptionId_tokenId_remainingSize_idx" ON "VirtualPositionLot"("subscriptionId","tokenId","remainingSize");
CREATE UNIQUE INDEX "VirtualPositionLotClose_sellExecutionId_lotId_key" ON "VirtualPositionLotClose"("sellExecutionId","lotId");
CREATE INDEX "VirtualPositionLotClose_accountId_createdAt_idx" ON "VirtualPositionLotClose"("accountId","createdAt");
CREATE INDEX "VirtualPositionLotClose_accountId_tokenId_idx" ON "VirtualPositionLotClose"("accountId","tokenId");
CREATE UNIQUE INDEX "VirtualAccountLedger_idempotencyKey_key" ON "VirtualAccountLedger"("idempotencyKey");
CREATE INDEX "VirtualAccountLedger_accountId_occurredAt_idx" ON "VirtualAccountLedger"("accountId","occurredAt");
CREATE INDEX "VirtualAccountLedger_accountId_category_occurredAt_idx" ON "VirtualAccountLedger"("accountId","category","occurredAt");
CREATE UNIQUE INDEX "VirtualAccountEquitySnapshot_accountId_snapshotAt_key" ON "VirtualAccountEquitySnapshot"("accountId","snapshotAt");
CREATE INDEX "VirtualAccountEquitySnapshot_accountId_snapshotAt_idx" ON "VirtualAccountEquitySnapshot"("accountId","snapshotAt");

ALTER TABLE "VirtualCopyAccount" ADD CONSTRAINT "VirtualCopyAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualCopySubscription" ADD CONSTRAINT "VirtualCopySubscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "VirtualCopyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualCopySubscription" ADD CONSTRAINT "VirtualCopySubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualCopySubscription" ADD CONSTRAINT "VirtualCopySubscription_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "CopyLeader"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualCopyExecution" ADD CONSTRAINT "VirtualCopyExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualCopyExecution" ADD CONSTRAINT "VirtualCopyExecution_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "VirtualCopyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualCopyExecution" ADD CONSTRAINT "VirtualCopyExecution_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "VirtualCopySubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualCopyExecution" ADD CONSTRAINT "VirtualCopyExecution_leaderTradeId_fkey" FOREIGN KEY ("leaderTradeId") REFERENCES "LeaderTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLot" ADD CONSTRAINT "VirtualPositionLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLot" ADD CONSTRAINT "VirtualPositionLot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "VirtualCopyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLot" ADD CONSTRAINT "VirtualPositionLot_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "VirtualCopySubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLot" ADD CONSTRAINT "VirtualPositionLot_buyExecutionId_fkey" FOREIGN KEY ("buyExecutionId") REFERENCES "VirtualCopyExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLotClose" ADD CONSTRAINT "VirtualPositionLotClose_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLotClose" ADD CONSTRAINT "VirtualPositionLotClose_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "VirtualCopyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLotClose" ADD CONSTRAINT "VirtualPositionLotClose_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "VirtualCopySubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLotClose" ADD CONSTRAINT "VirtualPositionLotClose_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "VirtualPositionLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLotClose" ADD CONSTRAINT "VirtualPositionLotClose_buyExecutionId_fkey" FOREIGN KEY ("buyExecutionId") REFERENCES "VirtualCopyExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualPositionLotClose" ADD CONSTRAINT "VirtualPositionLotClose_sellExecutionId_fkey" FOREIGN KEY ("sellExecutionId") REFERENCES "VirtualCopyExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualAccountLedger" ADD CONSTRAINT "VirtualAccountLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualAccountLedger" ADD CONSTRAINT "VirtualAccountLedger_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "VirtualCopyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VirtualAccountEquitySnapshot" ADD CONSTRAINT "VirtualAccountEquitySnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "VirtualCopyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
