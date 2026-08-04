-- Make room for new L1 (10%): shift existing tier indices up by one.
-- Users/products at tier 8 stay at tier 8.

UPDATE "User"
SET "affiliateTier" = "affiliateTier" + 1
WHERE "affiliateTier" >= 1 AND "affiliateTier" <= 7;

UPDATE "AffiliateTierProduct"
SET "affiliateTier" = "affiliateTier" + 1
WHERE "affiliateTier" >= 1 AND "affiliateTier" <= 7;

UPDATE "AffiliateTierOrder"
SET "affiliateTier" = "affiliateTier" + 1
WHERE "affiliateTier" >= 1 AND "affiliateTier" <= 7;

UPDATE "GasPackage"
SET "bonusAffiliateTier" = "bonusAffiliateTier" + 1
WHERE "bonusAffiliateTier" >= 1 AND "bonusAffiliateTier" <= 7;

UPDATE "GasPackageOrder"
SET "bonusAffiliateTierGranted" = "bonusAffiliateTierGranted" + 1
WHERE "bonusAffiliateTierGranted" >= 1 AND "bonusAffiliateTierGranted" <= 7;
