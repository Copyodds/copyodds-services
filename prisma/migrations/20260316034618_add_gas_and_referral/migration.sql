/*
  Warnings:

  - A unique constraint covering the columns `[inviteCode]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `inviteCode` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "gasBalance" DECIMAL(38,18) NOT NULL DEFAULT 0,
ADD COLUMN     "inviteCode" TEXT NOT NULL,
ADD COLUMN     "referralPath" TEXT,
ADD COLUMN     "referrerId" INTEGER;

-- CreateTable
CREATE TABLE "GasOrder" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "amountPaid" DECIMAL(38,18) NOT NULL,
    "gasPurchasedGross" DECIMAL(38,18) NOT NULL,
    "gasNetToUser" DECIMAL(38,18) NOT NULL,
    "commissionTotal" DECIMAL(38,18) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasCommission" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "fromUserId" INTEGER NOT NULL,
    "toUserId" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "commissionAmount" DECIMAL(38,18) NOT NULL,
    "settlementStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasBalanceLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "change" DECIMAL(38,18) NOT NULL,
    "type" TEXT NOT NULL,
    "relatedOrderId" INTEGER,
    "relatedActionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasBalanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_inviteCode_key" ON "User"("inviteCode");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasOrder" ADD CONSTRAINT "GasOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasCommission" ADD CONSTRAINT "GasCommission_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "GasOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasCommission" ADD CONSTRAINT "GasCommission_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasCommission" ADD CONSTRAINT "GasCommission_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasBalanceLog" ADD CONSTRAINT "GasBalanceLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasBalanceLog" ADD CONSTRAINT "GasBalanceLog_relatedOrderId_fkey" FOREIGN KEY ("relatedOrderId") REFERENCES "GasOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
