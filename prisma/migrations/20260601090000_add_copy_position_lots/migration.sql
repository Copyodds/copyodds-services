CREATE TABLE "copy_position_lots" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "leaderId" TEXT,
  "leaderAddress" TEXT NOT NULL,
  "tokenID" TEXT NOT NULL,
  "buyCopyTradeRowId" TEXT NOT NULL,
  "entryPrice" DECIMAL(38,18) NOT NULL,
  "entrySize" DECIMAL(38,18) NOT NULL,
  "remainingSize" DECIMAL(38,18) NOT NULL,
  "entryNotional" DECIMAL(38,18) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "copy_position_lots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "copy_position_lots_buyCopyTradeRowId_key" ON "copy_position_lots"("buyCopyTradeRowId");
CREATE INDEX "copy_position_lots_userId_subscriptionId_tokenID_idx" ON "copy_position_lots"("userId", "subscriptionId", "tokenID");
CREATE INDEX "copy_position_lots_userId_tokenID_idx" ON "copy_position_lots"("userId", "tokenID");
CREATE INDEX "copy_position_lots_subscriptionId_tokenID_idx" ON "copy_position_lots"("subscriptionId", "tokenID");

CREATE TABLE "copy_position_lot_closes" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "sellCopyTradeRowId" TEXT NOT NULL,
  "buyCopyTradeRowId" TEXT NOT NULL,
  "lotId" TEXT NOT NULL,
  "tokenID" TEXT NOT NULL,
  "closedSize" DECIMAL(38,18) NOT NULL,
  "entryPrice" DECIMAL(38,18) NOT NULL,
  "exitPrice" DECIMAL(38,18) NOT NULL,
  "costBasisUsd" DECIMAL(38,18) NOT NULL,
  "proceedsUsd" DECIMAL(38,18) NOT NULL,
  "realizedPnlUsd" DECIMAL(38,18) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "copy_position_lot_closes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "copy_position_lot_closes_userId_tokenID_idx" ON "copy_position_lot_closes"("userId", "tokenID");
CREATE INDEX "copy_position_lot_closes_subscriptionId_tokenID_idx" ON "copy_position_lot_closes"("subscriptionId", "tokenID");
CREATE INDEX "copy_position_lot_closes_sellCopyTradeRowId_idx" ON "copy_position_lot_closes"("sellCopyTradeRowId");
CREATE INDEX "copy_position_lot_closes_buyCopyTradeRowId_idx" ON "copy_position_lot_closes"("buyCopyTradeRowId");
