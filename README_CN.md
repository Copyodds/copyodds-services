<div align="center">

[English](README.md) · 简体中文 · [日本語](README_JA.md) · [한국어](README_KO.md) · [Português do Brasil](README_PT-BR.md)

# Polymarket Agent Backend

**面向 Polymarket 的跟单交易、聪明钱发现与托管钱包 API 后端。**

生产级 Node.js 服务，涵盖用户认证、跟单执行、聪明钱排行榜、托管充值与管理后台 —— 基于 Polymarket CLOB 与 Polygon 链上结算。

[官网入口](https://app.copyodds.io/) - 点击立即体验 CopyOdds。

[Telegram 机器人](https://t.me/copyodds_bot) - 打开 `@copyodds_bot` 查看钱包动态、持仓信息与 CopyOdds 支持。

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Prisma-4169E1?logo=postgresql&logoColor=white)](https://www.prisma.io/)
[![Polymarket](https://img.shields.io/badge/Polymarket-CLOB-6366F1)](https://polymarket.com/)
[![Polygon](https://img.shields.io/badge/Polygon-137-8247E5?logo=polygon&logoColor=white)](https://polygon.technology/)

</div>

---

## 功能模块

| 模块 | 说明 |
|------|------|
| **跟单交易** | 订阅 Leader、自动派单、重试与资金预检、盈亏账本 |
| **聪明钱** | 排行榜评分、交易员画像、跟单池准入、按需分析 |
| **托管钱包** | EOA 充值转发、Polymarket 充值、Go 钱包远程签名 |
| **虚拟跟单** | 模拟盘交易，含订单簿撮合与结算 |
| **认证与安全** | JWT 会话、Passkey、TOTP 二次验证、SSRF 防护 |
| **管理后台** | 仪表盘定时任务、风控、联盟等级、Gas 套餐 |

## 信任与安全

本仓库面向重视稳定性、风险控制与负责任部署的团队设计。

- **安全优先的默认设计：** JWT 会话、Passkey、敏感操作 TOTP 二次验证、SSRF 防护、请求体大小限制、内部接口密钥校验、结构化日志脱敏。
- **资金与交易风控：** 资金预检、重试边界、跟单准入与风控门禁、结算/赎回保护、审计事件与后台可视化。
- **运维透明度：** Prisma 迁移、健康检查、API/Worker 分离、指标监控、生产上线清单与接口文档。
- **部署责任清晰：** 生产运营方应使用高强度密钥、隔离钱包服务、限制后台访问、配置监控与备份，并完成所在地合规审查。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 填写 DATABASE_URL、JWT_SECRET、API_KEY、RPC_URL 等

# 3. 生成 Prisma Client 并执行迁移
npx prisma migrate dev

# 4. 启动开发服务器（热重载）
npm run dev
```

默认 API 地址为 `http://localhost:3000`（可通过 `PORT` 修改）。

## 环境变量

完整模板见 [`.env.example`](.env.example)。生产环境必填项：

| 变量 | 用途 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接串 |
| `JWT_SECRET` | JWT 签名密钥（建议 32+ 位随机字符串） |
| `API_KEY` | 服务端共享 API Key |
| `CUSTODY_ENCRYPT_KEY` | 托管钱包加密密钥（≥ 32 字符） |
| `RPC_URL` | Polygon RPC 节点 |

> **切勿将 `.env` 提交到 Git。** 仅以 `.env.example` 作为模板。

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式（热重载） |
| `npm run build` | 编译 TypeScript + Prisma generate |
| `npm run start` | 生产启动（需先 build） |
| `npm run start:copy-worker` | 跟单派发 Worker |
| `npm run start:smart-money-worker` | 聪明钱定时 Worker |
| `npm run seed:admin:dev` | 创建管理后台账号（开发） |
| `npm test` | 运行测试套件 |

## 部署

```bash
npm run build:deploy   # 生成 deploy/ 目录
```

将 `deploy/` 上传到服务器，复制 `.env.example` → `.env`，执行 `npm install --omit=dev`，然后 `npm start`。

详见 [deploy/README.md](deploy/README.md) 与 [docs/production-launch-checklist.md](docs/production-launch-checklist.md)。

## 文档

| 文档 | 主题 |
|------|------|
| [auth-api.md](docs/auth-api.md) | 认证与会话 |
| [trade-api.md](docs/trade-api.md) | 交易接口 |
| [wallet-api.md](docs/wallet-api.md) | 钱包与托管 |
| [smart-money-api.md](docs/smart-money-api.md) | 聪明钱排行榜 |
| [go-wallet-thin.md](docs/go-wallet-thin.md) | Go 钱包集成 |
| [error-codes.md](docs/error-codes.md) | API 错误码 |

## 架构

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  前端       │────▶│  Express API     │────▶│  PostgreSQL │
│  (Next.js)  │     │  (本仓库)        │     │  + Prisma   │
└─────────────┘     └────────┬─────────┘     └─────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────────┐
        │  NATS    │  │ Go Wallet│  │ Polymarket   │
        │  (跟单)  │  │  (签名)  │  │ CLOB + 链上  │
        └──────────┘  └──────────┘  └──────────────┘
```

## 技术栈

- **运行时：** Node.js 20+、TypeScript 5
- **框架：** Express 5、Zod 校验
- **数据库：** PostgreSQL + Prisma 7
- **区块链：** ethers.js、viem、Polygon（chain 137）
- **消息队列：** NATS（跟单机器人控制）
- **可观测性：** pino 日志、prom-client 指标

## 免责声明与负责任使用

本软件按「**现状**」提供，不作任何明示或暗示的保证。本仓库仅用于工程评审、教育、研究与经授权的部署。

**独立项目。** 本项目为独立第三方项目，与 Polymarket、Polygon 或其关联方无任何隶属、背书、赞助或官方合作关系。相关商标归各自权利人所有，仅用于描述或互操作说明。

**非投资建议。** 本仓库内容不构成任何投资、交易、法律、税务或财务建议。预测市场与加密资产活动存在重大风险，包括本金全部亏损的可能。

**合规责任由使用方承担。** 任何使用、托管、跟单交易、自动执行、托管钱包运营或相关活动，均需由使用方自行确认其在服务用户所在司法辖区内合法合规。若当地法律限制或禁止相关活动，请勿使用或对外提供本软件。

**安全责任由部署方承担。** 生产运营方需自行负责私钥、托管加密密钥、API 密钥、钱包基础设施、数据库访问、监控、应急响应、备份、后台权限控制，以及适用的反洗钱/KYC、制裁、证券、博彩与税务等合规要求。

**责任限制。** 作者与贡献者不对因使用、修改、部署或依赖本软件导致的资金、数据、利润、商业机会、声誉损失，或任何直接/间接损害及监管后果承担责任。

使用本仓库即表示您已了解上述风险，并同意仅在完成授权、安全审查与法律/合规审查后进行部署。
