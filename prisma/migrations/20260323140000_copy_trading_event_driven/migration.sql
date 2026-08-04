-- CreateEnum
CREATE TYPE "CopyTradeStatus" AS ENUM ('queued', 'risk_pending', 'skipped', 'submitting', 'submitted', 'filled', 'failed', 'dead');

-- CreateTable
CREATE TABLE "CopyLeader" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyLeader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopySubscription" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "leaderId" TEXT NOT NULL,
    "copyRatio" DECIMAL(10,6) NOT NULL DEFAULT 1,
    "maxAmount" DECIMAL(38,18),
    "slippage" DECIMAL(10,6),
    "delayMs" INTEGER NOT NULL DEFAULT 0,
    "onlyBuy" BOOLEAN NOT NULL DEFAULT false,
    "onlySell" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopySubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderTrade" (
    "id" TEXT NOT NULL,
    "leaderAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "side" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "marketId" TEXT,
    "tokenId" TEXT NOT NULL,
    "maker" TEXT NOT NULL,
    "taker" TEXT NOT NULL,
    "makerAssetId" TEXT NOT NULL DEFAULT '',
    "takerAssetId" TEXT NOT NULL DEFAULT '',
    "blockNumber" INTEGER,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaderId" TEXT,

    CONSTRAINT "LeaderTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copy_trades" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "leaderTradeId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "txHash" TEXT,
    "status" "CopyTradeStatus" NOT NULL DEFAULT 'queued',
    "errorMsg" TEXT,
    "errorCode" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "polymarketOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "copy_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CopyLeader_address_key" ON "CopyLeader"("address");

-- CreateIndex
CREATE UNIQUE INDEX "CopySubscription_userId_leaderId_key" ON "CopySubscription"("userId", "leaderId");

-- CreateIndex
CREATE INDEX "CopySubscription_leaderId_idx" ON "CopySubscription"("leaderId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderTrade_txHash_logIndex_key" ON "LeaderTrade"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "LeaderTrade_leaderAddress_idx" ON "LeaderTrade"("leaderAddress");

-- CreateIndex
CREATE INDEX "LeaderTrade_createdAt_idx" ON "LeaderTrade"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "copy_trades_leaderTradeId_subscriptionId_key" ON "copy_trades"("leaderTradeId", "subscriptionId");

-- CreateIndex
CREATE INDEX "copy_trades_userId_status_idx" ON "copy_trades"("userId", "status");

-- AddForeignKey
ALTER TABLE "CopySubscription" ADD CONSTRAINT "CopySubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopySubscription" ADD CONSTRAINT "CopySubscription_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "CopyLeader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderTrade" ADD CONSTRAINT "LeaderTrade_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "CopyLeader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_trades" ADD CONSTRAINT "copy_trades_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_trades" ADD CONSTRAINT "copy_trades_leaderTradeId_fkey" FOREIGN KEY ("leaderTradeId") REFERENCES "LeaderTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_trades" ADD CONSTRAINT "copy_trades_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "CopySubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
