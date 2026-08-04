#!/usr/bin/env bash
# ------------------------------------------------------------
# polymarket-backend → 测试服一键部署
# 1. npm run build:deploy 生成 deploy/ 目录并打成 tar.gz
# 2. scp 上传到远端 ~/polymarket-backend-deploy.tar.gz
# 3. ssh 解压到站点目录，仅在 package.json 变更时 npm install、可选 migrate、pm2
#
# 用法:
#   ./scripts/deploy-test.sh
#   ./scripts/deploy-test.sh --build-only
#   ./scripts/deploy-test.sh -k ~/.ssh/id_ed25519
# ------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BACKEND_ROOT"

########## 可配置区域 ##########
# tr -d 去掉 CRLF 中的 CR，避免远端路径出现 \#015
SSH_HOST="$(echo "${DEPLOY_SSH_HOST:-root@158.247.195.229}" | tr -d '\r')"
SSH_PORT="$(echo "${DEPLOY_SSH_PORT:-443}" | tr -d '\r')"
REMOTE_APP_DIR="$(echo "${DEPLOY_REMOTE_APP_DIR:-/www/wwwroot/polycopy-backend/current}" | tr -d '\r')"
REMOTE_APP_DIR="${REMOTE_APP_DIR%/}"
SP=""
if [[ "${DEPLOY_REMOTE_USE_SUDO:-0}" == "1" ]]; then SP="sudo "; fi
CHOWN_AFTER="$(echo "${DEPLOY_REMOTE_CHOWN_AFTER:-}" | tr -d '\r')"

# 默认私钥：优先 id_ed25519，其次 id_rsa（可用 -k 或 DEPLOY_SSH_KEY 覆盖）
REMOTE_ARCHIVE_NAME="polymarket-backend-deploy.tar.gz"

RUN_MIGRATE="${DEPLOY_RUN_MIGRATE:-1}"

# DEPLOY_PROCESS_MANAGER=systemd 时走 systemctl（需 root 预装 unit + deploy 用户 sudo 重启权限）
DEPLOY_PROCESS_MANAGER="${DEPLOY_PROCESS_MANAGER:-pm2}"
if [[ "$DEPLOY_PROCESS_MANAGER" == "systemd" ]]; then
  REMOTE_RESTART_CMD="${DEPLOY_REMOTE_RESTART_CMD:-sudo systemctl restart polymarket-backend polymarket-copy-worker}"
else
  REMOTE_RESTART_CMD="${DEPLOY_REMOTE_RESTART_CMD:-pm2 restart backend --update-env || pm2 start dist/src/server.js --name backend --node-args=\"--env-file=.env\"; pm2 restart copy-worker --update-env || pm2 start dist/src/entry/copyWorker.js --name copy-worker --node-args=\"--env-file=.env\"; pm2 save}"
fi

################################

usage() {
  cat <<EOF
用法: $(basename "$0") [--build-only] [-k <keyfile>]

  --build-only    只在本机 build:deploy 并打包到 .deploy/，不上传
  -k <keyfile>    SSH 私钥路径

环境变量（可选）:
  DEPLOY_SSH_HOST            SSH 目标，默认 admin@test
  DEPLOY_SSH_PORT            SSH 端口，默认 443
  DEPLOY_REMOTE_APP_DIR      解压目录，默认 /www/wwwroot/polycopy-backend/deploy/deploy
  DEPLOY_SSH_KEY             私钥路径
  DEPLOY_RUN_MIGRATE=0|1     是否远端 migrate deploy
  DEPLOY_SKIP_NPM_INSTALL=1  强制跳过 npm install
  DEPLOY_FORCE_NPM_INSTALL=1 强制 npm install --omit=dev
  DEPLOY_AUTO_RESOLVE_FAILED_MIGRATIONS=0|1  默认 1；P3009 时 resolve 并重试
  DEPLOY_REMOTE_RESTART_CMD  远端重启命令
  DEPLOY_PROCESS_MANAGER     pm2（默认）或 systemd
  DEPLOY_REMOTE_USE_SUDO=1   站点属主为 www 时 mkdir/rsync 用 sudo
  DEPLOY_REMOTE_CHOWN_AFTER  例 admin:www  rsync 后 chown

当前: SSH_HOST=$SSH_HOST  REMOTE_APP_DIR=$REMOTE_APP_DIR
EOF
  exit 1
}

BUILD_ONLY=0
KEYFILE_FROM_ARG=""
while (( $# )); do
  case "$1" in
    --build-only) BUILD_ONLY=1; shift ;;
    -k) KEYFILE_FROM_ARG="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "未知选项: $1" >&2; usage ;;
  esac
done

ARCHIVE_DIR="$BACKEND_ROOT/.deploy"
mkdir -p "$ARCHIVE_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOCAL_ARCHIVE="$ARCHIVE_DIR/polymarket-backend-deploy-${STAMP}.tar.gz"
LOCAL_ARCHIVE_LATEST="$ARCHIVE_DIR/$REMOTE_ARCHIVE_NAME"

