-- CreateTable
CREATE TABLE "TradingConnection" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingConnection_pkey" PRIMARY KEY ("id")
);
