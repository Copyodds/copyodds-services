-- 消息服自有表（与 LeaderTrade 同库，独立迁移）

CREATE TABLE "signal_ingest_cursor" (
  "id" TEXT NOT NULL,
  "lastCreatedAt" TIMESTAMP(3) NOT NULL,
  "lastId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "signal_ingest_cursor_pkey" PRIMARY KEY ("id")
);

INSERT INTO "signal_ingest_cursor" ("id", "lastCreatedAt", "lastId", "updatedAt")
VALUES ('default', '1970-01-01 00:00:00'::timestamp, '', NOW());

CREATE TABLE "signal_outbox" (
  "id" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "signal_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signal_outbox_idempotencyKey_key" ON "signal_outbox"("idempotencyKey");
CREATE INDEX "signal_outbox_publishedAt_createdAt_idx" ON "signal_outbox"("publishedAt", "createdAt");

CREATE TABLE "signal_inbox" (
  "id" TEXT NOT NULL,
  "consumerName" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "signal_inbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signal_inbox_consumerName_idempotencyKey_key"
ON "signal_inbox"("consumerName", "idempotencyKey");

CREATE UNIQUE INDEX "signal_inbox_consumerName_eventId_key"
ON "signal_inbox"("consumerName", "eventId");

CREATE INDEX "signal_inbox_consumerName_createdAt_idx"
ON "signal_inbox"("consumerName", "createdAt");
