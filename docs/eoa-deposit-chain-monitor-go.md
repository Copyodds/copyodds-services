# Go chain_monitor：Custodial EOA 监听实现说明

wallet 子模块需扩展 `chain_monitor`，与现有 funder 监听并行。Node 端已实现：

- `GET /api/internal/custody/eoa-watch-list`
- `POST /api/internal/custody/eoa-deposit-detected`

## 配置项（cfg.wallet.toml）

```toml
[chain_monitor]
enabled = true
# 现有 funder
watch_list_url = "http://127.0.0.1:3000/api/internal/custody/funder-watch-list"
node_callback_url = "http://127.0.0.1:3000/api/internal/custody/funder-deposit-detected"
# 新增 EOA
eoa_watch_list_url = "http://127.0.0.1:3000/api/internal/custody/eoa-watch-list"
eoa_node_callback_url = "http://127.0.0.1:3000/api/internal/custody/eoa-deposit-detected"
watch_list_poll_interval_sec = 60
```

## watch-list 响应

```json
{
  "items": [
    {
      "userId": 123,
      "custodialAddress": "0x...",
      "funderAddress": "0x...",
      "walletIndex": 42
    }
  ],
  "count": 1
}
```

## 监测逻辑

对每个 `custodialAddress`（非 funder）：

1. 订阅 Polygon 上 USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` 与 native USDC `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` 的 `Transfer` 事件，`to` = custodialAddress
2. 检测到新 log 后 POST `eoa-deposit-detected`：

```json
{
  "userId": 123,
  "funderAddress": "0x...",
  "custodialAddress": "0x...",
  "txHash": "0x...",
  "logIndex": 42,
  "blockNumber": 61234567,
  "fromAddress": "0x...",
  "amountRaw": "1000000",
  "tokenAddress": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "usdcVariant": "usdce",
  "source": "go_chain_monitor"
}
```

3. Header：`X-Internal-Secret: <COPY_INTERNAL_SECRET>`
4. 幂等：Node 对 duplicate 返回 200

## 与 funder 监听的差异

| | funder | custodial EOA |
|---|--------|----------------|
| 监测地址 | `funderAddress` | `custodialAddress` |
| Node 入账 | `POLYMARKET_FUNDER_CHAIN_DEPOSIT` | `CHAIN_DEPOSIT` |
| 后续 | 直接 wrap | EOA→funder 划转再 wrap |

实现时可复用 funder 扫块代码，仅替换 watch list URL、callback URL 与 indexed `to` 地址字段。
