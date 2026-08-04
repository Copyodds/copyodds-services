# 推荐上线清单

上线前按本清单逐项检查与实施，确保环境、安全、部署与可观测性就绪。

---

## 1. 环境变量与配置

- [ ] **补全 `.env.example`**  
  确保包含并说明所有生产必填项：
  - `DATABASE_URL` — Postgres 连接串
  - `JWT_SECRET` — JWT 签名密钥（建议 32+ 位随机字符串）
  - `API_KEY` — 仅用于少数服务端共享密钥校验，不再作为浏览器写接口主安全边界
  - `RPC_URL`、`PRIVATE_KEY`、`CHAIN_ID` — 若使用链上/钱包功能
  - `PORT`、`JWT_EXPIRES_IN` — 可选

- [ ] **启动时强制校验**  
  在 `src/config/env.ts` 中，生产环境（如 `NODE_ENV=production`）下，缺以下任一项则 **进程退出**，不启动服务：
  - `DATABASE_URL`
  - `JWT_SECRET`
  - `API_KEY`
  - （若使用链上功能）`RPC_URL`、`PRIVATE_KEY`

- [ ] **生产环境不提交 `.env`**  
  确认 `.gitignore` 已包含 `.env`，生产环境通过部署平台/密钥管理注入变量。

---

## 2. 安全

- [ ] **限制 CORS**  
  将 `app.use(cors())` 改为仅允许前端域名，例如通过环境变量 `CORS_ALLOWED_ORIGINS` 配置允许的 origin 列表；生产环境应拒绝未命中白名单的 `Origin`。

- [ ] **设置 trust proxy**  
  若后端部署在 Nginx、Cloudflare、API Gateway 等反向代理之后，请显式配置 `TRUST_PROXY`，否则基于 `req.ip` 的限流与审计会失真。

- [ ] **重新定义 API Key 边界**  
  浏览器公开值不再承担交易、资金、管理类接口的主安全职责；公开读接口走 `CORS + 限流`，用户写接口走 JWT / session，webhook 和 internal 路由继续使用服务端共享密钥。

- [ ] **错误信息不泄露内部细节**  
  生产环境不向客户端返回 `err.stack` 或内部错误详情，仅返回通用错误信息。

- [ ] **（可选）安全头**  
  使用 `helmet` 等中间件增加安全响应头；第一版至少启用默认安全头，并确认不会影响现有前端资源加载。

---

## 3. 启动与运行方式

- [ ] **生产使用编译后的 Node 运行**  
  - 本地构建：`npm run build`
  - 纯发布产物目录：`npm run build:deploy`
  - 直接运行编译结果：`npm run start:prod`（实际入口：`dist/src/server.js`）
  - 若希望像前端 `out/` 一样只上传一个后端目录，则上传 `deploy/`

- [ ] **后端发布目录部署步骤**  
  - 在本地执行：`npm run build:deploy`
  - 服务器只上传 `deploy/` 目录
  - 进入 `deploy/` 后执行：`npm install --omit=dev`
  - `deploy/` 内已包含 `prisma.config.ts` 与 `prisma/migrations/`
  - 如目标环境需要迁移数据库，再执行：`npm run migrate:deploy`
  - 启动：`npm start`

- [ ] **设置 NODE_ENV**  
  生产环境设置 `NODE_ENV=production`。

---

## 4. 数据库

- [ ] **上线前执行迁移**  
  在目标环境执行：`npx prisma migrate deploy`，确保生产库 schema 与当前 `prisma/schema.prisma` 一致。

- [ ] **启动时检查数据库连通性**  
  启动时做一次简单 DB 查询（如 `prisma.$queryRaw('SELECT 1')`）或健康检查中校验；失败则打日志并退出，便于部署时立刻发现问题。

---

## 5. 健康检查与运维

- [ ] **深度健康检查（可选）**  
  增加如 `/health/ready` 端点：检查 DB 连通、可选检查 RPC 可达性，供负载均衡/编排器判断实例是否可接收流量；保留现有 `/health` 作为简单存活探测。

