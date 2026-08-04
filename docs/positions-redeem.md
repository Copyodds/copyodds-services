# 持仓、平仓与赎回（活跃 vs 已结束）

Polymarket 上「把仓位变成 USDC」有两条完全不同的路径：

| 场景 | 机制 | 本仓库接口 |
|------|------|------------|
| **活跃市场** 持有 outcome 代币 | 在 **CLOB** 下 **SELL** 限价单，与对手成交后得到 USDC | [`POST /api/trade/user/orders`](trade-api.md) `side: SELL`；前端「填入平仓」预填 tokenID / 数量 |
| **已结束且已结算** 可赎回份额 | **链上** 调用 CTF `redeemPositions`，将赢面条件代币换成 USDC.e（**不是** CLOB 挂单） | [`POST /api/trade/user/redeem`](#用户手动赎回)；定时任务见下文 |

## 持仓列表

**GET** `/api/trade/user/positions`

- 鉴权：与 [`trade-api.md`](trade-api.md) 用户接口相同（`x-api-key` + `Authorization: Bearer`）。
- 可选 Query：`address`（已绑定 USER_EOA）。
- 数据来源：[Polymarket Data API](https://docs.polymarket.com/api-reference/core/get-current-positions-for-a-user) `GET /positions`。
- 响应字段 `positions[]` 含 `category`：
  - `active_manual_close`：活跃仓位，请用 CLOB **SELL** 平仓。
  - `resolved_redeemable`：Data API 标记 `redeemable`，可走链上 redeem。
- 若该 token 有跟单 lot，额外返回 `openLotCount` 与 `copyLots[]`（含 `leaderAddress` / `subscriptionId` / `leaderId` 等跟单来源字段）。按需也可单独调 `GET /api/trade/user/positions/copy-lots?tokenID=`。

## 用户手动赎回

**POST** `/api/trade/user/redeem`

请求体 JSON：

| 字段 | 类型 | 说明 |
|------|------|------|
| conditionId | string | 市场 condition ID（0x + 64 hex） |
| outcomeIndex | number | 与 Data API 仓位 `outcomeIndex` 一致 |
| address | string | 可选，指定绑定 USER_EOA |

成功返回 `{ "txHash": "0x..." }`；若已赎回过（幂等）返回 `{ "skipped": true, "reason": "already_redeemed" }`。

链上合约：Polygon 上 Conditional Tokens（CTF）`0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`，抵押 USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`。详见 [Polymarket CTF Redeem 文档](https://docs.polymarket.com/developers/CTF/redeem)。

**说明**：部分 **neg-risk** 或多结果市场的赎回路径可能与标准二元市场不同；若交易失败，请查看链上 revert 原因或 Polymarket 官方文档。

## 自动 redeem 定时任务

环境变量：

- `REDEEM_CRON_ENABLED=true`：进程启动后按间隔扫描所有「已绑定托管私钥」的 `USER_EOA`，对 Data API 中 `redeemable=true` 且有余额的仓位尝试 `redeemPositions`。
- `REDEEM_INTERVAL_MS`：间隔毫秒，默认 `900000`（15 分钟）。

幂等：表 `PolymarketRedeemLog` 按 `(userId, conditionId)` 去重，避免重复发交易。

Gas：与 BUY/SELL 一致，默认由 **Polymarket Builder Relayer** 在 **deposit wallet** 上代发 `redeemPositions`，**不需要**托管操作地址（custodial EOA）持有 MATIC。需配置 `POLYMARKET_BUILDER_*` 与 `POLYMARKET_RELAYER_URL`。

仅当 deposit 与 custodial 为同一地址且未配置 relayer 时，才回退为 custodial EOA 直连链上赎回（此时该地址需有 MATIC）。
