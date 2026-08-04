-- Speed up executions list (userId + ORDER BY createdAt) and subscription lastError (DISTINCT ON).
CREATE INDEX IF NOT EXISTS "copy_trades_userId_createdAt_idx"
ON "copy_trades" ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "copy_trades_subscriptionId_status_updatedAt_idx"
ON "copy_trades" ("subscriptionId", status, "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS "copy_trades_userId_status_updatedAt_idx"
ON "copy_trades" ("userId", status, "updatedAt" DESC);

-- pnl-summary: 是否存在未写入 realizedPnlUsd 的 filled 行（findFirst / 有限 FIFO）
CREATE INDEX IF NOT EXISTS "copy_trades_userId_filled_untracked_idx"
ON "copy_trades" ("userId", "updatedAt")
WHERE status = 'filled' AND "realizedPnlUsd" IS NULL;

-- pnl-summary: SUM(realizedPnlUsd) / 今日窗口
CREATE INDEX IF NOT EXISTS "copy_trades_userId_realized_pnl_idx"
ON "copy_trades" ("userId", "realizedPnlAt")
WHERE "realizedPnlUsd" IS NOT NULL;