- [ ] **优雅停机**  
  监听 `SIGTERM` / `SIGINT`，摘除 readiness、停止接收新请求、关闭 cron 定时器并等待 HTTP 连接自然结束。

- [ ] **结构化日志**  
  生产环境使用 pino/winston 等结构化日志，便于收集到 ELK/Loki 等。

- [ ] **请求日志**  
  使用 morgan 或自定义中间件记录请求 method、path、status、耗时，便于排查问题。

---

## 6. 限流与防护

- [ ] **接口限流**  
  为 `/api/auth/*`、`/api/admin/auth/*`、`/api/webhooks/custody-ledger-topup`、`/api/internal/copy-trade/leader-signal`、`/api/markets`、`/api/polymarket/leaderboard*`、`/api/wallet/balance/:address`、`/api/wallet/assets/:address` 等入口增加限流，优先按 IP 或 `IP + 共享密钥` 组合限制请求频率。

- [ ] **高价值写接口限流**  
  为 `/api/trade/*`、`/api/custody/*`、`/api/copy-trade/*`、`/api/gas-packages/*`、`/api/wallet/gas/*`、`/api/polymarket/auth`、`/api/trading-connections/*` 等写接口按 `userId` 或 `userId + X-API-KEY` 增加独立配额，避免公开读接口挤占写接口额度。

- [ ] **共享 Redis 计数**  
  限流应使用共享 Redis 而不是单进程内存桶，确保多实例下计数一致；若 Redis 短暂不可用，应明确降级策略并输出结构化日志。

- [ ] **webhook / internal 双重保护**  
  `webhook` 与内部路由不能只靠限流，仍需保留 `X-Custody-Payment-Secret`、`X-Internal-Secret` 等共享密钥校验。

- [ ] **限流日志与观测**  
  至少记录来源 IP、命中的限流器名称、请求路由、状态码、时间窗口与重试等待时间，便于后续接入边缘层限流或 WAF。

- [ ] **边缘层防护**  
  在 Nginx / Cloudflare / API Gateway 层补充全站速率限制；管理后台入口建议增加独立域名或 IP 白名单，支付回调建议叠加来源 IP 白名单。Vercel Admin + 腾讯云部署见 [admin-ip-whitelist-deploy.md](./admin-ip-whitelist-deploy.md)。

---

## 7. 部署与容器化

- [ ] **Dockerfile（若使用容器）**  
  - 多阶段构建：先 `npm run build:deploy`，再只保留 `deploy/` 内的运行时文件。
  - 运行命令：`node dist/src/server.js` 或 `npm start`。
  - 通过环境变量注入 `DATABASE_URL`、`JWT_SECRET`、`API_KEY` 等，不在镜像中写死。

- [ ] **.dockerignore**  
  排除 `node_modules`、`.env`、测试与文档等，减小镜像体积并降低敏感信息泄露风险。

---

## 8. 测试与质量

- [ ] **核心路径测试**  
  至少覆盖注册/登录、JWT 写接口、`/api/health/ready`、custody webhook、至少一条 trade/copy-trade 路径，并断言一个稳定业务错误码和一个内部 5xx 收口。

- [ ] **运行最小安全回归脚本**  
  可使用 `npm run smoke:security`（底层调用 `scripts/verifySecurityHardening.ps1`）对登录、管理登录、公开读接口、webhook/internal 入口、`/api/health/ready` 和 CORS 白名单做最小回归验证。

---

## 9. 上线前最终确认

- [ ] 所有上述与环境、安全、限流、日志相关的项已落实。
- [ ] 生产环境变量已在部署平台配置且无误。
- [ ] 数据库迁移已在生产库执行成功。
- [ ] 使用 `NODE_ENV=production` 与 `npm start`（基于 `deploy/`）或 `npm run start:prod` 启动。
- [ ] 前端已配置正确的 API 基地址；若仍保留 `NEXT_PUBLIC_API_KEY`，仅用于低风险公开读接口。

---

*文档版本：1.0 | 与项目当前结构对应*
