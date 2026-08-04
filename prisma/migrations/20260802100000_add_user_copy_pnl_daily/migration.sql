CREATE TABLE "user_copy_pnl_events" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "previous" DECIMAL(38,18) NOT NULL,
  "next" DECIMAL(38,18) NOT NULL,
  "delta" DECIMAL(38,18) NOT NULL,
  "attributionAt" TIMESTAMP(3) NOT NULL,
  "dayStartAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_copy_pnl_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_copy_pnl_events_eventKey_key"
  ON "user_copy_pnl_events"("eventKey");
CREATE INDEX "user_copy_pnl_events_userId_attributionAt_idx"
  ON "user_copy_pnl_events"("userId", "attributionAt");
CREATE INDEX "user_copy_pnl_events_userId_dayStartAt_idx"
  ON "user_copy_pnl_events"("userId", "dayStartAt");
CREATE INDEX "user_copy_pnl_events_sourceType_sourceId_idx"
  ON "user_copy_pnl_events"("sourceType", "sourceId");

CREATE TABLE "user_copy_pnl_daily" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "dayStartAt" TIMESTAMP(3) NOT NULL,
  "realizedPnlUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_copy_pnl_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_copy_pnl_daily_userId_dayStartAt_key"
  ON "user_copy_pnl_daily"("userId", "dayStartAt");
CREATE INDEX "user_copy_pnl_daily_userId_dayStartAt_idx"
  ON "user_copy_pnl_daily"("userId", "dayStartAt");

ALTER TABLE "user_copy_pnl_events"
  ADD CONSTRAINT "user_copy_pnl_events_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_copy_pnl_daily"
  ADD CONSTRAINT "user_copy_pnl_daily_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION prevent_user_copy_pnl_event_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'user_copy_pnl_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "user_copy_pnl_events_immutable"
BEFORE UPDATE ON "user_copy_pnl_events"
FOR EACH ROW EXECUTE FUNCTION prevent_user_copy_pnl_event_update();
