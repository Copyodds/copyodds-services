#!/bin/sh
# 测试服：解压部署包后一键 apply（写 env + migrate + 重启 pm2）
# 在应用目录执行，例如 /root/polymarket-backend 或 /www/wwwroot/polycopy-backend/current
#
# 用法:
#   cd /root/polymarket-backend
#   sh scripts/apply-dual-channel-test-release.sh
#   GATE_PAGES=30 sh scripts/apply-dual-channel-test-release.sh   # 恢复 Gate=30
#
set -eu

APP_DIR="${APP_DIR:-$(pwd)}"
cd "$APP_DIR"

ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
GATE_PAGES="${GATE_PAGES:-10}"
DAILY_TOP_N="${DAILY_TOP_N:-100}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

echo "==> [1/4] patch dual-channel env (Gate=${GATE_PAGES})"
sh scripts/patch-smart-money-dual-channel-env.sh "$ENV_FILE"

echo "==> [2/4] prisma migrate deploy"
if [ -x ./node_modules/.bin/prisma ]; then
  PRISMA=./node_modules/.bin/prisma
else
  PRISMA=npx prisma
fi
# 优先 pm2；否则只抽 DATABASE_URL（勿 source 整份 .env，密钥含 / 会炸）
PM2_DB="$(pm2 env backend 2>/dev/null | grep -m1 '^DATABASE_URL=' | cut -d= -f2- || true)"
if [ -n "${PM2_DB:-}" ]; then
  echo "using DATABASE_URL from pm2 backend"
  DATABASE_URL="$PM2_DB" "$PRISMA" migrate deploy
else
  DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | sed 's/^"//;s/"$//')"
  export DATABASE_URL
  "$PRISMA" migrate deploy
fi

echo "==> [3/4] restart pm2 (backend / copy-worker / smart-money-worker)"
pm2 restart backend --update-env || pm2 start dist/src/server.js --name backend --node-args="--env-file=.env"
pm2 restart copy-worker --update-env || pm2 start dist/src/entry/copyWorker.js --name copy-worker --node-args="--env-file=.env"
# 聪明钱独立 worker（若未创建则创建）
if pm2 describe smart-money-worker >/dev/null 2>&1; then
  pm2 restart smart-money-worker --update-env
else
  pm2 start dist/src/entry/smartMoneyWorker.js --name smart-money-worker --node-args="--env-file=.env" || \
  pm2 start npm --name smart-money-worker -- run start:smart-money-worker || true
fi
pm2 save || true

echo "==> [4/4] quick health"
sleep 2
pm2 ls || true
echo "DONE. Next: run test commands from release notes."
