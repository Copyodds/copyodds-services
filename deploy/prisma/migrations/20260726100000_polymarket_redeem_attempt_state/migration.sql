-- CreateTable
CREATE TABLE "PolymarketRedeemAttemptState" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcomeIndex" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastFailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolymarketRedeemAttemptState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PolymarketRedeemAttemptState_userId_failCount_idx" ON "PolymarketRedeemAttemptState"("userId", "failCount");

-- CreateIndex
CREATE UNIQUE INDEX "PolymarketRedeemAttemptState_userId_conditionId_outcomeIndex_key" ON "PolymarketRedeemAttemptState"("userId", "conditionId", "outcomeIndex");

-- AddForeignKey
ALTER TABLE "PolymarketRedeemAttemptState" ADD CONSTRAINT "PolymarketRedeemAttemptState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
