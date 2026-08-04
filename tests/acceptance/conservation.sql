\set ON_ERROR_STOP on

-- Every query must return zero rows. Intended for hourly use during the 24h soak.
SELECT 'negative_account_balance' AS invariant, "id"
FROM "VirtualCopyAccount"
WHERE "initialBalanceUsd" <= 0 OR "cashBalanceUsd" < 0 OR "reservedBalanceUsd" < 0;

SELECT 'invalid_open_lot_size' AS invariant, "id"
FROM "VirtualPositionLot"
WHERE "remainingSize" < 0 OR "remainingSize" > "entrySize";

SELECT 'close_exceeds_entry' AS invariant, l."id"
FROM "VirtualPositionLot" l
JOIN (
  SELECT "lotId", SUM("closedSize") AS closed
  FROM "VirtualPositionLotClose"
  GROUP BY "lotId"
) c ON c."lotId" = l."id"
WHERE c.closed + l."remainingSize" <> l."entrySize";

SELECT 'duplicate_ledger_key' AS invariant, "idempotencyKey"
FROM "VirtualAccountLedger"
GROUP BY "idempotencyKey"
HAVING COUNT(*) <> 1;

SELECT 'execution_owner_mismatch' AS invariant, e."id"
FROM "VirtualCopyExecution" e
JOIN "VirtualCopySubscription" s ON s."id" = e."subscriptionId"
WHERE (e."accountId", e."userId") <> (s."accountId", s."userId");

SELECT 'close_owner_mismatch' AS invariant, c."id"
FROM "VirtualPositionLotClose" c
JOIN "VirtualPositionLot" l ON l."id" = c."lotId"
WHERE (c."accountId", c."userId", c."subscriptionId")
   <> (l."accountId", l."userId", l."subscriptionId");
