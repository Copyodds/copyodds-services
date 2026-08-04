-- CreateTable
CREATE TABLE "CustodyChainDeposit" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "walletId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustodyChainDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustodyDepositScanCursor" (
    "id" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustodyDepositScanCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustodyLedgerTopupIdempotency" (
    "idempotencyKey" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "amountUsd" DECIMAL(38,18) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustodyLedgerTopupIdempotency_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateIndex
CREATE INDEX "CustodyChainDeposit_userId_confirmedAt_idx" ON "CustodyChainDeposit"("userId", "confirmedAt");

-- CreateIndex
CREATE INDEX "CustodyChainDeposit_toAddress_confirmedAt_idx" ON "CustodyChainDeposit"("toAddress", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustodyChainDeposit_txHash_logIndex_key" ON "CustodyChainDeposit"("txHash", "logIndex");

-- AddForeignKey
ALTER TABLE "CustodyChainDeposit" ADD CONSTRAINT "CustodyChainDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyChainDeposit" ADD CONSTRAINT "CustodyChainDeposit_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
