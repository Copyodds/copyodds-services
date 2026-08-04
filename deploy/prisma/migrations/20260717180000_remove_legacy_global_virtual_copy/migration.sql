-- Permanently remove the retired global virtual-copy mode.
-- The new VirtualCopy* account tables are intentionally untouched.

BEGIN;

-- Materialize the retired execution IDs once. Repeating `IN (SELECT ... WHERE
-- isVirtual)` made PostgreSQL materialize and linearly rescan roughly one
-- million IDs for every close row on large installations.
CREATE TEMP TABLE "legacy_virtual_copy_trade_ids"
ON COMMIT DROP
AS
SELECT id
FROM "copy_trades"
WHERE "isVirtual" = true;

CREATE UNIQUE INDEX "legacy_virtual_copy_trade_ids_id_idx"
  ON "legacy_virtual_copy_trade_ids"(id);
ANALYZE "legacy_virtual_copy_trade_ids";

DO $$
DECLARE
  legacy_execution_count BIGINT;
  legacy_lot_count BIGINT;
  legacy_close_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO legacy_execution_count
    FROM "legacy_virtual_copy_trade_ids";
  SELECT COUNT(*) INTO legacy_lot_count
    FROM "copy_position_lots" lot
    JOIN "legacy_virtual_copy_trade_ids" legacy
      ON legacy.id = lot."buyCopyTradeRowId";
  SELECT COUNT(*) INTO legacy_close_count
    FROM "copy_position_lot_closes" close_row
    WHERE EXISTS (
      SELECT 1 FROM "legacy_virtual_copy_trade_ids" legacy
      WHERE legacy.id = close_row."buyCopyTradeRowId"
    )
       OR EXISTS (
      SELECT 1 FROM "legacy_virtual_copy_trade_ids" legacy
      WHERE legacy.id = close_row."sellCopyTradeRowId"
    );
  RAISE NOTICE 'Permanently deleting legacy virtual records: executions=%, lots=%, closes=%',
    legacy_execution_count, legacy_lot_count, legacy_close_count;
END $$;

-- Remove dependent shared-table records before deleting the virtual copy_trades.
DELETE FROM "RiskEvent" target
USING "legacy_virtual_copy_trade_ids" legacy
WHERE target."copyTradeRowId" = legacy.id;

DELETE FROM "AuditEvent" target
USING "legacy_virtual_copy_trade_ids" legacy
WHERE target."targetType" = 'CopyTradeRow'
  AND target."targetId" = legacy.id;

DELETE FROM "admin_activity_logs" target
USING "legacy_virtual_copy_trade_ids" legacy
WHERE target."target_type" = 'CopyTradeRow'
  AND target."target_id" = legacy.id;

DELETE FROM "copy_position_lot_closes" target
USING "legacy_virtual_copy_trade_ids" legacy
WHERE target."buyCopyTradeRowId" = legacy.id;

DELETE FROM "copy_position_lot_closes" target
USING "legacy_virtual_copy_trade_ids" legacy
WHERE target."sellCopyTradeRowId" = legacy.id;

DELETE FROM "copy_position_lots" target
USING "legacy_virtual_copy_trade_ids" legacy
WHERE target."buyCopyTradeRowId" = legacy.id;

DELETE FROM "copy_trades" target
USING "legacy_virtual_copy_trade_ids" legacy
WHERE target.id = legacy.id;

ALTER TABLE "copy_trades"
  DROP COLUMN "isVirtual",
  DROP COLUMN "executionMode";

ALTER TABLE "User"
  DROP COLUMN "copyTradingVirtualEnabled";

ALTER TABLE "UserSettings"
  DROP COLUMN "copyPnlRealTotalUsd",
  DROP COLUMN "copyPnlRealTodayUsd",
  DROP COLUMN "copyPnlRealWindowStartAt",
  DROP COLUMN "copyPnlRealComputedAt",
  DROP COLUMN "copyPnlVirtualTotalUsd",
  DROP COLUMN "copyPnlVirtualTodayUsd",
  DROP COLUMN "copyPnlVirtualWindowStartAt",
  DROP COLUMN "copyPnlVirtualComputedAt";

COMMIT;
