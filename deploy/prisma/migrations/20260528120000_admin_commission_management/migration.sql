-- Unified commission management tables for admin UI

CREATE TABLE IF NOT EXISTS "CommissionRule" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "levelOneRate" DECIMAL(10, 6) NOT NULL DEFAULT 0.10,
    "levelTwoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "levelTwoRate" DECIMAL(10, 6) NOT NULL DEFAULT 0.03,
    "packageCommissionRate" DECIMAL(10, 6) NOT NULL DEFAULT 0.10,
    "gasCommissionRate" DECIMAL(10, 6) NOT NULL DEFAULT 0.05,
    "minSettlementAmount" DECIMAL(38, 18) NOT NULL DEFAULT 10,
    "settlementCycle" TEXT NOT NULL DEFAULT 'DAILY',
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

INSERT INTO "CommissionRule" ("id")
VALUES ('default')
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "CommissionRecord" (
    "id" TEXT NOT NULL,
    "referrerUserId" INTEGER NOT NULL,
    "invitedUserId" INTEGER NOT NULL,
    "inviteCode" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "sourceOrderAmount" DECIMAL(38, 18) NOT NULL DEFAULT 0,
    "commissionRate" DECIMAL(10, 6),
    "commissionAmount" DECIMAL(38, 18) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "level" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "settledAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "remark" TEXT,
    "legacyKind" TEXT,
    "legacyId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommissionRecord_source_level_key"
    ON "CommissionRecord" ("sourceType", "sourceOrderId", "referrerUserId", "level");
CREATE INDEX IF NOT EXISTS "CommissionRecord_referrerUserId_idx" ON "CommissionRecord" ("referrerUserId");
CREATE INDEX IF NOT EXISTS "CommissionRecord_invitedUserId_idx" ON "CommissionRecord" ("invitedUserId");
CREATE INDEX IF NOT EXISTS "CommissionRecord_sourceOrderId_idx" ON "CommissionRecord" ("sourceOrderId");
CREATE INDEX IF NOT EXISTS "CommissionRecord_sourceType_idx" ON "CommissionRecord" ("sourceType");
CREATE INDEX IF NOT EXISTS "CommissionRecord_status_idx" ON "CommissionRecord" ("status");
CREATE INDEX IF NOT EXISTS "CommissionRecord_createdAt_idx" ON "CommissionRecord" ("createdAt");
CREATE INDEX IF NOT EXISTS "CommissionRecord_inviteCode_idx" ON "CommissionRecord" ("inviteCode");

CREATE TABLE IF NOT EXISTS "CommissionRiskAlert" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "relatedRecordId" TEXT,
    "relatedOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "CommissionRiskAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CommissionRiskAlert_status_idx" ON "CommissionRiskAlert" ("status");
CREATE INDEX IF NOT EXISTS "CommissionRiskAlert_createdAt_idx" ON "CommissionRiskAlert" ("createdAt");

CREATE TABLE IF NOT EXISTS "CommissionAdminLog" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeData" JSONB,
    "afterData" JSONB,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionAdminLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CommissionAdminLog_recordId_idx" ON "CommissionAdminLog" ("recordId");
CREATE INDEX IF NOT EXISTS "CommissionAdminLog_createdAt_idx" ON "CommissionAdminLog" ("createdAt");

-- Backfill from GasCommission
INSERT INTO "CommissionRecord" (
    "id", "referrerUserId", "invitedUserId", "inviteCode", "sourceType", "sourceOrderId",
    "sourceOrderAmount", "commissionRate", "commissionAmount", "currency", "level", "status",
    "settledAt", "paidAt", "legacyKind", "legacyId", "createdAt", "updatedAt"
)
SELECT
    'comm_gas_' || c."id"::text,
    c."toUserId",
    c."fromUserId",
    tu."inviteCode",
    'GAS_ORDER',
    COALESCE(c."sourceOrderId", c."orderId"::text),
    COALESCE(go."amountPaid", 0),
    c."rateAtTheTime",
    c."commissionAmount",
    'USDC',
    c."level",
    CASE
        WHEN c."settlementStatus" IN ('CANCELED', 'REVERSED', 'CANCELLED') THEN 'CANCELED'
        WHEN c."claimedAt" IS NOT NULL THEN 'PAID'
        WHEN c."settlementStatus" = 'SETTLED' THEN 'SETTLED'
        WHEN c."settlementStatus" = 'FAILED' THEN 'FAILED'
        ELSE 'PENDING'
    END,
    CASE WHEN c."settlementStatus" = 'SETTLED' AND c."claimedAt" IS NULL THEN c."createdAt" ELSE NULL END,
    c."claimedAt",
    'gas',
    c."id",
    c."createdAt",
    c."createdAt"
FROM "GasCommission" c
JOIN "User" tu ON tu."id" = c."toUserId"
LEFT JOIN "GasOrder" go ON go."id" = c."orderId"
ON CONFLICT ("id") DO NOTHING;

-- Backfill from MallOrderCommission
INSERT INTO "CommissionRecord" (
    "id", "referrerUserId", "invitedUserId", "inviteCode", "sourceType", "sourceOrderId",
    "sourceOrderAmount", "commissionRate", "commissionAmount", "currency", "level", "status",
    "settledAt", "paidAt", "legacyKind", "legacyId", "createdAt", "updatedAt"
)
SELECT
    'comm_mall_' || c."id"::text,
    c."toUserId",
    c."fromUserId",
    tu."inviteCode",
    'PACKAGE_ORDER',
    c."sourceOrderId",
    COALESCE(po."paidUsd", 0),
    c."rateAtTheTime",
    c."commissionAmount",
    'USDC',
    c."level",
    CASE
        WHEN c."settlementStatus" IN ('CANCELED', 'REVERSED', 'CANCELLED') THEN 'CANCELED'
        WHEN c."claimedAt" IS NOT NULL THEN 'PAID'
        WHEN c."settlementStatus" = 'SETTLED' THEN 'SETTLED'
        WHEN c."settlementStatus" = 'FAILED' THEN 'FAILED'
        ELSE 'PENDING'
    END,
    c."settledAt",
    c."claimedAt",
    'mall',
    c."id",
    c."createdAt",
    COALESCE(c."updatedAt", c."createdAt")
FROM "MallOrderCommission" c
JOIN "User" tu ON tu."id" = c."toUserId"
LEFT JOIN "GasPackageOrder" po ON po."id" = c."orderId"
ON CONFLICT ("id") DO NOTHING;
