-- Polymarket 未提供 CLOB API Key 官方过期时间，不再做本地主动失效
ALTER TABLE "ApiCredential" DROP COLUMN IF EXISTS "expiresAt";
