-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "apiKey" TEXT NOT NULL,
    "apiSecret" TEXT NOT NULL,
    "passphrase" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyRelation" (
    "id" TEXT NOT NULL,
    "leaderAddress" TEXT NOT NULL,
    "followerUserId" INTEGER NOT NULL,
    "followerAddress" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedTrade" (
    "id" TEXT NOT NULL,
    "polymarketTradeId" TEXT NOT NULL,
    "leaderAddress" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "size" DECIMAL(38,18) NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_userId_key" ON "ApiCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CopyRelation_leaderAddress_followerUserId_key" ON "CopyRelation"("leaderAddress", "followerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedTrade_polymarketTradeId_key" ON "ProcessedTrade"("polymarketTradeId");

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
