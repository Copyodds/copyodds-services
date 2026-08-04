-- Go 钱包接入：Wallet 记录派生索引与签名来源；UserCustodialKey 允许无私钥（GO_REMOTE）
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "walletIndex" INTEGER;
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "signingProvider" TEXT;
UPDATE "Wallet" SET "signingProvider" = 'LOCAL_DB' WHERE "signingProvider" IS NULL;
ALTER TABLE "Wallet" ALTER COLUMN "signingProvider" SET DEFAULT 'LOCAL_DB';
ALTER TABLE "Wallet" ALTER COLUMN "signingProvider" SET NOT NULL;

ALTER TABLE "UserCustodialKey" ALTER COLUMN "encryptedPrivateKey" DROP NOT NULL;
