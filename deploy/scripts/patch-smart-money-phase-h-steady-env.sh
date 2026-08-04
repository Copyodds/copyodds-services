#!/bin/sh
# Phase H Steady env upsert (POSIX sh)
# 用法: sh scripts/patch-smart-money-phase-h-steady-env.sh /root/polymarket-backend/.env
set -eu

ENV_FILE="${1:-.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi

if command -v sed >/dev/null 2>&1; then
  sed -i 's/\r$//' "$ENV_FILE" 2>/dev/null || true
  sed -i 's/\r$//' "$0" 2>/dev/null || true
fi

STAMP=$(date +%Y%m%d%H%M%S)
BAK="${ENV_FILE}.bak.phase-h-steady.${STAMP}"
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

upsert SMART_MONEY_DISCOVERY_BOOTSTRAP_BOARD false
upsert SMART_MONEY_DISCOVERY_INGEST_PER_RUN 1000
upsert SMART_MONEY_LEADERBOARD_INGEST_RESERVED_SLOTS 300
upsert SMART_MONEY_BLOCK_SCAN_INGEST_MAX 150
upsert SMART_MONEY_BLOCK_SCAN_MIN_FILLS 10
upsert SMART_MONEY_BLOCK_SCAN_MIN_NOTIONAL_USD 5000
upsert SMART_MONEY_BLOCK_SCAN_MIN_WINDOW_NOTIONAL_USD 25000
upsert SMART_MONEY_BLOCK_SCAN_FETCH_PRIORITY_SLOTS 8
upsert SMART_MONEY_RAW_BOARD_ACTIVE_CAP 8000
upsert SMART_MONEY_RAW_BLOCKSCAN_ACTIVE_CAP 5000
upsert SMART_MONEY_LIGHT_PRIORITY_BATCH_SLOTS 18
upsert SMART_MONEY_LIGHT_FETCH_BATCH_SIZE 30
upsert SMART_MONEY_ANALYZE_CONCURRENCY 2

echo "patched: $ENV_FILE (Phase H Steady)"
grep -E '^(SMART_MONEY_DISCOVERY_BOOTSTRAP_BOARD|SMART_MONEY_BLOCK_SCAN_INGEST_MAX|SMART_MONEY_BLOCK_SCAN_MIN_NOTIONAL_USD)=' "$ENV_FILE" || true
