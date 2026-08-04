-- Hot-path indexes for pnl-summary / executions list / user positions.
-- Partial indexes (WHERE ...) cannot be declared in Prisma schema; keep in raw SQL.
-- CopyExecution has no @@map — PostgreSQL table is "CopyExecution", not copy_executions.

-- executions list (legacy rows): followerUserId + ORDER BY createdAt
CREATE INDEX IF NOT EXISTS "CopyExecution_followerUserId_createdAt_desc_idx"
ON "CopyExecution" ("followerUserId", "createdAt" DESC);

-- pnl-summary legacy existence + legacy FIFO cap
CREATE INDEX IF NOT EXISTS "CopyExecution_followerUserId_status_hot_idx"
ON "CopyExecution" ("followerUserId", status);

-- positions stale-hide + legacy settlement lookup
CREATE INDEX IF NOT EXISTS "CopyExecution_followerUserId_tokenID_status_hot_idx"
ON "CopyExecution" ("followerUserId", "tokenID", status);

-- settled filter / lot-close timeline per user
CREATE INDEX IF NOT EXISTS "copy_position_lot_closes_userId_createdAt_idx"
ON "copy_position_lot_closes" ("userId", "createdAt" DESC);

-- lot-close PnL keyed by user + sell row (executions list page)
CREATE INDEX IF NOT EXISTS "copy_position_lot_closes_userId_sellRow_idx"
ON "copy_position_lot_closes" ("userId", "sellCopyTradeRowId");

-- pnl-summary legacy lot-close aggregates
CREATE INDEX IF NOT EXISTS "copy_position_lot_closes_userId_legacy_sell_idx"
ON "copy_position_lot_closes" ("userId", "createdAt" DESC)
WHERE "sellCopyTradeRowId" LIKE 'legacy:%';

-- positions open-lot lookup (userId + token filter, skip zero rows)
CREATE INDEX IF NOT EXISTS "copy_position_lots_userId_tokenID_open_idx"
ON "copy_position_lots" ("userId", "tokenID")
WHERE "remainingSize" > 0;

-- executions metadata fallback (tokenId on copy_trades row)
CREATE INDEX IF NOT EXISTS "copy_trades_userId_tokenId_createdAt_idx"
ON "copy_trades" ("userId", "tokenId", "createdAt" DESC)
WHERE "tokenId" IS NOT NULL;

-- Refresh planner stats after bulk copy_trades growth (410k+ rows / user).
ANALYZE "copy_trades";
ANALYZE "CopyExecution";
ANALYZE "copy_position_lot_closes";
ANALYZE "copy_position_lots";
