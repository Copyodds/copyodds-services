-- Daily metrics trend (dashboard)

ALTER TABLE "admin_daily_stats"
ADD COLUMN IF NOT EXISTS "new_registered_users" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "admin_daily_stats"
ADD COLUMN IF NOT EXISTS "online_users" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "admin_daily_stats"
ADD COLUMN IF NOT EXISTS "subscribed_addresses" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "admin_daily_stats"
ADD COLUMN IF NOT EXISTS "gas_purchase_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "admin_daily_stats"
ADD COLUMN IF NOT EXISTS "gas_purchase_amount_usdt" NUMERIC(30, 8) NOT NULL DEFAULT 0;

-- DAU storage (onlineUsers)
CREATE TABLE IF NOT EXISTS "user_daily_activity" (
  "id" TEXT NOT NULL,
  "user_id" INTEGER NOT NULL,
  "activity_date" DATE NOT NULL,
  "last_active_at" TIMESTAMP(3) NOT NULL,
  "activity_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_daily_activity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_daily_activity_user_id_activity_date_key"
ON "user_daily_activity"("user_id", "activity_date");

CREATE INDEX IF NOT EXISTS "user_daily_activity_activity_date_idx"
ON "user_daily_activity"("activity_date");

ALTER TABLE "user_daily_activity"
ADD CONSTRAINT "user_daily_activity_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

