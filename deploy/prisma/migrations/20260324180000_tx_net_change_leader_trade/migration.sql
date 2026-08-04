-- AlterTable
ALTER TABLE "LeaderTrade"
ADD COLUMN "sourceFillCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "signalSource" TEXT NOT NULL DEFAULT 'order_filled';

-- CreateIndex
CREATE INDEX "LeaderTrade_leaderAddress_txHash_idx" ON "LeaderTrade"("leaderAddress", "txHash");
