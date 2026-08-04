-- Closed Prefetch / Deep 解耦：Gate/Full closed-positions 快照
CREATE TABLE IF NOT EXISTS "SmartMoneyClosedSnapshot" (
    "id" SERIAL NOT NULL,
    "wallet" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 365,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rowsJson" JSONB,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "nextPage" INTEGER NOT NULL DEFAULT 0,
    "targetMaxPages" INTEGER NOT NULL DEFAULT 30,
    "capped" BOOLEAN NOT NULL DEFAULT false,
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "windowComplete" BOOLEAN NOT NULL DEFAULT false,
    "fetchOk" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmartMoneyClosedSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SmartMoneyClosedSnapshot_wallet_purpose_windowDays_key"
  ON "SmartMoneyClosedSnapshot"("wallet", "purpose", "windowDays");

CREATE INDEX IF NOT EXISTS "SmartMoneyClosedSnapshot_status_updatedAt_idx"
  ON "SmartMoneyClosedSnapshot"("status", "updatedAt");

CREATE INDEX IF NOT EXISTS "SmartMoneyClosedSnapshot_purpose_status_expiresAt_idx"
  ON "SmartMoneyClosedSnapshot"("purpose", "status", "expiresAt");

CREATE INDEX IF NOT EXISTS "SmartMoneyClosedSnapshot_wallet_purpose_status_idx"
  ON "SmartMoneyClosedSnapshot"("wallet", "purpose", "status");
