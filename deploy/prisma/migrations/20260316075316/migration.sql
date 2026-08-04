-- CreateTable
CREATE TABLE "GasPackage" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "usdPrice" DECIMAL(38,18) NOT NULL,
    "gasAmount" DECIMAL(38,18) NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "chainId" INTEGER,
    "currency" TEXT DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasPackageOrder" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "packageId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "txHash" TEXT,
    "paidUsd" DECIMAL(38,18) NOT NULL,
    "gasAmount" DECIMAL(38,18) NOT NULL,
    "gasOrderId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasPackageOrder_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "GasPackageOrder" ADD CONSTRAINT "GasPackageOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasPackageOrder" ADD CONSTRAINT "GasPackageOrder_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "GasPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
