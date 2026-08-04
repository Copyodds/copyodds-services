-- Admin dashboard: stats snapshots, activity logs, alerts, leader performance, runtime status, daily stats

CREATE TABLE "admin_stats_snapshot" (
    "id" TEXT NOT NULL,
    "stat_key" TEXT NOT NULL,
    "stat_value" TEXT NOT NULL,
    "stat_extra" JSONB,
    "period" TEXT NOT NULL DEFAULT 'current',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_stats_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_stats_snapshot_stat_key_period_key" ON "admin_stats_snapshot"("stat_key", "period");

CREATE TABLE "admin_activity_logs" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "actor_type" TEXT,
    "actor_id" TEXT,
    "target_type" TEXT,
    "target_id" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_activity_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_activity_logs_created_at_idx" ON "admin_activity_logs"("created_at" DESC);
CREATE INDEX "admin_activity_logs_event_type_idx" ON "admin_activity_logs"("event_type");

CREATE TABLE "admin_alerts" (
    "id" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "level" TEXT NOT NULL DEFAULT 'warning',
    "status" TEXT NOT NULL DEFAULT 'open',
    "source" TEXT,
    "target_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "admin_alerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_alerts_status_created_at_idx" ON "admin_alerts"("status", "created_at" DESC);

CREATE TABLE "leader_performance_stats" (
    "id" TEXT NOT NULL,
    "leader_address" TEXT NOT NULL,
    "roi" DECIMAL(20,8) NOT NULL,
    "win_rate" DECIMAL(20,8) NOT NULL,
    "followers_count" INTEGER NOT NULL DEFAULT 0,
    "copy_volume" DECIMAL(38,18),
    "profit_usdt" DECIMAL(38,18),
    "risk_level" TEXT NOT NULL DEFAULT 'medium',
    "period" TEXT NOT NULL DEFAULT '30d',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leader_performance_stats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leader_performance_stats_leader_address_period_key" ON "leader_performance_stats"("leader_address", "period");
CREATE INDEX "leader_performance_stats_period_roi_idx" ON "leader_performance_stats"("period", "roi" DESC);

CREATE TABLE "system_runtime_status" (
    "id" TEXT NOT NULL,
    "status_key" TEXT NOT NULL,
    "status_value" TEXT NOT NULL,
    "status_extra" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_runtime_status_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_runtime_status_status_key_key" ON "system_runtime_status"("status_key");

CREATE TABLE "admin_daily_stats" (
    "id" TEXT NOT NULL,
    "stat_date" DATE NOT NULL,
    "registered_users" INTEGER NOT NULL DEFAULT 0,
    "wallet_bound_users" INTEGER NOT NULL DEFAULT 0,
    "active_copy_traders" INTEGER NOT NULL DEFAULT 0,
    "copy_success_count" INTEGER NOT NULL DEFAULT 0,
    "copy_failed_count" INTEGER NOT NULL DEFAULT 0,
    "risk_block_count" INTEGER NOT NULL DEFAULT 0,
    "gas_order_count" INTEGER NOT NULL DEFAULT 0,
    "commission_usdt" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_daily_stats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_daily_stats_stat_date_key" ON "admin_daily_stats"("stat_date");
