-- CreateTable
CREATE TABLE "ShareToXGasClaim" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "wallet" TEXT,
    "gasAmount" DECIMAL(38,18) NOT NULL,
    "claimDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareToXGasClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShareToXGasClaim_userId_createdAt_idx" ON "ShareToXGasClaim"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShareToXGasClaim_userId_claimDate_key" ON "ShareToXGasClaim"("userId", "claimDate");

-- AddForeignKey
ALTER TABLE "ShareToXGasClaim" ADD CONSTRAINT "ShareToXGasClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
