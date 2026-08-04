# 测试服部署文档：API + Worker（链上监听改由 copy/ Go 服务）

本文档用于把 `polymarket-backend` 部署到测试服务器，并运行以下 2 个进程：

1. `backend`：HTTP API 服务
2. `copy-worker`：BullMQ 队列消费进程

## 1. 先说明清楚这 2 个进程分别做什么

### `backend`

启动命令：

```bash
node dist/src/server.js
```

作用：

- 提供 HTTP API
- 提供 `/health` 和 `/api/health`
- 依赖 Postgres
- 部分链上能力依赖 `RPC_URL`、`PRIVATE_KEY`

### 链上监听（不属于本仓库的 Node 进程）

链上监听由 Go 服务负责，Node 侧不直连链上，也不需要 `WS_URL`。当前有两种可选实现，发布的
NATS 事件结构与 subject 一致（默认 `polymarket.orders.watched`），下游链路相同：

1. `copy/`（WebSocket）：连接 Polygon WebSocket（如 Alchemy）做 pending/logs 订阅与解码。
2. `copy-block-listener`（扫块，仓库根目录 `copy-block-listener/`）：用 15 个 RPC URL 轮询
   `eth_getLogs` 扫描 Exchange 的 `OrderFilled`（约 1 秒一轮、单 Key 约 15 秒一次），
   解码后发布 `MatchedOrder`（带 `signal_source=block_scan`）。详见该目录 README。

两者共同点：

- 每 10-30 秒调用 backend internal watch-list API，同步 `CopyLeader.enabled=true` 且至少有一条
  enabled subscription 的 leader 地址集合
- 命中监视地址后通过 NATS 发布事件（默认 subject：`polymarket.orders.watched`）
- watch-list 同步失败时保留上一份成功集合，不清空、不停监

切换到扫块实现时：停掉 `copy/` WebSocket 进程，仅运行 `copy-block-listener`，避免同一笔成交
被双源重复发布（backend 幂等键 `(leaderAddress, txHash, logIndex)` 可兜底，但会增加噪音）。
`copy-block-listener` 的 `order_index` 使用链上 `logIndex`，与原 WebSocket 路径对同一成交得到相同
`signalId`，可被识别为同一事件。

### `copy-worker`

启动命令：

```bash
node dist/src/entry/copyWorker.js
```

作用：

- 消费上游信号触发后投递到 Redis / BullMQ 的任务
- 执行跟单 dispatch
- 定时 sweep 可重试失败任务

注意：

- `worker` 不对外提供端口
- 但必须能连接 Redis、Postgres，以及链上 RPC
- Redis、BullMQ 队列与 `copy-worker` 是跟单执行必要条件；NATS 只负责信号输入，不能替代 worker 队列

## 2. 服务器要准备什么

测试服至少准备以下基础组件：

- Node.js 20+，建议 Node.js 22 LTS
- npm
- PM2
- PostgreSQL
- Redis
- Git
- OpenSSH

建议机器最低配置：

- 2 vCPU
- 4 GB 内存
- 20 GB SSD

如果 API、`copy-worker` 与 Go `copy/` 监听都放同一台机器，以上配置够测试服使用。

## 3. 需要开放哪些端口

### 入站端口

通常只需要：

- `22`：SSH
- `8080` 或你的 API 端口：后端 HTTP API

如果前面挂 Nginx，可以只开放：

- `22`
- `80`
- `443`

### 出站访问

服务器必须可以访问：

- `Postgres`
- `Redis`
- `RPC_URL`
- Polymarket 相关 API

重点：

- `copy-worker` 依赖 `REDIS_URL`
- 如果 `copy-worker` 网络不通，进程会起来但无法正常工作

## 4. 必备环境变量

项目当前后端会读取 `.env`。测试服至少要准备下面这些变量。

### 核心必填

```env
NODE_ENV=production
PORT=8080

DATABASE_URL=postgresql://user:password@127.0.0.1:5432/polycopy_test
REDIS_URL=redis://127.0.0.1:6379

JWT_SECRET=replace-with-random-string
API_KEY=replace-with-random-string
CUSTODY_ENCRYPT_KEY=replace-with-long-random-string

RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/your-key
PRIVATE_KEY=your-private-key
CHAIN_ID=137
```

### 跟单相关建议配置

```env
COPY_DISPATCH_CONCURRENCY=20
COPY_DISPATCH_WORKER_CONCURRENCY=1
COPY_DISPATCH_QUEUE_SHARDS=4
COPY_RETRY_SWEEP_INTERVAL_MS=60000
COPY_MAX_RETRIES=5
COPY_INTERNAL_SECRET=replace-with-shared-internal-secret
```

