DROP INDEX IF EXISTS "LeaderTrade_txHash_logIndex_key";

CREATE UNIQUE INDEX "LeaderTrade_leaderAddress_txHash_logIndex_key"
  ON "LeaderTrade"("leaderAddress", "txHash", "logIndex");
