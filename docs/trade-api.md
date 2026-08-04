# 交易 API 文档（Polymarket CLOB）

本文档描述通过 Polymarket CLOB 下单、撤单、查询订单与成交的接口。所有接口需在请求头携带 `x-api-key`。

基础路径：`/api/trade`。链：Polygon (Chain ID 137)。

**通用响应格式**：成功 `{ "code": 0, "data": <业务数据> }`，失败 `{ "code": <非零>, "data": { "message": "...", ... } }`。业务码 0=成功，40001=参数错误，40101=未授权，50001=服务器错误。

**tokenID 来源**：`tokenID` 需从市场的 `clobTokenIds` 中取得。可通过 **GET /api/markets** 获取市场列表，每个市场对象包含 `clobTokenIds`（格式多为 `"tokenId1,tokenId2"`，对应 Yes/No 等 outcome），选好市场与 outcome 后取对应 token ID 用于下单。也可从 Gamma 单市场接口返回字段获取。

**tickSize / negRisk**：下单时需与市场一致。可从 Gamma 市场数据或 CLOB 的 getTickSize/getNegRisk 获取；若调用方已从市场对象传入，可直接使用以减少请求。

---

## 1. 下单（限价单）

**POST** `/api/trade/orders`

**请求头**：`x-api-key: <API_KEY>`

**请求体 (JSON)**

| 字段       | 类型    | 必填 | 说明 |
|------------|---------|------|------|
| tokenID    | string  | 是   | 来自市场 clobTokenIds 的 token ID |
| price      | number  | 是   | 限价，0–1 |
| size        | number  | 是   | 数量（股数） |
| side       | string  | 是   | `BUY` 或 `SELL` |
| tickSize   | string  | 否   | 可选，`"0.1"` \| `"0.01"` \| `"0.001"` \| `"0.0001"` |
| negRisk    | boolean | 否   | 多结果市场为 true |
| orderType  | string  | 否   | 默认 `GTC`，可选 `GTD` |

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "orderID": "0x...",
    "status": "...",
    "success": true,
    "transactionsHashes": [],
    "takingAmount": "...",
    "makingAmount": "..."
  }
}
```

**失败**：**400** 参数错误或 CLOB 拒单（如 `INVALID_ORDER_MIN_TICK_SIZE`、`INVALID_ORDER_NOT_ENOUGH_BALANCE`）时返回 `{ "code": 40001, "data": { "message": "...", "orderID": "..." } }`；**500** 服务器错误。

---

## 2. 撤单

**DELETE** `/api/trade/orders/:orderId`

**请求头**：`x-api-key: <API_KEY>`

**路径参数**：`orderId` — 订单 ID（如创建订单返回的 orderID）。

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "canceled": ["0x..."],
    "not_canceled": {}
  }
}
```

**失败**：**500** 服务器错误。

---

## 3. 开放订单列表

**GET** `/api/trade/orders`

**请求头**：`x-api-key: <API_KEY>`

**Query 参数**（均可选）：`market`（condition ID）、`asset_id`（token ID）。

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "orders": [
      {
        "id": "0x...",
        "status": "...",
        "maker_address": "0x...",
        "market": "...",
        "asset_id": "...",
        "side": "BUY",
        "original_size": "...",
        "size_matched": "...",
        "price": "...",
        "created_at": 1234567890,
        "order_type": "GTC"
      }
    ]
  }
}
```

---

## 4. 成交记录

**GET** `/api/trade/trades`

**请求头**：`x-api-key: <API_KEY>`

**Query 参数**（均可选）：`market`、`asset_id`、`before`、`after`（分页/时间）。

**成功 (200)**

```json
{
  "code": 0,
  "data": {
    "trades": [
      {
        "id": "...",
        "taker_order_id": "...",
        "market": "...",
        "asset_id": "...",
        "side": "BUY",
        "size": "...",
        "price": "...",
        "status": "...",
        "match_time": "...",
        "trader_side": "TAKER"
      }
    ]
  }
}
```

---

## 5. 用户维度（USER_EOA + JWT）

以下接口查询/撤单的是 **当前登录用户已绑定私钥的 USER_EOA** 在 Polymarket 上的数据，**不是** 服务端 `PRIVATE_KEY` 对应账户。需同时携带：

- `x-api-key: <API_KEY>`
- `Authorization: Bearer <JWT>`

**可选 Query `address`**：`0x` + 40 位十六进制，且须为该用户已绑定的 USER_EOA；不传则使用主绑定地址（与 custody 一致）。

### 5.1 用户开放订单

**GET** `/api/trade/user/orders`

**Query**（均可选）：`market`（condition ID）、`asset_id`（token ID）、`address`。

响应体与 **§3 开放订单列表** 相同：`{ "orders": [ ... ] }`。

### 5.2 用户成交记录

**GET** `/api/trade/user/trades`

**Query**（均可选）：`market`、`asset_id`、`before`、`after`、`address`。

响应体与 **§4 成交记录** 相同：`{ "trades": [ ... ] }`。

### 5.3 用户撤单

**DELETE** `/api/trade/user/orders/:orderId`

**路径参数**：`orderId` — 订单 ID。

**Query**（可选）：`address`。

响应体与 **§2 撤单** 相同：`{ "canceled": [...], "not_canceled": {} }`。

### 5.4 用户下单（已有）

**POST** `/api/trade/user/orders` — 见产品说明；**卖出（SELL）** 前服务端会对该 `tokenID` 调用 CLOB 的 conditional **balance/allowance 同步**（`updateBalanceAllowance`），仍须钱包内持有足够 outcome 代币份额，否则可能返回 `INVALID_ORDER_NOT_ENOUGH_BALANCE`。

### 5.5 持仓、活跃平仓与已结束赎回

- **GET** `/api/trade/user/positions` — Data API 持仓 + `category`（活跃 vs 可链上 redeem）。
- **POST** `/api/trade/user/redeem` — 单笔 CTF `redeemPositions`（已结束可赎回份额），与 CLOB **无关**。

详见 **[positions-redeem.md](./positions-redeem.md)**（活跃市场用 CLOB SELL，已结束用链上 redeem）。

---

## 常见错误与说明

- **INVALID_ORDER_MIN_TICK_SIZE**：价格未按市场 tickSize 取整。
- **INVALID_ORDER_NOT_ENOUGH_BALANCE**：余额不足（买入需 USDC.e，卖出需对应 outcome 代币）。
- **INVALID_SIGNATURE**：私钥与 POLY_* 凭证不匹配，或未对 Polymarket Exchange 合约做 allowance（通常需在 Polymarket 前端授权一次）。

交易前请确保 funder 地址有足够 USDC.e（买入）或对应 outcome 代币（卖出），且已对 Polymarket Exchange 做过 allowance。长期挂单时，若需避免约 10 秒无心跳被撤单，需在服务内约每 5 秒调用 CLOB 的 heartbeat（当前实现未默认开启，可后续扩展）。
