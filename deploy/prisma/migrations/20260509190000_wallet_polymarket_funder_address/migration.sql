-- Polymarket CLOB funder (deposit wallet / proxy override)
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "polymarketFunderAddress" TEXT;
