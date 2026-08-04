-- CreateEnum
CREATE TYPE "CustodyEoaForwardStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'PENDING_GAS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "CustodyEoaForwardJob" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "CustodyEoaForwardStatus" NOT NULL DEFAULT 'PENDING',
    "triggerTxHash" TEXT,
    "triggerLogIndex" INTEGER,
    "idempotencyKey" TEXT NOT NULL,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustodyEoaForwardJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustodyEoaForwardJob_status_updatedAt_idx" ON "CustodyEoaForwardJob"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "CustodyEoaForwardJob_userId_createdAt_idx" ON "CustodyEoaForwardJob"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustodyEoaForwardJob_userId_idempotencyKey_key" ON "CustodyEoaForwardJob"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "CustodyEoaForwardJob" ADD CONSTRAINT "CustodyEoaForwardJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
