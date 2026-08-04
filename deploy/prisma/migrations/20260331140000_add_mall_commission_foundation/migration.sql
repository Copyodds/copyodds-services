-- AlterTable
ALTER TABLE "GasPackageOrder"
ADD COLUMN "commissionSettlementStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN "commissionSettledAt" TIMESTAMP(3),
ADD COLUMN "fulfilledAt" TIMESTAMP(3),
ADD COLUMN "paymentConfirmedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MallCommissionAccount" (
    "userId" INTEGER NOT NULL,
    "availableBalance" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "totalEarned" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "totalSettled" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "totalReversed" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MallCommissionAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "MallCommissionLedger" (
    "id" SERIAL NOT NULL,
    "accountUserId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "change" DECIMAL(38,18) NOT NULL,
    "balanceAfter" DECIMAL(38,18) NOT NULL,
    "entryType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "ruleVersion" TEXT,
    "relatedCommissionId" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MallCommissionLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MallOrderCommission" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "fromUserId" INTEGER NOT NULL,
    "toUserId" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "commissionAmount" DECIMAL(38,18) NOT NULL,
    "settlementStatus" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'MALL_ORDER',
    "sourceOrderId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL DEFAULT 'affiliate_v1',
    "tierAtTheTime" INTEGER,
    "rateAtTheTime" DECIMAL(10,6),
    "settledAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MallOrderCommission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MallCommissionLedger_accountUserId_createdAt_idx" ON "MallCommissionLedger"("accountUserId", "createdAt");

-- CreateIndex
CREATE INDEX "MallCommissionLedger_userId_createdAt_idx" ON "MallCommissionLedger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MallCommissionLedger_sourceType_sourceOrderId_idx" ON "MallCommissionLedger"("sourceType", "sourceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "MallOrderCommission_orderId_toUserId_level_key" ON "MallOrderCommission"("orderId", "toUserId", "level");

-- CreateIndex
CREATE INDEX "MallOrderCommission_fromUserId_createdAt_idx" ON "MallOrderCommission"("fromUserId", "createdAt");

-- CreateIndex
CREATE INDEX "MallOrderCommission_toUserId_createdAt_idx" ON "MallOrderCommission"("toUserId", "createdAt");

-- CreateIndex
CREATE INDEX "MallOrderCommission_sourceType_sourceOrderId_idx" ON "MallOrderCommission"("sourceType", "sourceOrderId");

-- CreateIndex
CREATE INDEX "MallOrderCommission_settlementStatus_createdAt_idx" ON "MallOrderCommission"("settlementStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "MallCommissionAccount" ADD CONSTRAINT "MallCommissionAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MallCommissionLedger" ADD CONSTRAINT "MallCommissionLedger_accountUserId_fkey" FOREIGN KEY ("accountUserId") REFERENCES "MallCommissionAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MallCommissionLedger" ADD CONSTRAINT "MallCommissionLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MallOrderCommission" ADD CONSTRAINT "MallOrderCommission_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "GasPackageOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MallOrderCommission" ADD CONSTRAINT "MallOrderCommission_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MallOrderCommission" ADD CONSTRAINT "MallOrderCommission_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
