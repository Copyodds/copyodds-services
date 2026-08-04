# Admin 办公室 IP 白名单部署（Vercel 前端 + 腾讯云后端）

Admin 前端托管在 **Vercel**；`polymarket-backend`（Node）与 `polymarket-admin-api`（Go）在 **海外腾讯云** 同机。通过 Nginx 对 `api.*` 的 `/api/admin/` 做办公室 IP 白名单，并将流量反代到仅监听本机的 Go 服务。

产品对接说明仍见 [admin-frontend-separate-repo.md](./admin-frontend-separate-repo.md)。

---

## 架构

| 组件 | 位置 |
|------|------|
| Admin 前端 | Vercel（如 `admin.example.com`） |
| 用户 API + Admin API 入口 | 腾讯云 Nginx → `api.example.com` |
| polymarket-admin-api | `127.0.0.1:8081`（不对公网） |
| polymarket-backend | `127.0.0.1:PORT`（如 3000） |

浏览器从 Vercel 发起 `fetch(api.example.com/api/admin/...)` 时，Nginx 校验的是**办公室网络的出口 IP**，不是 Vercel 边缘 IP。

仓库内模板：

- Nginx 白名单片段：[`deploy/nginx/snippets/admin-office-allow.conf.example`](../deploy/nginx/snippets/admin-office-allow.conf.example)
- Nginx `location`：[`deploy/nginx/api-admin-location.conf.example`](../deploy/nginx/api-admin-location.conf.example)
- 安装脚本：[`deploy/nginx/install-admin-ip-whitelist.sh`](../deploy/nginx/install-admin-ip-whitelist.sh)
- 可选 Vercel Middleware：[`deploy/vercel/middleware.ts.example`](../deploy/vercel/middleware.ts.example)

---

## 1. 收集办公室出口 IP

在办公室网络执行：

```bash
curl -s ifconfig.me
```

记录 IPv4。**不要把真实 IP 提交进 Git**；只写在服务器上的 `/etc/nginx/snippets/admin-office-allow.conf`。

安装片段模板：

```bash
sudo bash deploy/nginx/install-admin-ip-whitelist.sh
sudo nano /etc/nginx/snippets/admin-office-allow.conf
```

示例（在 `deny all;` 之前添加 `allow`）：

```nginx
allow 203.0.113.10;
allow 198.51.100.5;
deny all;
```

---

## 2. admin-api 仅监听本机（腾讯云）

编辑服务器上 `polymarket-admin-api/.env`：

```bash
ADDR=127.0.0.1:8081
```

```bash
cd /path/to/polymarket-admin-api
./scripts/server.sh restart
```

验证：

```bash
curl -s http://127.0.0.1:8081/health
# 期望: {"ok":true}

curl -s --connect-timeout 3 http://<腾讯云公网IP>:8081/health
# 期望: 连接失败或超时
```

---

## 3. 腾讯云安全组

**控制台 → 云服务器 → 安全组 → 入站规则**

| 动作 | 协议端口 | 来源 | 说明 |
|------|----------|------|------|
| 允许 | TCP 80, 443 | `0.0.0.0/0` | 公网 API |
| 允许 | TCP 22（或自定义 SSH） | 办公室 IP | 不要用 `0.0.0.0/0` |
| 拒绝/不开放 | TCP 8081 | — | admin-api |
| 拒绝/不开放 | TCP 5432, 6379 | — | Postgres / Redis 仅本机 |

若启用 `ufw`，规则与安全组保持一致。

---

## 4. Nginx：api 站点挡 `/api/admin/`

在 `api.example.com` 的 `server` 块中，**放在** `location /api/` 之前，粘贴 [`api-admin-location.conf.example`](../deploy/nginx/api-admin-location.conf.example) 内容。

**宝塔**：站点 → 配置文件 → 插入 `location /api/admin/` → 保存 → 重载 Nginx。

```bash
sudo nginx -t && sudo nginx -s reload
```

**Cloudflare 注意**：若 api 域名经 CF 代理，需配置 `set_real_ip_from` + `real_ip_header CF-Connecting-IP`，否则 `allow/deny` 看到的是 CF 节点 IP。api 直连腾讯云时可忽略。

---

## 5. 环境变量

### 5.1 polymarket-admin-api（腾讯云 `.env`）

