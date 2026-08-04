-- AlterTable
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "xUsername" TEXT;
ALTER TABLE "CopyLeader" ADD COLUMN IF NOT EXISTS "tier" TEXT;

-- Backfill from Smart Money leaderboard for existing copy leaders
UPDATE "CopyLeader" AS cl
SET
  "displayName" = CASE
    WHEN sm."displayName" IS NULL OR btrim(sm."displayName") = '' THEN cl."displayName"
    WHEN sm."displayName" ~ '^0x[a-fA-F0-9]{10,}$' THEN cl."displayName"
    ELSE btrim(sm."displayName")
  END,
  "xUsername" = CASE
    WHEN sm."xUsername" IS NULL OR btrim(sm."xUsername") = '' THEN cl."xUsername"
    ELSE ltrim(btrim(sm."xUsername"), '@')
  END,
  "tier" = CASE
    WHEN sm."tier" IS NULL OR btrim(sm."tier") = '' THEN cl."tier"
    ELSE upper(btrim(sm."tier"))
  END
FROM "SmartMoneyLeaderboardRow" AS sm
WHERE lower(cl."address") = lower(sm."wallet");