echo "► 构建 deploy 包 (build:deploy)…"
npm run build:deploy

if [[ ! -d "$BACKEND_ROOT/deploy" ]]; then
  echo "❌ 未找到 deploy/ 目录，build:deploy 是否成功？" >&2
  exit 3
fi

echo "► 打包 → $LOCAL_ARCHIVE"
tar -czf "$LOCAL_ARCHIVE" -C "$BACKEND_ROOT/deploy" .
cp -f "$LOCAL_ARCHIVE" "$LOCAL_ARCHIVE_LATEST"

echo "► 本地归档（最新）: $LOCAL_ARCHIVE_LATEST"
[[ $BUILD_ONLY -eq 1 ]] && { echo "✅ --build-only 完成，未上传"; exit 0; }

if [[ -n "$KEYFILE_FROM_ARG" ]]; then
  KEYFILE="$KEYFILE_FROM_ARG"
elif [[ -n "${DEPLOY_SSH_KEY:-}" && -f "$DEPLOY_SSH_KEY" ]]; then
  KEYFILE="$DEPLOY_SSH_KEY"
elif [[ -f "$HOME/.ssh/id_ed25519" ]]; then
  KEYFILE="$HOME/.ssh/id_ed25519"
elif [[ -f "$HOME/.ssh/id_rsa" ]]; then
  KEYFILE="$HOME/.ssh/id_rsa"
elif [[ -f "$HOME/.ssh/id_ecdsa" ]]; then
  KEYFILE="$HOME/.ssh/id_ecdsa"
elif [[ -f "$HOME/.ssh/test" ]]; then
  KEYFILE="$HOME/.ssh/test"
else
  echo "❌ 未找到 SSH 私钥。请将 id_ed25519、id_rsa、id_ecdsa 或 test 放在 ~/.ssh/，或设置 DEPLOY_SSH_KEY / -k" >&2
  exit 3
fi

[[ -f "$KEYFILE" ]] || { echo "❌ 找不到私钥: $KEYFILE" >&2; exit 3; }

echo "► 上传目标: $SSH_HOST:~/$REMOTE_ARCHIVE_NAME (port=$SSH_PORT)"
echo "► 解压目录: $REMOTE_APP_DIR"
echo "► 私钥: $KEYFILE"

if [[ -z ${SSH_AUTH_SOCK-} ]]; then
  eval "$(ssh-agent -s)"
  trap 'kill $SSH_AGENT_PID' EXIT
fi
FP=$(ssh-keygen -lf "$KEYFILE" | awk '{print $2}')
if ! ssh-add -l 2>/dev/null | grep -q "$FP"; then
  echo "► 请输入私钥口令（无口令可忽略；失败时再 ssh-add）"
  ssh-add "$KEYFILE"
fi

echo "► 上传 $REMOTE_ARCHIVE_NAME …"
scp -i "$KEYFILE" -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new -q "$LOCAL_ARCHIVE_LATEST" "$SSH_HOST:~/$REMOTE_ARCHIVE_NAME"

