ALTER TABLE "CopySubscription" ADD COLUMN "minNotionalMode" TEXT NOT NULL DEFAULT 'BUMP_TO_MIN';

UPDATE "CopySubscription"
SET "minNotionalMode" = 'SKIP'
WHERE "copyMode" = 'RATIO';
