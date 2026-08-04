-- Beginner-friendly anti-pyramid: skip BUY while an open copy lot exists for the same token.
ALTER TABLE "CopySubscription"
ADD COLUMN "skipBuyIfOpenPosition" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "VirtualCopySubscription"
ADD COLUMN "skipBuyIfOpenPosition" BOOLEAN NOT NULL DEFAULT true;
