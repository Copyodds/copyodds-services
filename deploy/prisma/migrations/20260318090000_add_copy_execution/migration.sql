-- CreateTable
CREATE TABLE "CopyExecution" (
    "id" TEXT NOT NULL,
    "followerUserId" INTEGER NOT NULL,
    "leaderAddress" TEXT NOT NULL,
    "tokenID" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "size" DECIMAL(38,18) NOT NULL,
    "ratioApplied" DECIMAL(10,6),
    "notional" DECIMAL(38,18),
    "status" TEXT NOT NULL,
    "polymarketOrderId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CopyExecution_followerUserId_createdAt_idx" ON "CopyExecution"("followerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CopyExecution_leaderAddress_createdAt_idx" ON "CopyExecution"("leaderAddress", "createdAt");

-- AddForeignKey
ALTER TABLE "CopyExecution" ADD CONSTRAINT "CopyExecution_followerUserId_fkey" FOREIGN KEY ("followerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

