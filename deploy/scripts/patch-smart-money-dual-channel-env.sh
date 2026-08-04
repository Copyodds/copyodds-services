#!/bin/sh
# 榜单复评双通道 + Gate 增量 — 测试服 .env 一键写入（POSIX sh）
# 默认 Gate=10 页（测试临时）；恢复生产默认改为 GATE_PAGES=30 再跑本脚本。
#
# 用法:
#   sh scripts/patch-smart-money-dual-channel-env.sh /root/polymarket-backend/.env
#   GATE_PAGES=30 sh scripts/patch-smart-money-dual-channel-env.sh .env
#
set -eu

ENV_FILE="${1:-.env}"
GATE_PAGES="${GATE_PAGES:-10}"
DAILY_TOP_N="${DAILY_TOP_N:-100}"
RESCORE_MODE="${RESCORE_MODE:-dual_channel}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi

if command -v sed >/dev/null 2>&1; then
  sed -i 's/\r$//' "$ENV_FILE" 2>/dev/null || true
  sed -i 's/\r$//' "$0" 2>/dev/null || true
fi

STAMP=$(date +%Y%m%d%H%M%S)
BAK="${ENV_FILE}.bak.dual-channel.${STAMP}"
cp -a "$ENV_FILE" "$BAK"
echo "backup: $BAK"

upsert() {
  key="$1"
  val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    grep -v "^${key}=" "$ENV_FILE" > "${ENV_FILE}.tmp"
    mv "${ENV_FILE}.tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

# ---- Gate / Full / 增量 ----
upsert SMART_MONEY_CLOSED_GATE_MAX_PAGES "$GATE_PAGES"
upsert SMART_MONEY_CLOSED_FULL_MAX_PAGES 80
upsert SMART_MONEY_CLOSED_GATE_TTL_MS 86400000
upsert SMART_MONEY_CLOSED_FULL_TTL_MS 86400000
upsert SMART_MONEY_CLOSED_FULL_REBUILD_MS 259200000
upsert SMART_MONEY_CLOSED_INCREMENTAL_ENABLED true
upsert SMART_MONEY_CLOSED_INCREMENTAL_MAX_PAGES 10
upsert SMART_MONEY_CLOSED_INCREMENTAL_MIN_AGE_MS 1800000
upsert SMART_MONEY_CLOSED_PREFETCH_ENABLED true
upsert SMART_MONEY_DEEP_REQUIRE_CLOSED_SNAPSHOT true

# ---- 双通道复评 ----
upsert SMART_MONEY_COPY_POOL_RESCORE_MODE "$RESCORE_MODE"
upsert SMART_MONEY_COPY_POOL_DAILY_TOP_N "$DAILY_TOP_N"
upsert SMART_MONEY_COPY_POOL_DAILY_TZ UTC
upsert SMART_MONEY_COPY_POOL_PRIORITY_REFRESH_SHARE 0.25
upsert SMART_MONEY_COPY_POOL_APPROX_RANK_ENABLED true
upsert SMART_MONEY_COPY_POOL_SLA_CRON_ENABLED true
upsert SMART_MONEY_COPY_POOL_SLA_INTERVAL_MS 300000

# ---- Phase-H 保底（不改进水硬顶，仅确保存在）----
upsert SMART_MONEY_COPY_POOL_REFRESH_BATCH_SHARE 0.1
upsert SMART_MONEY_DEEP_MIN_QUALIFIED_BATCH_SHARE 0.8

# ---- 强信号复活冷却（Light 3d / Deep 7d）----
upsert SMART_MONEY_STRONG_REVIVE_COOLDOWN_MS "${REVIVE_COOLDOWN_MS:-259200000}"
upsert SMART_MONEY_STRONG_REVIVE_DEEP_COOLDOWN_MS "${REVIVE_DEEP_COOLDOWN_MS:-604800000}"

echo "patched: $ENV_FILE (dual-channel Gate=${GATE_PAGES} TopN=${DAILY_TOP_N} mode=${RESCORE_MODE})"
grep -E '^(SMART_MONEY_CLOSED_GATE_MAX_PAGES|SMART_MONEY_COPY_POOL_RESCORE_MODE|SMART_MONEY_COPY_POOL_DAILY_TOP_N|SMART_MONEY_CLOSED_INCREMENTAL_ENABLED|SMART_MONEY_COPY_POOL_SLA_CRON_ENABLED|SMART_MONEY_STRONG_REVIVE_COOLDOWN_MS|SMART_MONEY_STRONG_REVIVE_DEEP_COOLDOWN_MS)=' "$ENV_FILE" || true
