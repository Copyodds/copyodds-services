-- ApiCredential: 按钱包绑定 + 本地滚动过期时间
DROP INDEX IF EXISTS "ApiCredential_userId_key";

ALTER TABLE "ApiCredential" ADD COLUMN "walletId" INTEGER;
ALTER TABLE "ApiCredential" ADD COLUMN "expiresAt" TIMESTAMP(3);

UPDATE "ApiCredential" ac
SET "walletId" = (
  SELECT w."id"
  FROM "Wallet" w
  WHERE w."userId" = ac."userId" AND w."type" = 'USER_EOA'
  ORDER BY w."createdAt" ASC
  LIMIT 1
)
WHERE ac."walletId" IS NULL;

UPDATE "ApiCredential"
SET "expiresAt" = "updatedAt" + INTERVAL '180 days'
WHERE "expiresAt" IS NULL AND "walletId" IS NOT NULL;

DELETE FROM "ApiCredential" WHERE "walletId" IS NULL;

ALTER TABLE "ApiCredential" ALTER COLUMN "walletId" SET NOT NULL;
ALTER TABLE "ApiCredential" ALTER COLUMN "expiresAt" SET NOT NULL;

CREATE UNIQUE INDEX "ApiCredential_walletId_key" ON "ApiCredential"("walletId");

ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ApiCredential_userId_idx" ON "ApiCredential"("userId");