MIGRATE_PART=""
if [[ "$RUN_MIGRATE" == "1" ]]; then
  # IMPORTANT:
  # - prisma migrate deploy reads DATABASE_URL from env.
  # - pm2-managed apps may have DATABASE_URL set in pm2 env (not in .env on disk).
  # - If those differ, running migrations without pm2 env will migrate the wrong database.
  MIGRATE_PART='load_dotenv_if_present() { if [[ -f .env ]]; then local db_line; db_line="$(grep -m1 "^DATABASE_URL=" .env | cut -d= -f2- || true)"; db_line="${db_line%\"}"; db_line="${db_line#\"}"; db_line="${db_line%'\''}"; db_line="${db_line#'\''}"; if [[ -n "$db_line" ]]; then export DATABASE_URL="$db_line"; echo "[deploy-test] loaded DATABASE_URL from .env"; fi; fi; }; run_migrate_deploy() { if [[ -z "${DATABASE_URL:-}" ]]; then echo "[deploy-test] ERROR: DATABASE_URL is not set (pm2 env backend / .env)." >&2; exit 1; fi; if [[ ! -x node_modules/.bin/prisma ]]; then echo "[deploy-test] ERROR: prisma CLI missing after npm install" >&2; exit 1; fi; local prisma=./node_modules/.bin/prisma fail_log attempt failed; fail_log="$(mktemp)"; for attempt in 1 2; do if "$prisma" migrate deploy 2>"$fail_log"; then rm -f "$fail_log"; return 0; fi; cat "$fail_log" >&2; if [[ $attempt -eq 1 && "${DEPLOY_AUTO_RESOLVE_FAILED_MIGRATIONS:-1}" == "1" ]] && grep -q P3009 "$fail_log"; then failed="$(sed -n '\''s/.*`\([^`]*\)` migration started.*/\1/p'\'' "$fail_log" | head -1)"; if [[ -n "$failed" ]]; then echo "[deploy-test] P3009: migrate resolve --rolled-back $failed, then retry"; "$prisma" migrate resolve --rolled-back "$failed"; continue; fi; fi; rm -f "$fail_log"; exit 1; done; rm -f "$fail_log"; exit 1; }; PM2_DB="$(pm2 env backend 2>/dev/null | grep -m1 "^DATABASE_URL=" | cut -d= -f2- || true)"; if [[ -n "$PM2_DB" ]]; then echo "[deploy-test] migrate using pm2 DATABASE_URL"; DATABASE_URL="$PM2_DB" run_migrate_deploy; else load_dotenv_if_present; echo "[deploy-test] migrate using .env / shell DATABASE_URL"; run_migrate_deploy; fi && '
fi

echo "► 远端解压、安装依赖、重启…"
ssh -i "$KEYFILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -T "$SSH_HOST" bash -s <<EOS
set -euo pipefail
export DEPLOY_SKIP_NPM_INSTALL="${DEPLOY_SKIP_NPM_INSTALL:-}"
export DEPLOY_FORCE_NPM_INSTALL="${DEPLOY_FORCE_NPM_INSTALL:-}"
export DEPLOY_AUTO_RESOLVE_FAILED_MIGRATIONS="${DEPLOY_AUTO_RESOLVE_FAILED_MIGRATIONS:-1}"
# 宝塔/www 目录常为 www 属主，直接 tar 到站点路径会 chmod/utime 失败：
# 先解压到当前用户可写的 \$TMPDIR，再 rsync（不保留权限位）同步过去。
STAGE=\$(mktemp -d)
trap 'rm -rf "\$STAGE"' EXIT
${SP}mkdir -p $REMOTE_APP_DIR
tar -xzf \$HOME/$REMOTE_ARCHIVE_NAME -C "\$STAGE" -m --no-same-owner --no-same-permissions
if ! command -v rsync >/dev/null 2>&1; then
  echo "❌ 需要 rsync：yum install rsync 或 apt install rsync" >&2
  exit 1
fi
# --delete 会删掉目标里多出的文件；排除 .env 以免覆盖服务器环境变量
# -O/--omit-dir-times + --no-times：宝塔/www 下常无法 utime 目录或文件，避免 rsync code 23
PREV_PKG_HASH=""
if [[ -f "$REMOTE_APP_DIR/package.json" ]]; then
  PREV_PKG_HASH="\$(sha256sum "$REMOTE_APP_DIR/package.json" | awk '{print \$1}')"
fi
${SP}rsync -a --delete --no-perms --no-owner --no-group -O --no-times --exclude='.env' --exclude='node_modules/' "\$STAGE/" "$REMOTE_APP_DIR/"
if [[ -n "$CHOWN_AFTER" ]]; then
  ${SP}chown -R "$CHOWN_AFTER" "$REMOTE_APP_DIR"
fi
cd $REMOTE_APP_DIR
node_modules_ok() { [[ -x node_modules/.bin/prisma ]] && [[ -d node_modules/@prisma/client ]]; }
run_npm_install() {
  if npm install --omit=dev; then return 0; fi
  echo "[deploy-test] npm install failed, remove node_modules and retry once" >&2
  rm -rf node_modules
  npm install --omit=dev
}
ensure_npm_deps() {
  if [[ "\${DEPLOY_FORCE_NPM_INSTALL:-}" == "1" ]]; then
    echo "[deploy-test] npm install --omit=dev (DEPLOY_FORCE_NPM_INSTALL=1)"
    run_npm_install
    return
  fi
  if [[ "\${DEPLOY_SKIP_NPM_INSTALL:-}" == "1" ]]; then
    echo "[deploy-test] skip npm install (DEPLOY_SKIP_NPM_INSTALL=1)"
    return
  fi
  local new_hash
  new_hash="\$(sha256sum package.json | awk '{print \$1}')"
  if node_modules_ok && [[ "\$PREV_PKG_HASH" == "\$new_hash" ]]; then
    echo "[deploy-test] skip npm install (package.json unchanged, deps ok)"
    return
  fi
  if [[ ! -d node_modules ]]; then
    echo "[deploy-test] npm install --omit=dev (node_modules missing)"
  elif ! node_modules_ok; then
    echo "[deploy-test] npm install --omit=dev (node_modules incomplete)"
  else
    echo "[deploy-test] npm install --omit=dev (package.json changed)"
  fi
  run_npm_install
}
ensure_npm_deps
${MIGRATE_PART}${REMOTE_RESTART_CMD}
EOS

echo ""
echo "✅ 部署完成 → $SSH_HOST:$REMOTE_APP_DIR"
