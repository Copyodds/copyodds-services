-- Affiliate tier shop orders: commission settlement fields (mirror GasPackageOrder)
ALTER TABLE "AffiliateTierOrder" ADD COLUMN "commissionSettlementStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "AffiliateTierOrder" ADD COLUMN "commissionSettledAt" TIMESTAMP(3);

-- MallOrderCommission: support AffiliateTierOrder linkage (avoid orderId collision across tables)
ALTER TABLE "MallOrderCommission" DROP CONSTRAINT "MallOrderCommission_orderId_fkey";
ALTER TABLE "MallOrderCommission" ALTER COLUMN "orderId" DROP NOT NULL;

ALTER TABLE "MallOrderCommission" ADD COLUMN "affiliateTierOrderId" INTEGER;

ALTER TABLE "MallOrderCommission" ADD CONSTRAINT "MallOrderCommission_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "GasPackageOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MallOrderCommission" ADD CONSTRAINT "MallOrderCommission_affiliateTierOrderId_fkey"
    FOREIGN KEY ("affiliateTierOrderId") REFERENCES "AffiliateTierOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "MallOrderCommission_orderId_toUserId_level_key";

CREATE UNIQUE INDEX "MallOrderCommission_sourceType_sourceOrderId_toUserId_level_key"
    ON "MallOrderCommission"("sourceType", "sourceOrderId", "toUserId", "level");

CREATE INDEX "MallOrderCommission_affiliateTierOrderId_idx" ON "MallOrderCommission"("affiliateTierOrderId");