链上 WebSocket 连接在仓库根目录 `copy/`（Go）的 `config/cfg.toml` 中配置；监视地址默认由 Go 服务调用 backend `GET /api/internal/copy-trade/watch-list` 同步，后端不再使用 `COPY_LISTENER_*` 环境变量。

Go `copy/` 侧需要配置：

```toml
[backend]
watch_list_url = "http://127.0.0.1:8080/api/internal/copy-trade/watch-list"
poll_interval_second = 15
```

并通过环境变量注入与 backend 相同的 `COPY_INTERNAL_SECRET`。

`apps/copytrade-messaging` 侧需要配置：

```env
COPYTRADE_BACKEND_BASE_URL=http://127.0.0.1:8080
COPYTRADE_BACKEND_INTERNAL_SECRET=replace-with-shared-internal-secret
COPYTRADE_EXECUTOR_ORDER_ENABLED=false
```

生产 Polymarket copy-trading 主路径由 backend `LeaderTrade + BullMQ + copy-worker` 执行；`executor-service` 下单路径必须保持关闭，除非明确停用 `copy-worker` 下单路径以避免双下单。

### 排障时可选

- Go `copy/`：按需开启 `POLYGON_DIAG_STATS=1` 等（见 `copy/polymarket/service.go` 顶部环境变量说明）。

说明：

- `.env.example` 里已经有大部分变量，但 `REDIS_URL` 需要你在服务器 `.env` 里明确补上

## 5. 测试服初始化步骤

以下以 Linux 服务器为例。

