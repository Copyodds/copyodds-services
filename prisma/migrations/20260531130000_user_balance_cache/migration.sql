-- Cached USDC/pUSD snapshots written by polymarket-backend when balances are fetched.
-- polymarket-admin-api reads this table instead of live RPC.

CREATE TABLE IF NOT EXISTS "UserBalanceCache" (
    "userId" INTEGER NOT NULL,
    "depositUsdc" DECIMAL(38, 18) NOT NULL DEFAULT 0,
    "depositPusd" DECIMAL(38, 18) NOT NULL DEFAULT 0,
    "custodyUsdc" DECIMAL(38, 18) NOT NULL DEFAULT 0,
    "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBalanceCache_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserBalanceCache"
ADD CONSTRAINT "UserBalanceCache_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
