-- Phase 3: Admin Tier threshold snapshot (singleton)

CREATE TABLE IF NOT EXISTS "SmartMoneyTierConfig" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "config" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmartMoneyTierConfig_pkey" PRIMARY KEY ("id")
);
