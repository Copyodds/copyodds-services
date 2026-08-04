ALTER TABLE "copy_trades"
  ADD COLUMN "executionMode" TEXT NOT NULL DEFAULT 'REAL',
  ADD COLUMN "isVirtual" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "User"
  ADD COLUMN "copyTradingVirtualEnabled" BOOLEAN NOT NULL DEFAULT false;
