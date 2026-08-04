-- Replay/archive sweeps filter LeaderTrade on (processed, createdAt); without
-- this index each sweep seq-scans the table and holds a pool connection 20s+.
-- IF NOT EXISTS: the index may already have been created manually with
-- CREATE INDEX CONCURRENTLY on live environments.
CREATE INDEX IF NOT EXISTS "LeaderTrade_processed_createdAt_idx"
  ON "LeaderTrade"("processed", "createdAt");
