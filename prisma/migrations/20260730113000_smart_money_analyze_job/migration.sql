CREATE TABLE "SmartMoneyAnalyzeJob" (
  "id" TEXT NOT NULL,
  "wallet" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "period" TEXT NOT NULL DEFAULT 'ALL',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "action" TEXT NOT NULL DEFAULT 'DEEP',
  "error" TEXT,
  "activeKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SmartMoneyAnalyzeJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SmartMoneyAnalyzeJob_activeKey_key"
  ON "SmartMoneyAnalyzeJob"("activeKey");

CREATE INDEX "SmartMoneyAnalyzeJob_status_createdAt_idx"
  ON "SmartMoneyAnalyzeJob"("status", "createdAt");

CREATE INDEX "SmartMoneyAnalyzeJob_userId_createdAt_idx"
  ON "SmartMoneyAnalyzeJob"("userId", "createdAt");

CREATE INDEX "SmartMoneyAnalyzeJob_wallet_createdAt_idx"
  ON "SmartMoneyAnalyzeJob"("wallet", "createdAt" DESC);
