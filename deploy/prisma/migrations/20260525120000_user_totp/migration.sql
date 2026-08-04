-- AlterTable
ALTER TABLE "User" ADD COLUMN "totpSecretEncrypted" TEXT,
ADD COLUMN "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN "totpPendingSecretEncrypted" TEXT,
ADD COLUMN "totpPendingCreatedAt" TIMESTAMP(3);
