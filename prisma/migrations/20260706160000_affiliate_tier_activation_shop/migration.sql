-- CreateTable
CREATE TABLE "AffiliateTierProduct" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "affiliateTier" INTEGER NOT NULL,
    "usdPrice" DECIMAL(38,18) NOT NULL,
    "originalUsdPrice" DECIMAL(38,18),
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateTierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateTierOrder" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "txHash" TEXT,
    "paymentConfirmedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "paidUsd" DECIMAL(38,18) NOT NULL,
    "affiliateTier" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateTierOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AffiliateTierProduct_isActive_sortOrder_idx" ON "AffiliateTierProduct"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "AffiliateTierProduct_affiliateTier_idx" ON "AffiliateTierProduct"("affiliateTier");

-- CreateIndex
CREATE INDEX "AffiliateTierOrder_userId_createdAt_idx" ON "AffiliateTierOrder"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateTierOrder_productId_idx" ON "AffiliateTierOrder"("productId");

-- CreateIndex
CREATE INDEX "AffiliateTierOrder_status_createdAt_idx" ON "AffiliateTierOrder"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "AffiliateTierOrder" ADD CONSTRAINT "AffiliateTierOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateTierOrder" ADD CONSTRAINT "AffiliateTierOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "AffiliateTierProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
