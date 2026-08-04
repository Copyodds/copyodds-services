-- CreateTable
CREATE TABLE "UserWalletLedger" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rail" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "symbol" TEXT NOT NULL DEFAULT 'USDC.e',
    "category" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "idempotencyKey" TEXT,
    "balanceAfter" DECIMAL(38,18),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserWalletLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserWalletLedger_idempotencyKey_key" ON "UserWalletLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "UserWalletLedger_userId_occurredAt_idx" ON "UserWalletLedger"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "UserWalletLedger_userId_category_idx" ON "UserWalletLedger"("userId", "category");

-- AddForeignKey
ALTER TABLE "UserWalletLedger" ADD CONSTRAINT "UserWalletLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
