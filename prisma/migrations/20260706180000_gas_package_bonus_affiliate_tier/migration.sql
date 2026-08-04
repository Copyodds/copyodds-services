-- Optional affiliate tier bonus configured per gas package; granted on order fulfillment.
ALTER TABLE "GasPackage" ADD COLUMN "bonusAffiliateTier" INTEGER;

ALTER TABLE "GasPackageOrder" ADD COLUMN "bonusAffiliateTierGranted" INTEGER;
ALTER TABLE "GasPackageOrder" ADD COLUMN "bonusAffiliateTierGrantedAt" TIMESTAMP(3);
