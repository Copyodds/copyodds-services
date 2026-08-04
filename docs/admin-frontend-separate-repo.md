# 独立 Admin 前端仓库对接说明

本文面向**单独仓库**实现的运营后台（Admin Console），说明如何对接本仓库中的 **`polymarket-backend`**，不依赖本 monorepo 内任何前端工程。

产品边界与 MVP 验收仍以 [independent-admin-system-requirements.md](./independent-admin-system-requirements.md) 为准；README 中长期能力见 [admin-phase3-roadmap.md](./admin-phase3-roadmap.md)。

---

## 1. 架构约定

| 项目 | 说明 |
|------|------|
| 后端 | **`polymarket-admin-api`（Go）**，HTTP 前缀 **`/api/admin`**；由腾讯云 Nginx 反代到 `127.0.0.1:8081` |
| 前端 | **Vercel** 独立部署（如 `admin.example.com`），**不使用**普通用户 JWT / 前台 `AuthProvider` |
| 鉴权 | 管理员通过 **`POST /api/admin/auth/login`** 建立会话；浏览器需对 API 域名携带 **Cookie**（`credentials: 'include'`） |
| 生产安全 | 办公室 IP 白名单见 [admin-ip-whitelist-deploy.md](./admin-ip-whitelist-deploy.md) |

后端已启用 CORS：`origin: true`、`credentials: true`（见 `src/server.ts`），便于本地 Admin（如 `localhost:3010`）请求远端 API（如 `localhost:3000`）。

---

## 2. 环境变量（独立 Admin 工程）

在 Admin 前端配置（示例名）：

```bash
# polymarket-backend 对外可访问的 origin，无尾部斜杠
NEXT_PUBLIC_API_BASE=https://api.your-domain.com
# 本地开发示例
# NEXT_PUBLIC_API_BASE=http://localhost:3000
```

Vercel Production 环境变量同上；修改后需 Redeploy。

可选：挡公网访问登录页时，复制 [`deploy/vercel/middleware.ts.example`](../deploy/vercel/middleware.ts.example) 为 Admin 仓库根目录 `middleware.ts`，并设置 `ADMIN_OFFICE_IPS`（逗号分隔办公室出口 IP）。

所有请求发往：`${NEXT_PUBLIC_API_BASE}/api/admin/...`。

登录成功后，`Set-Cookie` 由 **API 所在域名** 下发；后续 `fetch` 必须 **`credentials: 'include'`** 且目标为同一 API origin，Cookie 才会随跨站请求发送（浏览器对 `localhost` 不同端口视为不同源，但向 API 端口发请求时仍会带上该 API 域下的 Cookie）。

Cookie 名默认 **`admin_session`**（可用环境变量 `ADMIN_SESSION_COOKIE_NAME` 覆盖，需与后端一致）。

---

## 3. 统一响应格式

成功：

```json
{ "code": 0, "data": { } }
```

失败：

```json
{ "code": 40001, "data": { "message": "...", "details": { } } }
```

`code === 0` 表示成功；非 0 为业务/鉴权错误。

---

