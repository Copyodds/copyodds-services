# 钱包 API 文档

本文档描述钱包相关接口：原生余额、可用于 Polymarket 交易的资产（MATIC + USDC.e）。**所有**接口需在请求头携带 `x-api-key`。其中「推广 / Gas 账户」相关接口（汇总、下属列表、平台 Gas 充值）**另需**登录用户 JWT，见下文各节。

基础路径：`/api/wallet`。链：Polygon (Chain ID 137)。

**通用响应格式**：成功 `{ "code": 0, "data": <业务数据> }`，失败 `{ "code": <非零>, "data": { "message": "...", ... } }`。业务码 0=成功，40001=参数错误，40101=未授权，50001=服务器错误。

---

## 1. 原生余额

**GET** `/api/wallet/balance/:address`

**请求头**：`x-api-key: <API_KEY>`

**路径参数**：`address` — EVM 地址（`0x` + 40 位十六进制）。

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "address": "0x...",
    "balanceWei": "...",
    "balanceEther": "..."
  }
}
```

**失败**：**400** `{ "code": 40001, "data": { "message": "Invalid address", "details": [...] } }`；**500** `{ "code": 50001, "data": { "message": "..." } }`。

---

## 2. 钱包可用资产（Polymarket 交易用）

**GET** `/api/wallet/assets/:address`

用于 copy trading 等场景：返回该地址在 Polygon 上的 **MATIC**（燃气）与 **USDC.e**（Polymarket 交易 collateral）余额。

**请求头**：`x-api-key: <API_KEY>`

**路径参数**：`address` — EVM 地址（`0x` + 40 位十六进制）。

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "address": "0x...",
    "native": {
      "symbol": "MATIC",
      "balanceWei": "...",
      "balanceEther": "..."
    },
    "usdc": {
      "symbol": "USDC.e",
      "balanceRaw": "...",
      "balanceFormatted": "..."
    }
  }
}
```

- `balanceRaw`：USDC.e 最小单位（6 位小数）的原始值。
- `balanceFormatted`：已按 6 位小数格式化后的字符串，可直接用于前端展示。

**失败**

- **400** `{ "code": 40001, "data": { "message": "Invalid address", "details": [...] } }`
- **401** `{ "code": 40101, "data": { "message": "Unauthorized" } }`
- **500** `{ "code": 50001, "data": { "message": "..." } }`

**说明**：USDC.e 合约为 Polygon 上的 Bridged USDC（`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`），为 Polymarket 当前使用的 collateral。前端可对每个已绑定钱包调用本接口，展示「可用于 Polymarket 交易的资产」并做风控（如仅当 USDC.e 大于某阈值时允许跟单）。

---

## 3. 查看推广 & Gas 汇总（需 JWT）

**GET** `/api/wallet/gas/referral-summary`

返回**当前登录用户**（由 JWT 解析）在平台内的 Gas 推广汇总：当前平台 Gas 余额、累计推广分佣、直推人数等。不可通过路径指定他人 `userId`。

**请求头**：

- `x-api-key: <API_KEY>`
- `Authorization: Bearer <JWT>`（与 `/api/auth/login` 等签发的用户会话 token 一致；服务端校验会话未过期）

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "userId": 1,
    "gasBalance": "120.0",
    "totalCommission": "40.0",
    "directReferrals": 15,
    "affiliateTier": 1
  }
}
```

- `gasBalance`：当前平台 Gas 余额（字符串，便于精度处理）。
- `totalCommission`：历史累计通过推广获得的 Gas 分佣总额（字符串）。
- `directReferrals`：直推用户数量（`referrerId = 当前用户 id` 的用户数，仅统计一级下级）。
- `affiliateTier`：推广档位（若无则为 `null`）。

**失败**

- **401** `{ "code": 40101, "data": { "message": "Unauthorized" } }` — 未带 `Authorization`、token 无效或会话已过期。
- **400** — 用户不存在等业务错误。
- **500** `{ "code": 50001, "data": { "message": "..." } }`

**说明**：

- `gasBalance` 与用户在平台侧的 Gas 账户余额保持一致，可用于前端展示「当前 Gas 余额」。
- `totalCommission` 可用于前端展示「推广累计佣金」，对应该用户通过邀请其他用户在平台产生的 Gas 分佣累计值。
- `directReferrals` 仅统计一级下级：注册时将 `referrerId` 设为当前用户 `userId` 的用户数。

---

## 4. 推广下属列表（需 JWT）

**GET** `/api/wallet/gas/downlines`

返回**当前登录用户**的一级下属列表及每人贡献佣金汇总。支持分页查询参数。

**请求头**：同第 3 节（`x-api-key` + `Authorization: Bearer <JWT>`）。

**查询参数（可选）**：

- `limit` — 条数，默认 `50`
- `offset` — 偏移，默认 `0`

**成功 (200)**：`data` 含 `userId`（当前用户）、`total`（本页条数）、`downlines`（数组）。

**失败**：**401** 含义同第 3 节。

---

## 5. 平台 Gas 充值（需 JWT）

**POST** `/api/wallet/gas/recharge`

为**当前登录用户**创建 Gas 充值订单（body 中不再传 `userId`，防止伪造他人身份）。

**请求头**：同第 3 节。

**请求体（JSON）**：

- `amountPaid`（必填）— 实付金额（正数）。
- `referrerId`（可选）— 首充时可传，用于绑定推荐人（业务规则见服务端 `bindReferrerIfNeeded`）。

**成功 (200)**：返回 `orderId` 与更新后的 `user`（含 `gasBalance`、`referrerId` 等）。

**失败**：**401** 未授权；**400** 参数或用户不存在等。
