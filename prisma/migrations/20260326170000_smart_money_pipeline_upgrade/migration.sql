-- AlterTable
ALTER TABLE "ObservedTrader"
ADD COLUMN "officialSourceRankWeek" INTEGER,
ADD COLUMN "officialSourceRankMonth" INTEGER,
ADD COLUMN "officialSourceRankAll" INTEGER,
ADD COLUMN "externalSourceRankWeek" INTEGER,
ADD COLUMN "externalSourceRankMonth" INTEGER,
ADD COLUMN "externalSourceRankAll" INTEGER,
ADD COLUMN "candidateActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "candidateSourceVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "candidateLastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
ADD COLUMN "lastFetchStatus" TEXT,
ADD COLUMN "nextRetryAt" TIMESTAMP(3);

-- Backfill candidate last seen from existing value
UPDATE "ObservedTrader"
SET
  "candidateLastSeenAt" = COALESCE("lastSeenAt", NOW()),
  "officialSourceRankWeek" = "sourceRankWeek",
  "officialSourceRankMonth" = "sourceRankMonth",
  "officialSourceRankAll" = "sourceRankAll";

-- AlterTable
ALTER TABLE "SmartMoneyLeaderboardRow"
ADD COLUMN "officialCandidateScore" DECIMAL(20,8) NOT NULL DEFAULT 0,
ADD COLUMN "externalQualityScore" DECIMAL(20,8) NOT NULL DEFAULT 0,
ADD COLUMN "officialSourceRankWeek" INTEGER,
ADD COLUMN "officialSourceRankMonth" INTEGER,
ADD COLUMN "officialSourceRankAll" INTEGER,
ADD COLUMN "externalSourceRankWeek" INTEGER,
ADD COLUMN "externalSourceRankMonth" INTEGER,
ADD COLUMN "externalSourceRankAll" INTEGER,
ADD COLUMN "scoreExplain" JSONB;

-- Backfill official source ranks from legacy fields
UPDATE "SmartMoneyLeaderboardRow"
SET
  "officialSourceRankWeek" = "sourceRankWeek",
  "officialSourceRankMonth" = "sourceRankMonth",
  "officialSourceRankAll" = "sourceRankAll";

-- CreateIndex
CREATE INDEX "ObservedTrader_candidateActive_enabled_blacklisted_idx"
ON "ObservedTrader"("candidateActive", "enabled", "blacklisted");

-- CreateIndex
CREATE INDEX "ObservedTrader_candidateSourceVersion_idx"
ON "ObservedTrader"("candidateSourceVersion");

-- CreateIndex
CREATE INDEX "ObservedTrader_candidateLastSeenAt_idx"
ON "ObservedTrader"("candidateLastSeenAt");

-- CreateIndex
CREATE INDEX "ObservedTrader_nextRetryAt_idx"
ON "ObservedTrader"("nextRetryAt");
-- AlterTable
ALTER TABLE "ObservedTrader" ALTER COLUMN "candidateLastSeenAt" DROP DEFAULT;
