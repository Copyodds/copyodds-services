-- Production-grade pricing, fee, close-quote and ownership evidence.

ALTER TABLE "VirtualCopyExecution"
  ADD COLUMN "feeRate" DECIMAL(10,8),
  ADD COLUMN "feeModelVersion" TEXT,
  ADD COLUMN "limitPrice" DECIMAL(38,18),
  ADD COLUMN "unfilledSize" DECIMAL(38,18),
  ADD COLUMN "priceStalenessMs" INTEGER,
  ADD COLUMN "orderBookEvidence" JSONB,
  ADD COLUMN "settlementEvidence" JSONB,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "claimExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "VirtualCopyExecution_idempotencyKey_key"
  ON "VirtualCopyExecution"("idempotencyKey");
CREATE INDEX "VirtualCopyExecution_status_claimExpiresAt_idx"
  ON "VirtualCopyExecution"("status","claimExpiresAt");

ALTER TABLE "VirtualPositionLotClose"
  ADD COLUMN "allocatedEntryFeeUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
  ADD COLUMN "exitFeeUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
  ADD COLUMN "settlementEvidence" JSONB;

ALTER TABLE "VirtualAccountEquitySnapshot"
  ADD COLUMN "priceStatus" TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN "priceSource" TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN "unavailableMarkCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "VirtualPositionCloseQuote" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "accountId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "requestedSize" DECIMAL(38,18) NOT NULL,
  "estimatedFillSize" DECIMAL(38,18) NOT NULL,
  "estimatedAvgPrice" DECIMAL(38,18) NOT NULL,
  "estimatedGrossUsd" DECIMAL(38,18) NOT NULL,
  "estimatedFeeUsd" DECIMAL(38,18) NOT NULL,
  "estimatedProceedsUsd" DECIMAL(38,18) NOT NULL,
  "estimatedRealizedPnlUsd" DECIMAL(38,18) NOT NULL,
  "slippageBps" INTEGER NOT NULL,
  "priceSource" TEXT NOT NULL,
  "priceObservedAt" TIMESTAMP(3) NOT NULL,
  "feeModelVersion" TEXT NOT NULL,
  "feeRate" DECIMAL(10,8) NOT NULL,
  "orderBookEvidence" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VirtualPositionCloseQuote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VirtualPositionCloseQuote_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VirtualPositionCloseQuote_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "VirtualCopyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "VirtualPositionCloseQuote_idempotencyKey_key"
  ON "VirtualPositionCloseQuote"("idempotencyKey");
CREATE INDEX "VirtualPositionCloseQuote_accountId_tokenId_status_expiresAt_idx"
  ON "VirtualPositionCloseQuote"("accountId","tokenId","status","expiresAt");
CREATE INDEX "VirtualPositionCloseQuote_userId_createdAt_idx"
  ON "VirtualPositionCloseQuote"("userId","createdAt");

