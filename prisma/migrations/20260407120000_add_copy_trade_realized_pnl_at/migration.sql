-- AlterTable
ALTER TABLE "copy_trades" ADD COLUMN "realizedPnlAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "copy_trades_userId_realizedPnlAt_idx" ON "copy_trades"("userId", "realizedPnlAt");