## 4. 认证相关

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/admin/auth/login` | Body: `{ "email", "password" }`；成功则 Set-Cookie |
| `GET` | `/api/admin/auth/me` | 需 Cookie；返回当前管理员 |
| `POST` | `/api/admin/auth/logout` | 需 Cookie；清除会话 |
| `POST` | `/api/admin/auth/bootstrap` | 仅当配置 `ADMIN_BOOTSTRAP_KEY` 且请求头 `X-Admin-Bootstrap-Key` 匹配时创建首个管理员，**勿对公网开放** |

---

## 5. 业务接口清单（均需管理员会话）

以下路径均相对于 **`/api/admin`**（完整 URL 为 `{API_BASE}/api/admin/...`）。

### 5.1 仪表盘

| 方法 | 路径 |
|------|------|
| `GET` | `/dashboard/summary` |

### 5.2 交易 / 风控 / 账务 / 审计

| 方法 | 路径 |
|------|------|
| `GET` | `/trading/system-control` |
| `PATCH` | `/trading/system-control` |
| `GET` | `/trading/leader-risk` |
| `PATCH` | `/trading/leader-risk/:id` |
| `GET` | `/trading/audit-events` |
| `GET` | `/trading/risk-events` |
| `GET` | `/trading/billing-ledger` |
| `GET` | `/trading/billing-reconcile` |

### 5.3 用户

| 方法 | 路径 |
|------|------|
| `GET` | `/users` |
| `GET` | `/users/automation-grants`（**须注册在** `/users/:id` **之前**的路由匹配逻辑中，由后端保证） |
| `GET` | `/users/:id` |
| `PATCH` | `/users/:id/affiliate-tier` |
| `PATCH` | `/users/:id/trading-restriction` |

### 5.4 跟单

| 方法 | 路径 |
|------|------|
| `GET` | `/copy-trade/leaders` |
| `PATCH` | `/copy-trade/leaders/:id/status` |
| `GET` | `/copy-trade/subscriptions` |
| `PATCH` | `/copy-trade/subscriptions/:id/status` |
| `GET` | `/copy-trade/executions` |

### 5.5 Gas / 套餐 / 佣金

| 方法 | 路径 |
|------|------|
| `GET` | `/gas/orders` |
| `GET` | `/gas-packages/orders` |
| `GET` | `/gas-packages` |
| `POST` | `/gas-packages` |
| `POST` | `/gas-packages/orders/:id/confirm` |
| `POST` | `/gas-packages/orders/:id/fulfill` |
| `GET` | `/commissions` |

### 5.6 Smart Money / 排行榜

| 方法 | 路径 |
|------|------|
| `GET` | `/leaderboards/official-cached` |
| `GET` | `/leaderboards/external-cached` |
| `GET` | `/smart-money/leaderboard` |
| `GET` | `/smart-money/traders` |
| `PATCH` | `/smart-money/traders/:wallet/status` |
| `PATCH` | `/smart-money/traders/:wallet/blacklist` |
| `GET` | `/smart-money/traders/:wallet/risk-profile` |

---

## 6. 前端实现要点（Checklist）

1. **登录页**：`POST /api/admin/auth/login`，成功后跳转首页。
2. **路由守卫**：进入受保护页前请求 `GET /api/admin/auth/me`；若 `401` 或未登录则跳转登录页。
3. **全局 `fetch` / HTTP 客户端**：对 `/api/admin/**` 默认 `credentials: 'include'`，`Content-Type: application/json`（有 body 时）。
4. **退出**：`POST /api/admin/auth/logout` 后清除本地状态并回登录页。
5. **生产环境 Cookie**：Admin（Vercel）与 API（腾讯云）为跨站，须 `ADMIN_SESSION_COOKIE_SECURE=true`、`ADMIN_SESSION_COOKIE_SAME_SITE=none`（见 `polymarket-admin-api/.env.example` 与 [admin-ip-whitelist-deploy.md](./admin-ip-whitelist-deploy.md)）。

---

## 7. 本地联调示例

1. 启动 `polymarket-backend`（默认监听 `PORT`，未设置时多为 `3000`）。
2. 在独立 Admin 仓库设 `NEXT_PUBLIC_API_BASE=http://localhost:3000`，Admin 自身运行在另一端口（如 `3010`）。
3. 使用 `seed:admin` 或 `bootstrap` 接口创建管理员后登录（见后端 `package.json` 与 `docs`）。

---

## 8. 代码参考位置

管理后台 HTTP 已迁至 **`polymarket-admin-api`（Go）**，本仓库不再包含 `src/routes/admin`。实现 UI 或脚本时以 Go 服务的路由与校验为准；环境变量与主后端共用 `DATABASE_URL` 及 `ADMIN_*`（见该目录下 `.env.example`）。

主后端仍保留：`POST /api/auth/admin/affiliate/tier`（`X-Admin-Key` + `ADMIN_KEY`）用于推广档位等内部操作；交易审计写入见 `polymarket-backend/src/services/audit/events.ts`。
