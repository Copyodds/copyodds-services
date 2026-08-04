-- 加速按上级遍历下属（递归 CTE / findMany referrerId = ?）
CREATE INDEX IF NOT EXISTS "User_referrerId_idx" ON "User" ("referrerId");
