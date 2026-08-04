-- Admin daily stats: trend fields for dashboard

ALTER TABLE "admin_daily_stats"
ADD COLUMN IF NOT EXISTS "observed_traders_total" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "admin_daily_stats"
ADD COLUMN IF NOT EXISTS "uptime_percent" DECIMAL(10, 4) NOT NULL DEFAULT 0;
