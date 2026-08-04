#!/bin/sh
# 测试服：解压部署包后一键 apply Light 加速 A+B（写 env + 重启 pm2）
# 在应用目录执行，例如 /root/polymarket-backend
#
# 用法:
#   cd /root/polymarket-backend
#   sh scripts/apply-light-fast-test-release.sh
#   LIGHT_GAP_MS=300 RAW_MAX=1000 sh scripts/apply-light-fast-test-release.sh
#
set -eu

APP_DIR="${APP_DIR:-$(pwd)}"
cd "$APP_DIR"

ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
LIGHT_GAP_MS="${LIGHT_GAP_MS:-300}"
HEAVY_GAP_MS="${HEAVY_GAP_MS:-600}"
RAW_MAX="${RAW_MAX:-1000}"
RAW_TARGET="${RAW_TARGET:-1000}"
RAW_LOW="${RAW_LOW:-250}"
YIELD_RAW="${YIELD_RAW:-0}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

if [ ! -f scripts/patch-smart-money-light-fast-env.sh ]; then
  echo "ERROR: scripts/patch-smart-money-light-fast-env.sh missing (解压包不完整?)" >&2
  exit 1
fi

# 去掉 Windows CRLF，避免 set: Illegal option -
sed -i 's/\r$//' scripts/patch-smart-money-light-fast-env.sh scripts/apply-light-fast-test-release.sh 2>/dev/null || true
chmod +x scripts/patch-smart-money-light-fast-env.sh scripts/apply-light-fast-test-release.sh 2>/dev/null || true

echo "==> [1/3] patch light-fast env (LightGap=${LIGHT_GAP_MS} RawMax=${RAW_MAX} Yield=${YIELD_RAW})"
LIGHT_GAP_MS="$LIGHT_GAP_MS" HEAVY_GAP_MS="$HEAVY_GAP_MS" \
  RAW_MAX="$RAW_MAX" RAW_TARGET="$RAW_TARGET" RAW_LOW="$RAW_LOW" YIELD_RAW="$YIELD_RAW" \
  sh scripts/patch-smart-money-light-fast-env.sh "$ENV_FILE"

echo "==> [2/3] restart pm2 (backend / smart-money-worker / copy-worker)"
pm2 restart backend --update-env || pm2 start dist/src/server.js --name backend --node-args="--env-file=.env"
pm2 restart copy-worker --update-env || pm2 start dist/src/entry/copyWorker.js --name copy-worker --node-args="--env-file=.env"
if pm2 describe smart-money-worker >/dev/null 2>&1; then
  pm2 restart smart-money-worker --update-env
else
  pm2 start dist/src/entry/smartMoneyWorker.js --name smart-money-worker --node-args="--env-file=.env" || \
  pm2 start npm --name smart-money-worker -- run start:smart-money-worker || true
fi
pm2 save || true

echo "==> [3/3] verify env keys + pm2"
sleep 2
grep -E '^(SMART_MONEY_LIGHT_PERSIST_SNAPSHOT|SMART_MONEY_LIGHT_HTML_ONLY|SMART_MONEY_LIGHT_REQUEST_GAP_MS|SMART_MONEY_REQUEST_GAP_MS|SMART_MONEY_RAW_POOL_MAX_ACTIVE|SMART_MONEY_RAW_REFILL_TARGET|SMART_MONEY_RAW_REFILL_LOW|SMART_MONEY_CLOSED_PREFETCH_YIELD_RAW_ACTIVE)=' "$ENV_FILE" || true
pm2 ls || true
echo "DONE. Light-fast applied. Watch: pm2 logs smart-money-worker --lines 80"
