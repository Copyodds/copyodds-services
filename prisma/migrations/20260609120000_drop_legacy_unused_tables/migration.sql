-- Drop legacy / unused tables (see scripts/list-db-tables.ts comparison).
-- Kept: wallet service tables (addresses, assets, wallet_sequence).
-- Not in this batch: CopyRelation, CopyExecution (still referenced by live APIs).

-- Orphan tables with zero codebase references
DROP TABLE IF EXISTS "SigningIntent";
DROP TABLE IF EXISTS "WalletKeyMaterial";
DROP TABLE IF EXISTS "email_verification_codes";
DROP TABLE IF EXISTS "app_cache";

-- Child tables first (FK order)
DROP TABLE IF EXISTS "AutomationActionLog";
DROP TABLE IF EXISTS "AutomationSessionGrant";

-- Replaced by CopySubscription
DROP TABLE IF EXISTS "FollowStrategy";

-- Demo-only trading connection registry
DROP TABLE IF EXISTS "TradingConnection";

-- apps/api only; never used by polymarket-backend
DROP TABLE IF EXISTS "ProcessedTrade";

-- Legacy internal-balance webhook (endpoint returns 410)
DROP TABLE IF EXISTS "CustodyLedgerTopupIdempotency";
