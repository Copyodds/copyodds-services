-- cached API: 用 activeCandidate 替代 wallet IN (1.6万+ 地址)
ALTER TABLE "SmartMoneyLeaderboardRow"
  ADD COLUMN IF NOT EXISTS "activeCandidate" BOOLEAN NOT NULL DEFAULT false;

UPDATE "SmartMoneyLeaderboardRow" sm
SET "activeCandidate" = EXISTS (
  SELECT 1
  FROM "ObservedTrader" ot
  WHERE ot.wallet = sm.wallet
    AND ot."candidateActive" = true
    AND ot.enabled = true
    AND ot.blacklisted = false
);

CREATE INDEX IF NOT EXISTS "SmartMoneyLeaderboardRow_activeCandidate_eligible_sourceFetchedAt_rank_idx"
  ON "SmartMoneyLeaderboardRow" ("activeCandidate", "eligible", "sourceFetchedAt", "rank");
