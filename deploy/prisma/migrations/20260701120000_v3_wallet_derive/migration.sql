-- v3 托管钱包派生：用户钱包密码与迁移状态、Wallet 派生方案字段

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "encryptedWalletPassword" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "walletDeriveMigrationStatus" TEXT NOT NULL DEFAULT 'PENDING';

ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "derivationScheme" TEXT NOT NULL DEFAULT 'v3_refer_pass';
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "supersededAddress" TEXT;

-- 存量已开通托管用户保持 v2_hd，待迁移
UPDATE "Wallet"
SET "derivationScheme" = 'v2_hd'
WHERE "type" = 'CUSTODIAL' AND "walletIndex" IS NOT NULL;

-- 存量无托管钱包的用户视为无需迁移（新注册将直接 COMPLETED）
UPDATE "User" u
SET "walletDeriveMigrationStatus" = 'COMPLETED'
WHERE NOT EXISTS (
  SELECT 1 FROM "Wallet" w
  WHERE w."userId" = u.id AND w."type" = 'CUSTODIAL'
);
