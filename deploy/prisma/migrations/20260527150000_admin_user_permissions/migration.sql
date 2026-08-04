-- Admin RBAC: role + permissions for user management

ALTER TABLE "AdminUser"
ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'SUPER_ADMIN';

ALTER TABLE "AdminUser"
ADD COLUMN IF NOT EXISTS "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "AdminUser" SET "role" = 'SUPER_ADMIN' WHERE "role" IS NULL OR "role" = '';
