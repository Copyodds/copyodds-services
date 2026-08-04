-- P1 hot-path indexes: CopySubscription dispatch, UserAsset balance lookup, Gas* history/admin.
-- Safe to re-run (IF NOT EXISTS). Drop redundant single-column leaderId index after composite exists.

-- CopySubscription: dispatch filters leaderId + deletedAt IS NULL + enabled
CREATE INDEX IF NOT EXISTS "CopySubscription_leaderId_deletedAt_enabled_idx"
ON "CopySubscription" ("leaderId", "deletedAt", "enabled");

DROP INDEX IF EXISTS "CopySubscription_leaderId_idx";

-- UserAsset: getOrCreate / lock-unlock by (userId, symbol)
-- Fails if duplicate (userId, symbol) rows exist; resolve duplicates before re-applying.
CREATE UNIQUE INDEX IF NOT EXISTS "UserAsset_userId_symbol_key"
ON "UserAsset" ("userId", "symbol");

-- GasOrder: user history + status listing
CREATE INDEX IF NOT EXISTS "GasOrder_userId_createdAt_idx"
ON "GasOrder" ("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "GasOrder_status_createdAt_idx"
ON "GasOrder" ("status", "createdAt");

-- GasBalanceLog: per-user ledger timeline
CREATE INDEX IF NOT EXISTS "GasBalanceLog_userId_createdAt_idx"
ON "GasBalanceLog" ("userId", "createdAt");

-- GasPackageOrder: settings last fulfilled + user history + admin pending counts
CREATE INDEX IF NOT EXISTS "GasPackageOrder_userId_fulfilledAt_idx"
ON "GasPackageOrder" ("userId", "fulfilledAt" DESC);

CREATE INDEX IF NOT EXISTS "GasPackageOrder_userId_createdAt_idx"
ON "GasPackageOrder" ("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "GasPackageOrder_status_createdAt_idx"
ON "GasPackageOrder" ("status", "createdAt");