```bash
ADDR=127.0.0.1:8081

# Vercel 生产域名，精确匹配（含 https://，无尾部斜杠）
CORS_ALLOWED_ORIGINS=https://admin.example.com

ADMIN_SESSION_COOKIE_SECURE=true
ADMIN_SESSION_COOKIE_SAME_SITE=none
# api 与 admin 同属 example.com 子域：
ADMIN_SESSION_COOKIE_DOMAIN=.example.com
# admin 仅在 vercel.app、api 在自有域时留空

MAIN_BACKEND_BASE_URL=http://127.0.0.1:3000
COPY_INTERNAL_SECRET=<与 backend 一致>

# 首账号创建后必须清空
ADMIN_BOOTSTRAP_KEY=
```

重启：`./scripts/server.sh restart`

### 5.2 Vercel（Admin 前端项目）

Production 环境变量：

```bash
NEXT_PUBLIC_API_BASE=https://api.example.com
```

可选（启用 Middleware 时）：

```bash
ADMIN_OFFICE_IPS=203.0.113.10,198.51.100.5
```

修改后 **Redeploy** 生产部署。

### 5.3 polymarket-backend（腾讯云 `.env`）

- `CORS_ALLOWED_ORIGINS`：用户前台域名（不含 Admin）
- `COPY_INTERNAL_SECRET`、`ADMIN_SESSION_COOKIE_NAME` 与 admin-api 一致
- `TRUST_PROXY=1`（Nginx 反代时）

```bash
pm2 restart backend --update-env
```

---

## 6. Bootstrap（仅首次）

1. 在办公室 IP 下，临时设置 `ADMIN_BOOTSTRAP_KEY`（强随机字符串）。
2. 调用一次：

```bash
curl -X POST "https://api.example.com/api/admin/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Bootstrap-Key: <your-key>" \
  -d '{"email":"ops@example.com","password":"<strong-password>"}'
```

3. **立即清空** `ADMIN_BOOTSTRAP_KEY` 并 `./scripts/server.sh restart`。
4. 日常登录：`POST /api/admin/auth/login`（受 Nginx IP 白名单保护）。

---

## 7. 可选：Vercel Middleware 挡登录页

将 [`deploy/vercel/middleware.ts.example`](../deploy/vercel/middleware.ts.example) 复制到 Admin 前端仓库根目录为 `middleware.ts`，并设置 `ADMIN_OFFICE_IPS`。

未启用时，公网仍可见登录 UI，但无法调用 Admin API。

---

## 8. 验收清单

| 场景 | 期望 |
|------|------|
| 办公室 IP 打开 Vercel Admin | 200 |
| 办公室 IP 登录 | 成功，`Set-Cookie: admin_session` |
| 办公室 IP `GET /api/admin/auth/me` | `code: 0` |
| 非办公室 IP `POST /api/admin/auth/login` | **403**（Nginx） |
| 非办公室 IP 用户 API `GET /api/health` | 正常 |
| 公网直连 `:8081` | 失败 |

### 自动化验收（办公室网络下执行）

```powershell
# 应在办公室 IP 下运行（白名单内）
.\scripts\verifyAdminIpWhitelist.ps1 -BaseUrl "https://api.example.com" -AdminOrigin "https://admin.example.com"

# 模拟非办公室：若你有第二出口或手机热点（白名单外）
.\scripts\verifyAdminIpWhitelist.ps1 -BaseUrl "https://api.example.com" -ExpectAdminBlocked
```

---

## 9. 办公室 IP 变更

1. 新网络：`curl -s ifconfig.me`
2. 编辑 `/etc/nginx/snippets/admin-office-allow.conf`
3. `nginx -t && nginx -s reload`
4. 若启用 Vercel Middleware：更新 `ADMIN_OFFICE_IPS` 并 Redeploy
5. 验证登录与 `auth/me`

---

## 10. 后续升级

办公室 IP 频繁变更时：

1. **Tailscale**：Nginx 白名单改为 `100.64.0.0/10`
2. **Cloudflare Access**：替代手改 IP
3. admin-api 登录限流、管理员 2FA（见 [production-launch-checklist.md](./production-launch-checklist.md)）

---

## 风险摘要

| 项 | 说明 |
|----|------|
| IP 变更 | 换网需改 Nginx；Vercel Middleware 同步更新 |
| Vercel 预览 | 勿将 `*.vercel.app` 写入生产 `CORS_ALLOWED_ORIGINS` |
| 跨域 Cookie | 必须 HTTPS + `SameSite=none` + `Secure=true` |
| Node `/api/admin` | 外部流量应经 Nginx 走 Go；Node 路由勿再对外暴露 |
