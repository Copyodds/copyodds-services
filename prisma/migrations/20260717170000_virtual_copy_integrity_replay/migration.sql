CREATE TABLE "VirtualCopyReplayCheckpoint" (
  "key" TEXT NOT NULL,
  "lastCreatedAt" TIMESTAMP(3) NOT NULL,
  "lastTradeId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VirtualCopyReplayCheckpoint_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "VirtualCopySubscription"
  DROP CONSTRAINT "VirtualCopySubscription_leaderId_fkey",
  ADD CONSTRAINT "VirtualCopySubscription_leaderId_fkey"
    FOREIGN KEY ("leaderId") REFERENCES "CopyLeader"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualCopyExecution"
  DROP CONSTRAINT "VirtualCopyExecution_subscriptionId_fkey",
  ADD CONSTRAINT "VirtualCopyExecution_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "VirtualCopySubscription"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualCopyExecution"
  DROP CONSTRAINT "VirtualCopyExecution_leaderTradeId_fkey",
  ADD CONSTRAINT "VirtualCopyExecution_leaderTradeId_fkey"
    FOREIGN KEY ("leaderTradeId") REFERENCES "LeaderTrade"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VirtualPositionLot"
  DROP CONSTRAINT "VirtualPositionLot_subscriptionId_fkey",
  ADD CONSTRAINT "VirtualPositionLot_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "VirtualCopySubscription"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualPositionLot"
  DROP CONSTRAINT "VirtualPositionLot_buyExecutionId_fkey",
  ADD CONSTRAINT "VirtualPositionLot_buyExecutionId_fkey"
    FOREIGN KEY ("buyExecutionId") REFERENCES "VirtualCopyExecution"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualPositionLotClose"
  DROP CONSTRAINT "VirtualPositionLotClose_subscriptionId_fkey",
  ADD CONSTRAINT "VirtualPositionLotClose_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "VirtualCopySubscription"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualPositionLotClose"
  DROP CONSTRAINT "VirtualPositionLotClose_lotId_fkey",
  ADD CONSTRAINT "VirtualPositionLotClose_lotId_fkey"
    FOREIGN KEY ("lotId") REFERENCES "VirtualPositionLot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualPositionLotClose"
  DROP CONSTRAINT "VirtualPositionLotClose_buyExecutionId_fkey",
  ADD CONSTRAINT "VirtualPositionLotClose_buyExecutionId_fkey"
    FOREIGN KEY ("buyExecutionId") REFERENCES "VirtualCopyExecution"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VirtualPositionLotClose"
  DROP CONSTRAINT "VirtualPositionLotClose_sellExecutionId_fkey",
  ADD CONSTRAINT "VirtualPositionLotClose_sellExecutionId_fkey"
    FOREIGN KEY ("sellExecutionId") REFERENCES "VirtualCopyExecution"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
