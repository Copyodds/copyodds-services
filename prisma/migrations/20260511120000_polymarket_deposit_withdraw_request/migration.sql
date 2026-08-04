-- CreateEnum
CREATE TYPE "PolymarketDepositWithdrawStatus" AS ENUM ('PENDING', 'RELAYER_SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "PolymarketDepositWithdrawRequest" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "depositAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "status" "PolymarketDepositWithdrawStatus" NOT NULL DEFAULT 'PENDING',
    "relayerTransactionId" TEXT,
    "chainTxHash" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolymarketDepositWithdrawRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PolymarketDepositWithdrawRequest_userId_idempotencyKey_key" ON "PolymarketDepositWithdrawRequest"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PolymarketDepositWithdrawRequest_userId_status_idx" ON "PolymarketDepositWithdrawRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "PolymarketDepositWithdrawRequest_userId_createdAt_idx" ON "PolymarketDepositWithdrawRequest"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PolymarketDepositWithdrawRequest" ADD CONSTRAINT "PolymarketDepositWithdrawRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
