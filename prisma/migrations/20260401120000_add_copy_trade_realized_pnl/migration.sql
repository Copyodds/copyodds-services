-- AlterTable
ALTER TABLE "copy_trades" ADD COLUMN "realizedPnlUsd" DECIMAL(38,18);

-- CreateIndex
CREATE INDEX "copy_trades_status_createdAt_idx" ON "copy_trades"("status", "createdAt");
