-- AlterTable
ALTER TABLE "TradingConnection" ADD COLUMN "userId" INTEGER;

-- CreateIndex
CREATE INDEX "TradingConnection_userId_idx" ON "TradingConnection"("userId");

-- AddForeignKey
ALTER TABLE "TradingConnection" ADD CONSTRAINT "TradingConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