### 5.1 安装 Node.js、PM2、Redis

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs redis-server
sudo npm install -g pm2
```

确认版本：

```bash
node -v
npm -v
pm2 -v
redis-cli ping
```

如果返回 `PONG`，说明 Redis 正常。

### 5.2 准备目录

```bash
sudo mkdir -p /www/wwwroot/polycopy-backend
sudo chown -R $USER:$USER /www/wwwroot/polycopy-backend
cd /www/wwwroot/polycopy-backend
```

## 6. 推荐部署方式

当前仓库已经有测试服部署脚本：

- `polymarket-backend/scripts/deploy-test.ps1`
- `polymarket-backend/scripts/deploy-test.sh`

它会做这些事情：

1. 本地执行 `npm run build:deploy`
2. 生成 `deploy/` 发布目录
3. 打包上传到服务器
4. 远端执行 `npm install --omit=dev`
5. 可选执行 `npm run migrate:deploy`
6. 执行 PM2 重启命令

### 6.1 先在本地构建发布包

在 `polymarket-backend` 目录执行：

```bash
npm install
npm run build:deploy
```

### 6.2 使用现有脚本部署 API

Windows PowerShell：

```powershell
cd polymarket-backend
$env:DEPLOY_SSH_HOST="your-user@your-server"
$env:DEPLOY_REMOTE_APP_DIR="/www/wwwroot/polycopy-backend/current"
$env:DEPLOY_RUN_MIGRATE="1"
npm run deploy:test
```

说明：

- 现有 `deploy-test` 脚本默认只处理 `backend`
- 如需自定义，仍可通过 `DEPLOY_REMOTE_RESTART_CMD` 覆盖默认行为

## 7. 服务器上实际要做的事

部署包上传并解压后，进入发布目录，例如：

```bash
cd /www/wwwroot/polycopy-backend/current
```

### 7.1 创建 `.env`

```bash
cp .env.example .env
vim .env
```

至少确认这些值已填对：

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `API_KEY`
- `CUSTODY_ENCRYPT_KEY`
- `RPC_URL`
- `PRIVATE_KEY`

### 7.2 安装运行时依赖

```bash
npm install --omit=dev
```

### 7.3 执行数据库迁移

```bash
npm run migrate:deploy
```

### 7.4 手工验证进程能否启动

先分别跑一下，确认没报错。

API：

```bash
node dist/src/server.js
```

worker：

```bash
node dist/src/entry/copyWorker.js
```

如果都能启动，再交给 PM2 托管。

## 8. 用 PM2 正式托管

### 8.1 最简单的启动方式

在发布目录执行：

```bash
pm2 start dist/src/server.js --name backend
pm2 start dist/src/entry/copyWorker.js --name copy-worker
pm2 save
pm2 startup
```

查看状态：

```bash
pm2 status
pm2 logs backend
pm2 logs copy-worker
```

### 8.2 更推荐：使用 ecosystem 文件

可以在服务器发布目录创建 `ecosystem.config.cjs`：

```js
module.exports = {
  apps: [
    {
      name: 'backend',
      script: 'dist/src/server.js',
      cwd: '/www/wwwroot/polycopy-backend/current',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'copy-worker',
      script: 'dist/src/entry/copyWorker.js',
      cwd: '/www/wwwroot/polycopy-backend/current',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

然后启动：

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## 9. 建议的发布流程

每次发版建议按这个顺序：

1. 本地 `npm run build:deploy`
2. 上传 `deploy/`
3. 服务器更新 `.env`
4. `npm install --omit=dev`
5. `npm run migrate:deploy`
6. `pm2 restart backend`
7. `pm2 restart copy-worker`
9. 检查日志和健康检查

## 10. 上线后怎么验收

### API 验收

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/health
```

预期应返回成功状态。

### 链上监听验收（Go copy 服务）

链上监听已交由仓库根目录 `copy/` 进程负责。验收点改为：

- Go 进程日志有 `connected to polygon websocket` / `pending subscribe status`
- Go 进程日志有 `synced backend watch-list`，或 watch-list API 短暂失败时出现 `keeping previous watch set`
- NATS 上能看到 subject `polymarket.orders.watched` 持续有消息
- 服务器是否能出网
- RPC 提供商是否允许 WebSocket

### worker 验收

看日志是否出现：

- `dispatch workers started`
- job failed / stalled 是否大量出现

如果 worker 没有处理任务，重点检查：

- `REDIS_URL` 是否正确
- Redis 是否启动
- 上游信号是否真的触发了 backend 的跟单逻辑（例如有 leaderTrade / dispatch 入队）

## 11. 常见问题

### 1. 为什么说 websocket 不需要单独开放端口

因为链上监听（`copy/` Go 服务）是 WebSocket 客户端，不是 WebSocket 服务器。

也就是说：

- 服务器主动连接外部 Polygon WebSocket
- 用户浏览器不会直接连你的链上监听进程
- 所以不需要 Nginx 专门转发一个 WS 服务给公网

### 2. 为什么 worker 一定要配 Redis

因为 `copy-worker` 使用的是 BullMQ，BullMQ 底层依赖 Redis。没有 Redis，worker 无法消费任务。

### 3. 只启动 backend 行不行

不行。

只启动 `backend` 的结果是：

- API 能访问
- 但链上事件不会被消费进后端跟单链路
- 跟单任务不会执行

测试服要完整验证跟单链路，至少要同时启动：

- `backend`
- `copy-worker`
- `copy/`（Go）链上监听进程（发布 NATS）
- `apps/copytrade-messaging` 的 `polymarket-nats-ingestor`（消费 NATS 并调用 backend internal leader-signal）

### 4. 为什么 NATS 和 BullMQ 都要跑

NATS 是链上信号输入通道：Go `copy/` 发布 watched order，`polymarket-nats-ingestor` 消费后调用 backend internal `leader-signal`。

BullMQ / Redis / `copy-worker` 是按订阅执行通道：backend 创建 `LeaderTrade` 后入队，`copy-worker` 再按 enabled subscription 生成并执行 follower 跟单。

缺少 Redis、BullMQ 或 `copy-worker` 时，即使 NATS 有消息，也只能说明信号进入系统，不能说明跟单已执行。

### 5. 为什么 executor-service 默认不能下单

Polymarket copy-trading 生产主路径已经由 backend `copy-worker` 按 follower subscription 下单。若同时开启 `executor-service` 对 `copytrade.signal.detected.v1` 的下单逻辑，同一信号可能被执行两次。

因此生产配置必须保持：

```env
COPYTRADE_EXECUTOR_ORDER_ENABLED=false
```

## 12. 最终最小可执行清单

如果你现在要直接上测试服，服务器上最少要做这些事：

1. 安装 `node`、`pm2`、`redis`
2. 准备数据库并确认 `DATABASE_URL` 可连
3. 在服务器发布目录写好 `.env`
4. 确认 `.env` 里有 `REDIS_URL`、`RPC_URL`
5. 执行 `npm install --omit=dev`
6. 执行 `npm run migrate:deploy`
7. 用 PM2 启动 `backend`
8. 用 PM2 启动 `copy-worker`
9. 单独启动 `copy/`（Go）链上监听进程
10. 启动 `apps/copytrade-messaging` 的 `polymarket-nats-ingestor`
11. 检查 `/health`、PM2 状态与 `backend` / `copy-worker` 日志（另查 Go `copy/` 监听日志）

## 13. 一套可直接复制的命令

假设你的发布目录是 `/www/wwwroot/polycopy-backend/current`：

```bash
cd /www/wwwroot/polycopy-backend/current
cp .env.example .env
vim .env

npm install --omit=dev
npm run migrate:deploy

pm2 start dist/src/server.js --name backend
pm2 start dist/src/entry/copyWorker.js --name copy-worker

pm2 save
pm2 status
pm2 logs backend
pm2 logs copy-worker
```
