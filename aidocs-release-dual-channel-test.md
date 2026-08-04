# 榜单双通道 + Gate 增量 — 测试服发布说明（Gate 临时 10 页）

| 项 | 内容 |
| --- | --- |
| 日期 | 2026-07-29 |
| 包 | `.deploy/polymarket-backend-deploy.tar.gz` |
| 默认测试 Gate | **10 页**（验收后改回 30） |

---

## 1. 本机已打好包

归档路径（打包完成后看控制台最新路径）：

- `polymarket-backend/.deploy/polymarket-backend-deploy.tar.gz`（latest）
- `polymarket-backend/.deploy/polymarket-backend-deploy-YYYYMMDD-HHMMSS.tar.gz`

上传到测试服（按你实际 SSH 改）：

```bash
# 本机 PowerShell / Git Bash 示例
scp -P 443 .deploy/polymarket-backend-deploy.tar.gz root@158.247.195.229:~/
```

---

## 2. 测试服：解压 + 一键配置/迁移/重启（整段复制）

> 把 `APP_DIR` 换成你服务器真实目录（常见 `/root/polymarket-backend` 或 `/www/wwwroot/polycopy-backend/current`）。

```bash
# ===== 测试服 SSH 后整段粘贴 =====
set -euo pipefail
APP_DIR="${APP_DIR:-/root/polymarket-backend}"
ARCHIVE="$HOME/polymarket-backend-deploy.tar.gz"

# 解压到临时目录再 rsync（保留 .env / node_modules）
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$ARCHIVE" -C "$STAGE" -m --no-same-owner --no-same-permissions
mkdir -p "$APP_DIR"
rsync -a --delete --no-perms --no-owner --no-group -O --no-times \
  --exclude='.env' --exclude='node_modules/' \
  "$STAGE/" "$APP_DIR/"
cd "$APP_DIR"

# 依赖（package.json 变了才需要；强制可加）
if [[ ! -x node_modules/.bin/prisma ]]; then
  npm install --omit=dev
fi

# 一键：写 dual-channel env（Gate=10）+ migrate + pm2 重启
chmod +x scripts/patch-smart-money-dual-channel-env.sh scripts/apply-dual-channel-test-release.sh
GATE_PAGES=10 DAILY_TOP_N=100 sh scripts/apply-dual-channel-test-release.sh
```

**不要手改 .env。** 脚本会自动 upsert 下列键（并备份 `.env.bak.dual-channel.*`）：

- `SMART_MONEY_CLOSED_GATE_MAX_PAGES=10`（测试临时）
- `SMART_MONEY_COPY_POOL_RESCORE_MODE=dual_channel`
- `SMART_MONEY_COPY_POOL_DAILY_TOP_N=100`
- `SMART_MONEY_CLOSED_INCREMENTAL_ENABLED=true`
- Gate/Full TTL、增量、SLA cron、近似 rank、QUALIFIED 保底份额等

---

## 3. 验收后把 Gate 改回 30（整段）

```bash
cd "${APP_DIR:-/root/polymarket-backend}"
GATE_PAGES=30 sh scripts/apply-dual-channel-test-release.sh
```

---

## 4. 测试命令（部署完成后）

### 4.1 进程与配置

```bash
cd "${APP_DIR:-/root/polymarket-backend}"
pm2 ls
grep -E '^(SMART_MONEY_CLOSED_GATE_MAX_PAGES|SMART_MONEY_COPY_POOL_RESCORE_MODE|SMART_MONEY_COPY_POOL_DAILY_TOP_N|SMART_MONEY_CLOSED_INCREMENTAL_ENABLED)=' .env
```

### 4.2 管道水位（内部 API）

```bash
# 若有 COPY_INTERNAL_SECRET：
curl -sS -H "x-copy-internal-secret: $COPY_INTERNAL_SECRET" \
  http://127.0.0.1:3000/api/internal/smart-money/pipeline/stats | head -c 4000; echo
```

关注字段：

- `copyPoolRescoreMode` = `dual_channel`
- `copyPoolDailyTopN` = `100`
- `copyPoolPriorityDue`（今日 TopN 未完成数，应逐渐降到 0）
- `copyPoolBackgroundEligible`
- `closedIncrementalHitRate` / `closedFullRebuild`
- `copyPoolSlaBreachedToday`

### 4.3 TopN 诊断 SQL

```bash
cd "${APP_DIR:-/root/polymarket-backend}"
set -a; . ./.env; set +a
psql "$DATABASE_URL" -f scripts/diagnose-top100-rescore.sql
```

### 4.4 日志

```bash
pm2 logs smart-money-worker --lines 80
pm2 logs backend --lines 40
# 关键字：
#   smart-money-copy-pool-sla
#   closed-prefetch
#   dual / Gate
```

### 4.5 回滚复评模式（出问题立刻）

```bash
cd "${APP_DIR:-/root/polymarket-backend}"
# 仅切回旧分层冷却，其它配置保留
ENV_FILE=.env
cp -a "$ENV_FILE" "${ENV_FILE}.bak.rollback.$(date +%Y%m%d%H%M%S)"
grep -v '^SMART_MONEY_COPY_POOL_RESCORE_MODE=' "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
echo 'SMART_MONEY_COPY_POOL_RESCORE_MODE=legacy_tiered' >> "$ENV_FILE"
pm2 restart backend smart-money-worker --update-env || pm2 restart backend --update-env
pm2 save
```

---

## 5. 迁移说明

本次含迁移：`20260729120000_closed_snapshot_incremental_fields`  
（`newestClosedAt` / `oldestClosedAt` / `incrementalEpoch` / `lastIncrementalAt`）  
由 `apply-dual-channel-test-release.sh` 里的 `prisma migrate deploy` 自动执行。
