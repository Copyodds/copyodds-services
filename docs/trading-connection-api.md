# 交易连接 API 文档

本文档描述交易连接（Trading Connection）相关接口的实现说明及前端对接方式。

**通用响应格式**：成功 `{ "code": 0, "data": <业务数据> }`，失败 `{ "code": <非零>, "data": { "message": "...", ... } }`。业务码 0=成功，40001=参数错误，40101=未授权，40401=不存在，50001=服务器错误。

---

## 1. 实现概述

### 1.1 功能说明

- **交易连接管理**：对「钱包地址 ↔ 连接状态」进行增删查，用于记录用户绑定的交易钱包。
- **EVM 地址校验**：创建连接时校验 `walletAddress` 为合法 EVM 地址（`0x` + 40 位十六进制）。
- **安全**：所有接口需在请求头携带 `x-api-key`，与现有敏感 API 一致。

### 1.2 数据库

**TradingConnection 表**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String (UUID, PK) | 主键，由 Prisma 默认生成 |
| `walletAddress` | String | 钱包地址（EVM 格式） |
| `status` | String | 连接状态，默认 `"connected"` |
| `createdAt` | DateTime | 创建时间 |

### 1.3 路由与权限

- 基础路径：`/api/trading-connections`
- 认证：所有请求需带请求头 `x-api-key: <API_KEY>`（与 `/api/wallet`、`/api/markets` 等一致）
- 未配置 `API_KEY` 时本地会跳过校验（仅开发用）

---

## 2. 接口说明

### 2.1 获取交易连接列表

**GET** `/api/trading-connections`

**请求头**

| 名称 | 必填 | 说明 |
|------|------|------|
| `x-api-key` | 是 | 后端配置的 API Key |
| `Content-Type` | 否 | 建议 `application/json` |

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "connections": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "walletAddress": "0x1234567890123456789012345678901234567890",
        "status": "connected",
        "createdAt": "2026-03-14T06:20:00.000Z"
      }
    ]
  }
}
```

`connections` 按 `createdAt` 倒序（最新在前）。

---

### 2.2 创建交易连接

**POST** `/api/trading-connections`

**请求头**

| 名称 | 必填 | 说明 |
|------|------|------|
| `x-api-key` | 是 | API Key |
| `Content-Type` | 是 | `application/json` |

**Request Body (JSON)**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `walletAddress` | string | 是 | EVM 地址：`0x` + 40 位十六进制（大小写均可） |

**成功 (201)**

```json
{
  "code": 0,
  "data": {
    "connection": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "walletAddress": "0x1234567890123456789012345678901234567890",
      "status": "connected",
      "createdAt": "2026-03-14T06:20:00.000Z"
    }
  }
}
```

**失败**

- **400** 参数缺失或格式错误：`{ "code": 40001, "data": { "message": "Validation failed", "details": { ... } } }`
- **401** 未传或错误的 API Key：`{ "code": 40101, "data": { "message": "Unauthorized" } }`
- **500** 服务器错误：`{ "code": 50001, "data": { "message": "..." } }`

**EVM 地址校验规则**：正则 `/^0x[a-fA-F0-9]{40}$/`，即必须以 `0x` 开头且后跟 40 个十六进制字符。

---

### 2.3 删除交易连接

**DELETE** `/api/trading-connections/:id`

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 交易连接的 UUID |

**成功 (200)**

```json
{ "code": 0, "data": { "message": "Trading connection removed" } }
```

**失败**

- **404** 连接不存在：`{ "code": 40401, "data": { "message": "Trading connection not found" } }`
- **401** 未授权：`{ "code": 40101, "data": { "message": "Unauthorized" } }`

---

## 3. 前端对接指南

### 3.1 基础配置

- **Base URL**：与现有后端一致，例如 `https://your-api.com` 或开发环境 `http://localhost:PORT`。
- **API Key**：从环境变量或配置中读取，不要写死在前端代码里；生产环境建议通过后端代理或 BFF 转发，由服务端带 `x-api-key`。

### 3.2 请求示例

**获取列表（GET）**

```javascript
const response = await fetch(`${API_BASE}/api/trading-connections`, {
  method: 'GET',
  headers: {
    'x-api-key': API_KEY,
    'Content-Type': 'application/json',
  },
});
const { code, data } = await response.json();
const connections = code === 0 ? data.connections : [];
```

**创建连接（POST）**

```javascript
const response = await fetch(`${API_BASE}/api/trading-connections`, {
  method: 'POST',
  headers: {
    'x-api-key': API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    walletAddress: '0x1234567890123456789012345678901234567890',
  }),
});
const { code, data } = await response.json();
if (code === 0) {
  const { connection } = data;
  // 使用 connection.id, connection.walletAddress 等
} else {
  // 展示 data.message 或 data.details
}
```

**删除连接（DELETE）**

```javascript
const id = '550e8400-e29b-41d4-a716-446655440000';
const response = await fetch(`${API_BASE}/api/trading-connections/${id}`, {
  method: 'DELETE',
  headers: { 'x-api-key': API_KEY },
});
const { code, data } = await response.json();
if (code === 0) {
  // 删除成功，可刷新列表或从本地状态移除
} else {
  // data.message === 'Trading connection not found' 等
}
```

### 3.3 前端校验建议

- 在提交前用相同规则校验 EVM 地址：`/^0x[a-fA-F0-9]{40}$/`，减少无效请求。
- 可选：将用户输入转为校验和格式（EIP-55）再展示，提交时仍可用后端接受的任意大小写 0x+40 位十六进制。

### 3.4 错误处理

- **401**：提示未授权或 API Key 无效（`code === 40101`，`data.message`）。
- **400**：展示 `data.message` 或 `data.details`（如 `walletAddress` 的报错）。
- **404**（DELETE）：`code === 40401`，提示「该连接不存在或已被删除」。
- **500**：`code === 50001`，提示服务器错误，可重试或联系支持。

### 3.5 与钱包余额接口的关系

- 交易连接仅做「绑定记录」的增删查；不涉及余额或转账。
- 查询某地址余额仍使用：**GET** `/api/wallet/balance/:address`（需相同 `x-api-key`）。  
  例如：`GET /api/wallet/balance/0x1234...7890`，返回 `{ address, balanceWei, balanceEther }`。
