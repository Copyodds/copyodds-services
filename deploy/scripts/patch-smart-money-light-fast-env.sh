#!/bin/sh
# Light 加速 A+B：关 Light persist、独立 Light gap、控 RAW 水位、Gate 高压让路
# 用法:
#   sh scripts/patch-smart-money-light-fast-env.sh /root/polymarket-backend/.env
#   YIELD_RAW=0 LIGHT_GAP_MS=300 sh scripts/patch-smart-money-light-fast-env.sh .env
# 注意: YIELD_RAW 默认 0。勿设成 ≤ RAW 稳态（如 RawMax=1000 却设 800），否则 Gate 易长期停。
#
set -eu

ENV_FILE="${1:-.env}"
LIGHT_GAP_MS="${LIGHT_GAP_MS:-300}"
HEAVY_GAP_MS="${HEAVY_GAP_MS:-600}"
RAW_MAX="${RAW_MAX:-1000}"
RAW_TARGET="${RAW_TARGET:-1000}"
RAW_LOW="${RAW_LOW:-250}"
YIELD_RAW="${YIELD_RAW:-0}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi

if command -v sed >/dev/null 2>&1; then
  sed -i 's/\r$//' "$ENV_FILE" 2>/dev/null || true
  sed -i 's/\r$//' "$0" 2>/dev/null || true
fi

STAMP=$(date +%Y%m%d%H%M%S)
BAK="${ENV_FILE}.bak.light-fast.${STAMP}"
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

# ---- A：减负 / 控池 / Gate 让路（默认关；短时积压可 YIELD_RAW=1500 等 > 稳态水位）----
upsert SMART_MONEY_LIGHT_PERSIST_SNAPSHOT false
upsert SMART_MONEY_LIGHT_HTML_ONLY true
upsert SMART_MONEY_RAW_POOL_MAX_ACTIVE "$RAW_MAX"
upsert SMART_MONEY_RAW_REFILL_TARGET "$RAW_TARGET"
upsert SMART_MONEY_RAW_REFILL_LOW "$RAW_LOW"
upsert SMART_MONEY_CLOSED_PREFETCH_YIELD_RAW_ACTIVE "$YIELD_RAW"

# ---- B：Light 独立 gap（heavy 仍 600）----
upsert SMART_MONEY_LIGHT_REQUEST_GAP_MS "$LIGHT_GAP_MS"
upsert SMART_MONEY_REQUEST_GAP_MS "$HEAVY_GAP_MS"

echo "patched: $ENV_FILE (light-fast LightGap=${LIGHT_GAP_MS} HeavyGap=${HEAVY_GAP_MS} RawMax=${RAW_MAX} YieldRaw=${YIELD_RAW})"
grep -E '^(SMART_MONEY_LIGHT_PERSIST_SNAPSHOT|SMART_MONEY_LIGHT_HTML_ONLY|SMART_MONEY_LIGHT_REQUEST_GAP_MS|SMART_MONEY_REQUEST_GAP_MS|SMART_MONEY_RAW_POOL_MAX_ACTIVE|SMART_MONEY_RAW_REFILL_TARGET|SMART_MONEY_RAW_REFILL_LOW|SMART_MONEY_CLOSED_PREFETCH_YIELD_RAW_ACTIVE)=' "$ENV_FILE" || true
