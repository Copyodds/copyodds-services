-- AlterTable: passwordless auth (email OTP only)
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
