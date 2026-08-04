-- CreateEnum
CREATE TYPE "CustodyWithdrawStatus" AS ENUM ('PENDING', 'BROADCASTED', 'FAILED');

-- CreateTable
CREATE TABLE "CustodyWithdrawRequest" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "status" "CustodyWithdrawStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustodyWithdrawRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustodyWithdrawRequest_userId_createdAt_idx" ON "CustodyWithdrawRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CustodyWithdrawRequest_txHash_idx" ON "CustodyWithdrawRequest"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "CustodyWithdrawRequest_userId_idempotencyKey_key" ON "CustodyWithdrawRequest"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "CustodyWithdrawRequest" ADD CONSTRAINT "CustodyWithdrawRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