CREATE TABLE "VirtualCopyRateLimitEvent" (
  "id" BIGSERIAL NOT NULL,
  "key" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VirtualCopyRateLimitEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VirtualCopyRateLimitEvent_key_occurredAt_idx"
  ON "VirtualCopyRateLimitEvent"("key","occurredAt");
CREATE INDEX "VirtualCopyRateLimitEvent_occurredAt_idx"
  ON "VirtualCopyRateLimitEvent"("occurredAt");

-- Product names are case-insensitively unique per user.
CREATE UNIQUE INDEX "VirtualCopyAccount_userId_name_ci_key"
  ON "VirtualCopyAccount"("userId", lower("name"));

-- Redundant scalar ownership columns are protected at the database boundary.
CREATE UNIQUE INDEX "VirtualCopyAccount_id_userId_key"
  ON "VirtualCopyAccount"("id","userId");
CREATE UNIQUE INDEX "VirtualCopySubscription_id_accountId_userId_key"
  ON "VirtualCopySubscription"("id","accountId","userId");

ALTER TABLE "VirtualCopySubscription"
  ADD CONSTRAINT "VirtualCopySubscription_account_user_consistency_fkey"
  FOREIGN KEY ("accountId","userId")
  REFERENCES "VirtualCopyAccount"("id","userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualCopyExecution"
  ADD CONSTRAINT "VirtualCopyExecution_subscription_owner_consistency_fkey"
  FOREIGN KEY ("subscriptionId","accountId","userId")
  REFERENCES "VirtualCopySubscription"("id","accountId","userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualPositionLot"
  ADD CONSTRAINT "VirtualPositionLot_subscription_owner_consistency_fkey"
  FOREIGN KEY ("subscriptionId","accountId","userId")
  REFERENCES "VirtualCopySubscription"("id","accountId","userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualPositionLotClose"
  ADD CONSTRAINT "VirtualPositionLotClose_subscription_owner_consistency_fkey"
  FOREIGN KEY ("subscriptionId","accountId","userId")
  REFERENCES "VirtualCopySubscription"("id","accountId","userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualPositionCloseQuote"
  ADD CONSTRAINT "VirtualPositionCloseQuote_account_user_consistency_fkey"
  FOREIGN KEY ("accountId","userId")
  REFERENCES "VirtualCopyAccount"("id","userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualCopyAccount"
  ADD CONSTRAINT "VirtualCopyAccount_balances_nonnegative_ck"
    CHECK ("initialBalanceUsd" > 0 AND "cashBalanceUsd" >= 0 AND "reservedBalanceUsd" >= 0),
  ADD CONSTRAINT "VirtualCopyAccount_expiry_order_ck"
    CHECK ("expiresAt" > "startedAt");

ALTER TABLE "VirtualCopySubscription"
  ADD CONSTRAINT "VirtualCopySubscription_amounts_valid_ck" CHECK (
    "copyRatio" >= 0
    AND ("fixedAmountUsd" IS NULL OR "fixedAmountUsd" > 0)
    AND ("minAmountUsd" IS NULL OR "minAmountUsd" > 0)
    AND ("maxAmountUsd" IS NULL OR "maxAmountUsd" > 0)
    AND ("minAmountUsd" IS NULL OR "maxAmountUsd" IS NULL OR "minAmountUsd" <= "maxAmountUsd")
    AND ("maxSlippage" IS NULL OR ("maxSlippage" >= 0 AND "maxSlippage" <= 0.5))
  );

ALTER TABLE "VirtualCopyExecution"
  ADD CONSTRAINT "VirtualCopyExecution_amounts_nonnegative_ck" CHECK (
    "leaderPrice" >= 0 AND "leaderPrice" <= 1
    AND "targetSize" > 0 AND "targetNotionalUsd" > 0
    AND ("simulatedFillSize" IS NULL OR "simulatedFillSize" >= 0)
    AND ("simulatedAvgPrice" IS NULL OR ("simulatedAvgPrice" >= 0 AND "simulatedAvgPrice" <= 1))
    AND ("simulatedNotionalUsd" IS NULL OR "simulatedNotionalUsd" >= 0)
    AND ("simulatedFeeUsd" IS NULL OR "simulatedFeeUsd" >= 0)
    AND ("unfilledSize" IS NULL OR "unfilledSize" >= 0)
  );

ALTER TABLE "VirtualPositionLot"
  ADD CONSTRAINT "VirtualPositionLot_sizes_valid_ck" CHECK (
    "entryPrice" >= 0 AND "entryPrice" <= 1
    AND "entrySize" > 0
    AND "remainingSize" >= 0
    AND "remainingSize" <= "entrySize"
    AND "entryNotionalUsd" >= 0
    AND "entryFeeUsd" >= 0
  );

ALTER TABLE "VirtualPositionLotClose"
  ADD CONSTRAINT "VirtualPositionLotClose_amounts_valid_ck" CHECK (
    "closedSize" > 0
    AND "entryPrice" >= 0 AND "entryPrice" <= 1
    AND "exitPrice" >= 0 AND "exitPrice" <= 1
    AND "costBasisUsd" >= 0
    AND "proceedsUsd" >= 0
    AND "allocatedEntryFeeUsd" >= 0
    AND "exitFeeUsd" >= 0
    AND "allocatedFeeUsd" >= 0
  );

ALTER TABLE "VirtualPositionCloseQuote"
  ADD CONSTRAINT "VirtualPositionCloseQuote_amounts_valid_ck" CHECK (
    "requestedSize" > 0
    AND "estimatedFillSize" > 0
    AND "estimatedFillSize" <= "requestedSize"
    AND "estimatedAvgPrice" >= 0 AND "estimatedAvgPrice" <= 1
    AND "estimatedGrossUsd" >= 0
    AND "estimatedFeeUsd" >= 0
    AND "estimatedProceedsUsd" >= 0
    AND "feeRate" >= 0 AND "feeRate" <= 1
  );
