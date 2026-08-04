-- Drop legacy password column; auth is email OTP only.
ALTER TABLE "User" DROP COLUMN IF EXISTS "passwordHash";
