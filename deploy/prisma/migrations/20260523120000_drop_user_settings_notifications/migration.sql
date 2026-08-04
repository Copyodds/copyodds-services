-- Drop notification preference columns from UserSettings
ALTER TABLE "UserSettings" DROP COLUMN "pushEnabled";
ALTER TABLE "UserSettings" DROP COLUMN "emailEnabled";
ALTER TABLE "UserSettings" DROP COLUMN "tradeDetected";
ALTER TABLE "UserSettings" DROP COLUMN "orderPlaced";
ALTER TABLE "UserSettings" DROP COLUMN "orderFailed";
ALTER TABLE "UserSettings" DROP COLUMN "orderFilled";
ALTER TABLE "UserSettings" DROP COLUMN "orderCancelled";
ALTER TABLE "UserSettings" DROP COLUMN "budgetWarning";
ALTER TABLE "UserSettings" DROP COLUMN "budgetLow";
ALTER TABLE "UserSettings" DROP COLUMN "autoClaim";
ALTER TABLE "UserSettings" DROP COLUMN "sessionExpiring";
